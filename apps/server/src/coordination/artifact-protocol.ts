import type { z } from "zod";
import type {
  ArtifactProtocol,
  ArtifactValidationError,
  ArtifactValidationResult,
  Clock,
  IdGenerator,
} from "./contracts.js";
import {
  finalPayloadSchema,
  proposalPayloadSchema,
  reviewPayloadSchema,
  sessionMessagePayloadSchema,
  sessionPlanPayloadSchema,
  COORDINATION_ARTIFACT_SCHEMA_VERSION,
} from "./schemas.js";
import type {
  ArtifactPayload,
  ArtifactType,
  CoordinationArtifact,
  CoordinationAttempt,
  CoordinationRun,
  CoordinationTurn,
  CoordinationTurnKind,
  ProposalPayload,
  ReviewPayload,
  SessionPlanPayload,
} from "./types.js";

type VerifiedArtifactPayload = Exclude<
  ArtifactPayload,
  { type: "session_message" | "session_plan" | "user_message" }
>;

export type {
  ArtifactProtocol,
  ArtifactValidationError,
  ArtifactValidationResult,
} from "./contracts.js";

/**
 * Backend-owned mapping from turn kind to the artifact type that turn must
 * produce. An Agent cannot select or change the artifact type of its own turn.
 */
export const EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND: Readonly<
  Record<CoordinationTurnKind, ArtifactType>
> = {
  initial_proposal: "proposal",
  proposal_revision: "proposal",
  proposal_review: "review",
  finalization: "final",
  session_turn: "session_message",
  session_plan: "session_plan",
};

/**
 * Matches output whose *entire* trimmed body is wrapped in exactly one
 * ```json ... ``` or ``` ... ``` fence (ADR-05). Anything else -- prose around
 * the fence, a different info string, or a second fence -- is left untouched so
 * that `JSON.parse` rejects it. The parser never searches prose for an embedded
 * object.
 */
const OUTER_JSON_FENCE = /^```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```$/i;

const formatPath = (path: ReadonlyArray<PropertyKey>): string => {
  let formatted = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
    } else {
      const name = String(segment);
      formatted = formatted ? `${formatted}.${name}` : name;
    }
  }
  return formatted || "output";
};

const invalid = (
  errors: ArtifactValidationError[],
): ArtifactValidationResult => ({
  ok: false,
  code: "INVALID_AGENT_OUTPUT",
  errors,
});

const invalidAt = (
  path: string,
  code: string,
  message: string,
): ArtifactValidationResult => invalid([{ path, code, message }]);

const stripOuterFence = (trimmed: string): string => {
  const fenced = OUTER_JSON_FENCE.exec(trimmed);
  return fenced?.[1] ?? trimmed;
};

const parsePayload = (
  type: Exclude<ArtifactType, "session_message" | "session_plan" | "user_message">,
  value: unknown,
): { ok: true; payload: VerifiedArtifactPayload } | { ok: false; error: z.ZodError } => {
  const result =
    type === "proposal"
      ? proposalPayloadSchema.safeParse(value)
      : type === "review"
        ? reviewPayloadSchema.safeParse(value)
        : finalPayloadSchema.safeParse(value);

  return result.success
    ? { ok: true, payload: result.data }
    : { ok: false, error: result.error };
};

/**
 * Step 6 of the frozen parsing order (overview Section 11.4): deterministic
 * cross-field and coverage rules, applied only after the payload satisfies its
 * bounded schema.
 *
 * Rules are taken verbatim from the frozen artifact contract (overview Section
 * 7.1). Non-empty final title/content and non-empty review feedback are already
 * guaranteed by the trimmed, bounded schemas, so they are asserted by test
 * rather than re-checked here.
 *
 * Every value echoed into a message is backend-owned (a required section key)
 * or already schema-bounded (a parsed section key), so retry feedback stays
 * bounded and safe.
 */
