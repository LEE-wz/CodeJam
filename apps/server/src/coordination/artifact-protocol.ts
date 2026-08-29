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
} from "./types.js";

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
  type: ArtifactType,
  value: unknown,
): { ok: true; payload: ArtifactPayload } | { ok: false; error: z.ZodError } => {
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
 * schema. P1-06 fixes this step's position in the order; the rules themselves
 * (required section coverage and uniqueness, reject/approve issue consistency,
 * non-empty final content) are P1-07.
 */
const applyCrossFieldRules = (
  _run: CoordinationRun,
  _payload: ArtifactPayload,
): ArtifactValidationError[] => [];

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