const applyCrossFieldRules = (
  run: CoordinationRun,
  payload: ArtifactPayload,
): ArtifactValidationError[] => {
  if (payload.type === "proposal") {
    return proposalCoverageErrors(run, payload);
  }
  if (payload.type === "review") {
    return reviewConsistencyErrors(payload);
  }
  return [];
};

/**
 * Every required section key appears exactly once. Unknown keys are allowed,
 * duplicates never are, and the section `key` -- not its display title -- is the
 * stable coverage identifier.
 */
const proposalCoverageErrors = (
  run: CoordinationRun,
  payload: ProposalPayload,
): ArtifactValidationError[] => {
  const errors: ArtifactValidationError[] = [];
  const present = new Set<string>();
  const duplicates: ArtifactValidationError[] = [];

  payload.sections.forEach((section, index) => {
    if (present.has(section.key)) {
      duplicates.push({
        path: `sections[${index}].key`,
        code: "duplicate_section_key",
        message: `Section key "${section.key}" appears more than once`,
      });
      return;
    }
    present.add(section.key);
  });

  for (const required of run.requiredSections) {
    if (!present.has(required.key)) {
      errors.push({
        path: "sections",
        code: "missing_required_section",
        message: `Proposal is missing required section "${required.key}"`,
      });
    }
  }

  return [...errors, ...duplicates];
};

/**
 * A rejecting review carries at least one blocking issue; an approving review
 * carries none, and keeps any non-blocking remarks in `feedback`.
 */
const reviewConsistencyErrors = (
  payload: ReviewPayload,
): ArtifactValidationError[] => {
  if (payload.decision === "reject" && payload.issues.length === 0) {
    return [
      {
        path: "issues",
        code: "missing_review_issues",
        message: "A rejecting review must list at least one blocking issue",
      },
    ];
  }

  if (payload.decision === "approve" && payload.issues.length > 0) {
    return [
      {
        path: "issues",
        code: "unexpected_review_issues",
        message:
          "An approving review must not list blocking issues; put non-blocking remarks in feedback",
      },
    ];
  }

  return [];
};

export interface ArtifactProtocolDependencies {
  clock: Clock;
  ids: IdGenerator;
}

export class VerifiedHandoffArtifactProtocol implements ArtifactProtocol {
  constructor(private readonly dependencies: ArtifactProtocolDependencies) {}

  validate(input: {
    run: CoordinationRun;
    turn: CoordinationTurn;
    attempt: CoordinationAttempt;
    rawOutput: string;
  }): ArtifactValidationResult {
    const { run, turn, rawOutput } = input;

    // 1. Reject output exceeding outputMaxChars before parsing.
    if (rawOutput.length > run.policy.outputMaxChars) {
      return {
        ok: false,
        code: "OUTPUT_TOO_LARGE",
        errors: [
          {
            path: "output",
            code: "output_too_large",
            message: `Agent output exceeds the ${run.policy.outputMaxChars} character limit`,
          },
        ],
      };
    }

    // 2. Trim whitespace. 3. Remove at most one enclosing JSON code fence.
    const body = stripOuterFence(rawOutput.trim());

    // 4. JSON.parse() once. Never search surrounding prose for an object.
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return invalidAt(
        "output",
        "invalid_json",
        "Agent output is not a single JSON object",
      );
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return invalidAt(
        "output",
        "not_an_object",
        "Agent output must be one JSON object",
      );
    }

    // 5. Expected artifact type and schema version, then the bounded schema.
    const expectedType = EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND[turn.kind];
    if (expectedType === "session_message" || expectedType === "session_plan") {
      return invalidAt(
        "type",
        "unexpected_artifact_type",
        "Session turns must use the shared-session artifact protocol",
      );
    }
    if (expectedType === "user_message") {
      return invalidAt("type", "unexpected_artifact_type", "User messages cannot be Agent output");
    }
    const candidate = parsed as Record<string, unknown>;

    if (candidate["type"] !== expectedType) {
      return invalidAt(
        "type",
        "unexpected_artifact_type",
        `This turn must produce an artifact of type "${expectedType}"`,
      );
    }

    if (candidate["schemaVersion"] !== COORDINATION_ARTIFACT_SCHEMA_VERSION) {
      return invalidAt(
        "schemaVersion",
        "unsupported_schema_version",
        `Artifact schema version must be ${COORDINATION_ARTIFACT_SCHEMA_VERSION}`,
      );
    }

    const schemaResult = parsePayload(expectedType, candidate);
    if (!schemaResult.ok) {
      return invalid(
        schemaResult.error.issues.map((issue) => ({
          path: formatPath(issue.path),
          code: issue.code,
          message: issue.message,
        })),
      );
    }

    const { payload } = schemaResult;

    // 6. Deterministic cross-field rules over the parsed payload.
    const crossFieldErrors = applyCrossFieldRules(run, payload);
    if (crossFieldErrors.length > 0) {
      return invalid(crossFieldErrors);
    }

    // 7. Identity and provenance are constructed here, never read from the
    //    Agent. `sizeChars` records the raw output length that was measured
    //    against outputMaxChars, because only the parsed payload is stored.
    const provenance = {
      id: this.dependencies.ids.artifactId(),
      runId: run.id,
      turnId: turn.id,
      createdByRole: turn.role,
      createdByAgentId: turn.agentId,
      sizeChars: rawOutput.length,
      createdAt: this.dependencies.clock.nowIso(),
    };

    const artifact: CoordinationArtifact =
      payload.type === "proposal"
        ? { ...provenance, type: "proposal", payload }
        : payload.type === "review"
          ? { ...provenance, type: "review", payload }
          : { ...provenance, type: "final", payload };

    return { ok: true, artifact };
  }
}

/**
 * Step 6 of the frozen parsing order (overview Section 11.4) for a plan: purely
 * structural rules, applied only after the bounded schema has passed (P14-02).
 *
 * The middleware judges no substance. It never asks whether the plan is a
 * *good* plan -- whether the right Agent got the right job, or whether the
 * instructions make sense -- only whether it is a *well-formed, executable*
 * one. Everything checked here is a fact about this run's roster and the
 * assignment array's own shape.
 *
 * No message echoes an Agent-supplied value. A rejected plan's ids and
 * instructions are exactly the untrusted text this validator exists to refuse,
 * so retry feedback names the rule that failed and nothing else.
 */
const planStructureErrors = (
  run: CoordinationRun,
  payload: SessionPlanPayload,
): ArtifactValidationError[] => {
  const errors: ArtifactValidationError[] = [];
  const participantIds = new Set(run.participants.map(({ agentId }) => agentId));
  const { assignments } = payload;

  if (assignments.length > participantIds.size) {
    errors.push({
      path: "assignments",
      code: "too_many_assignments",
      message: `A plan may contain at most ${participantIds.size} assignments, one per participant`,
    });
  }

  if (assignments.some(({ agentId }) => !participantIds.has(agentId))) {
    errors.push({
      path: "assignments",
      code: "unknown_participant",
      message: "Every assignment agentId must be a participant of this session",
    });
  }

  const assignedIds = new Set(assignments.map(({ agentId }) => agentId));
  if (assignedIds.size !== assignments.length) {
    errors.push({
      path: "assignments",
      code: "duplicate_participant",
      message: "Each participant may appear at most once in a plan",
    });
  }

  const positions = [...assignments].map(({ position }) => position).sort((a, b) => a - b);
  if (positions.some((position, index) => position !== index + 1)) {
    errors.push({
      path: "assignments",
      code: "non_contiguous_positions",
      message: "Assignment positions must be contiguous from 1",
    });
  }

  return errors;
};

export class SharedSessionArtifactProtocol implements ArtifactProtocol {
  constructor(private readonly dependencies: ArtifactProtocolDependencies) {}

  validate(input: {
    run: CoordinationRun;
    turn: CoordinationTurn;
    attempt: CoordinationAttempt;
    rawOutput: string;
  }): ArtifactValidationResult {
    const { run, turn, rawOutput } = input;
    if (rawOutput.length > run.policy.outputMaxChars) {
      return {
        ok: false,
        code: "OUTPUT_TOO_LARGE",
        errors: [{
          path: "output",
          code: "output_too_large",
          message: `Agent output exceeds the ${run.policy.outputMaxChars} character limit`,
        }],
      };
    }

    const body = stripOuterFence(rawOutput.trim());
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return invalidAt("output", "invalid_json", "Agent output is not a single JSON object");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return invalidAt("output", "not_an_object", "Agent output must be one JSON object");
    }

    const candidate = parsed as Record<string, unknown>;
    // The backend, not the Agent, decides which artifact type this turn owes.
    // A plan offered for a message turn and a message offered for a plan turn
    // are the same mistake and are refused by the same comparison.
    const expected =
      turn.kind === "session_turn" || turn.kind === "session_plan"
        ? EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND[turn.kind]
        : undefined;
    if (expected === undefined || candidate["type"] !== expected) {
      return invalidAt(
        "type",
        "unexpected_artifact_type",
        `This turn must produce an artifact of type "${expected ?? "session_message"}"`,
      );
    }
    if (candidate["schemaVersion"] !== COORDINATION_ARTIFACT_SCHEMA_VERSION) {
      return invalidAt(
        "schemaVersion",
        "unsupported_schema_version",
        `Artifact schema version must be ${COORDINATION_ARTIFACT_SCHEMA_VERSION}`,
      );
    }
    if (run.policy.workflow !== "shared_session_v1") {
      return invalidAt("output", "invalid_workflow", "Session output requires a shared-session run");
    }

    if (expected === "session_plan") {
      const planResult = sessionPlanPayloadSchema.safeParse(candidate);
      if (!planResult.success) {
        return invalid(planResult.error.issues.map((issue) => ({
          path: formatPath(issue.path),
          code: issue.code,
          message: issue.message,
        })));
      }
      const structureErrors = planStructureErrors(run, planResult.data);
      if (structureErrors.length > 0) {
        return invalid(structureErrors);
      }
      return {
        ok: true,
        artifact: {
          id: this.dependencies.ids.artifactId(),
          runId: run.id,
          turnId: turn.id,
          createdByRole: turn.role,
          createdByAgentId: turn.agentId,
          sizeChars: rawOutput.length,
          createdAt: this.dependencies.clock.nowIso(),
          type: "session_plan",
          payload: planResult.data,
        },
      };
    }

    const schemaResult = sessionMessagePayloadSchema.safeParse(candidate);
    if (!schemaResult.success) {
      return invalid(schemaResult.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        code: issue.code,
        message: issue.message,
      })));
    }
    const payload = schemaResult.data;
    // Free chat is the only session protocol (P14-07). The middleware bounds
    // and shapes a message; it never judges its substance.
    if (run.policy.sessionProtocol !== "free_chat") {
      return invalidAt("output", "invalid_session_protocol", "Session protocol is invalid");
    }

    return {
      ok: true,
      artifact: {
        id: this.dependencies.ids.artifactId(),
        runId: run.id,
        turnId: turn.id,
        createdByRole: turn.role,
        createdByAgentId: turn.agentId,
        sizeChars: rawOutput.length,
        createdAt: this.dependencies.clock.nowIso(),
        type: "session_message",
        payload,
      },
    };
  }
}

/** Selects the parser from durable workflow state; Agent prose cannot affect it. */
export class CoordinationArtifactProtocolDispatchV1 implements ArtifactProtocol {
  constructor(
    private readonly verified: ArtifactProtocol,
    private readonly session: ArtifactProtocol,
  ) {}

  validate(input: Parameters<ArtifactProtocol["validate"]>[0]): ArtifactValidationResult {
    return (input.run.policy.workflow === "shared_session_v1" ? this.session : this.verified)
      .validate(input);
  }
}
