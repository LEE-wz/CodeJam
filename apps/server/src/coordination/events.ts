import { defaultRedactor } from "./redaction.js";
import type { Redactor } from "./contracts.js";
import type {
  AgentId,
  ArtifactType,
  CoordinationArtifactId,
  CoordinationAttemptId,
  CoordinationErrorCode,
  CoordinationEvent,
  CoordinationEventActor,
  CoordinationEventType,
  CoordinationRole,
  CoordinationRunId,
  CoordinationTurnId,
  CoordinationTurnKind,
  ReviewDecision,
  SafeEventValue,
} from "./types.js";

export type {
  CoordinationEvent,
  CoordinationEventActor,
  CoordinationEventType,
  SafeEventValue,
} from "./types.js";

/**
 * An event before the repository assigns its identity.
 *
 * `id`, `sequence`, and `createdAt` are deliberately absent: overview Section
 * 10.3 requires the per-run sequence to be allocated inside the same
 * `JsonStore.mutate()` callback as the state change, so only the repository can
 * supply them. These factories stay pure and side-effect free.
 */
export interface CoordinationEventDraft {
  runId: CoordinationRunId;
  type: CoordinationEventType;
  actor: CoordinationEventActor;
  turnId?: CoordinationTurnId;
  attemptId?: CoordinationAttemptId;
  artifactId?: CoordinationArtifactId;
  message: string;
  details: Record<string, SafeEventValue>;
}

/** Maximum characters retained in an event's display message. */
export const MAX_EVENT_MESSAGE_CHARS = 200;

const SYSTEM: CoordinationEventActor = { type: "system" };
const USER: CoordinationEventActor = { type: "user" };

const agentActor = (agentId: AgentId, role: CoordinationRole): CoordinationEventActor => ({
  type: "agent",
  agentId,
  role,
});

/**
 * User-facing role labels. The stored enum stays `finalizer`; only the display
 * label uses the product spelling "Finaliser".
 */
const ROLE_LABELS: Record<CoordinationRole, string> = {
  planner: "Planner",
  critic: "Critic",
  finalizer: "Finaliser",
};

export const roleLabel = (role: CoordinationRole): string => ROLE_LABELS[role];

const TURN_KIND_LABELS: Record<CoordinationTurnKind, string> = {
  initial_proposal: "initial proposal",
  proposal_revision: "proposal revision",
  proposal_review: "proposal review",
  finalization: "finalization",
};

export interface CoordinationEventFactory {
  runCreated(input: {
    runId: CoordinationRunId;
    name: string;
    workflow: string;
    maxRevisions: number;
    maxTurns: number;
    requiredSectionKeys: string[];
  }): CoordinationEventDraft;

  runStarted(input: {
    runId: CoordinationRunId;
    participantAgentIds: AgentId[];
  }): CoordinationEventDraft;

  turnScheduled(input: {
    runId: CoordinationRunId;
    turnId: CoordinationTurnId;
    sequence: number;
    role: CoordinationRole;
    agentId: AgentId;
    kind: CoordinationTurnKind;
    phase: string;
    revision: number;
    expectedArtifactType: ArtifactType;
    inputArtifactCount: number;
  }): CoordinationEventDraft;

  attemptStarted(input: {
    runId: CoordinationRunId;
    turnId: CoordinationTurnId;
    attemptId: CoordinationAttemptId;
    attemptNumber: number;
    role: CoordinationRole;
    agentId: AgentId;
    promptDigest: string;
    truncated: boolean;
    timeoutMs: number;
  }): CoordinationEventDraft;

  attemptInvalidOutput(input: {
    runId: CoordinationRunId;
    turnId: CoordinationTurnId;
    attemptId: CoordinationAttemptId;
    attemptNumber: number;
    role: CoordinationRole;
    agentId: AgentId;
    code: CoordinationErrorCode;
    validationErrors: string[];
  }): CoordinationEventDraft;

  attemptTimedOut(input: {
    runId: CoordinationRunId;
    turnId: CoordinationTurnId;
    attemptId: CoordinationAttemptId;
    attemptNumber: number;
    role: CoordinationRole;
    agentId: AgentId;
    timeoutMs: number;
  }): CoordinationEventDraft;

  attemptFailed(input: {
    runId: CoordinationRunId;
    turnId: CoordinationTurnId;
    attemptId: CoordinationAttemptId;
    attemptNumber: number;
    role: CoordinationRole;
    agentId: AgentId;
    code: CoordinationErrorCode;
    reason: string;
  }): CoordinationEventDraft;

  attemptCancelled(input: {
    runId: CoordinationRunId;
    turnId: CoordinationTurnId;
    attemptId: CoordinationAttemptId;
    attemptNumber: number;
    role: CoordinationRole;
    agentId: AgentId;
    code: CoordinationErrorCode;
    reason: string;
  }): CoordinationEventDraft;

  attemptStaleIgnored(input: {
    runId: CoordinationRunId;
    turnId: CoordinationTurnId;
    attemptId: CoordinationAttemptId;
    attemptNumber: number;
    reason: string;
  }): CoordinationEventDraft;

  turnCommitted(input: {
    runId: CoordinationRunId;
    turnId: CoordinationTurnId;
    attemptId: CoordinationAttemptId;
    artifactId: CoordinationArtifactId;
    sequence: number;
    role: CoordinationRole;
    agentId: AgentId;
    artifactType: ArtifactType;
    sizeChars: number;
    outputDigest: string;
  }): CoordinationEventDraft;

  reviewDecided(input: {
    runId: CoordinationRunId;
    turnId: CoordinationTurnId;
    artifactId: CoordinationArtifactId;
    agentId: AgentId;
    decision: ReviewDecision;
    issueCount: number;
    issueCodes: string[];
    revision: number;
  }): CoordinationEventDraft;

  runStopRequested(input: { runId: CoordinationRunId }): CoordinationEventDraft;

  runStopped(input: {
    runId: CoordinationRunId;
    code: CoordinationErrorCode;
  }): CoordinationEventDraft;

  runCompleted(input: {
    runId: CoordinationRunId;
    artifactId: CoordinationArtifactId;
  }): CoordinationEventDraft;

  runFailed(input: {
    runId: CoordinationRunId;
    code: CoordinationErrorCode;
    reason: string;
  }): CoordinationEventDraft;

  runInterrupted(input: {
    runId: CoordinationRunId;
    code: CoordinationErrorCode;
  }): CoordinationEventDraft;
}

/**
 * Pure event factories for every frozen event type (overview Section 7.2).
 *
 * Every draft leaves here already redacted: details pass through the allowlist
 * redactor inside the factory, so a caller cannot append an event that carries
 * a lease token, prompt, or raw output by forgetting a redaction step.
 * Messages are short, stable, and built only from enum values and numbers, so
 * they are safe to snapshot and never echo user or model text.
 */
export const createCoordinationEventFactory = (
  redactor: Redactor = defaultRedactor,
): CoordinationEventFactory => {
  const draft = (
    input: Omit<CoordinationEventDraft, "details" | "message"> & {
      message: string;
      details: Record<string, unknown>;
    },
  ): CoordinationEventDraft => {
    const { message, details, ...rest } = input;
    return {
      ...rest,
      message: redactor.text(message, MAX_EVENT_MESSAGE_CHARS),
      details: redactor.eventDetails(details),
    };
  };

  return {
    runCreated: ({ runId, name, workflow, maxRevisions, maxTurns, requiredSectionKeys }) =>
      draft({
        runId,
        type: "run.created",
        actor: USER,
        message: "Run created.",
        details: { name, workflow, maxRevisions, maxTurns, requiredSectionKeys },
      }),

    runStarted: ({ runId, participantAgentIds }) =>
      draft({
        runId,
        type: "run.started",
        actor: USER,
        message: "Run started.",
        // Participant identifiers travel as a bounded string array; the
        // redactor caps its length.
        details: { participantAgentIds },
      }),

    turnScheduled: ({
      runId,
      turnId,
      sequence,
      role,
      agentId,
      kind,
      phase,
      revision,
      expectedArtifactType,
      inputArtifactCount,
    }) =>
      draft({
        runId,
        turnId,
        type: "turn.scheduled",
        actor: SYSTEM,
        message: `Turn ${sequence}: ${roleLabel(role)} to produce the ${TURN_KIND_LABELS[kind]}.`,
        details: {
          sequence,
          role,
          agentId,
          kind,
          phase,
          revision,
          expectedArtifactType,
          inputArtifactCount,
        },
      }),

    attemptStarted: ({
      runId,
      turnId,
      attemptId,
      attemptNumber,
      role,
      agentId,
      promptDigest,
      truncated,
      timeoutMs,
    }) =>
      draft({
        runId,
        turnId,
        attemptId,
        type: "attempt.started",
        actor: agentActor(agentId, role),
        message: `${roleLabel(role)} attempt ${attemptNumber} started.`,
        // `truncated` lives here by the confirmed handoff decision 1.2: the
        // context flag is event evidence, not a persisted attempt field.
        details: { attemptNumber, role, agentId, promptDigest, truncated, timeoutMs },
      }),

    attemptInvalidOutput: ({
      runId,
      turnId,
      attemptId,
      attemptNumber,
      role,
      agentId,
      code,
      validationErrors,
    }) =>
      draft({
        runId,
        turnId,
        attemptId,
        type: "attempt.invalid_output",
        actor: agentActor(agentId, role),
        message: `${roleLabel(role)} attempt ${attemptNumber} returned output that failed validation.`,
        details: {
          attemptNumber,
          role,
          agentId,
          code,
          errorCount: validationErrors.length,
          validationErrors,
        },
      }),

    attemptTimedOut: ({ runId, turnId, attemptId, attemptNumber, role, agentId, timeoutMs }) =>
      draft({
        runId,
        turnId,
        attemptId,
        type: "attempt.timed_out",
        actor: agentActor(agentId, role),
        message: `${roleLabel(role)} attempt ${attemptNumber} timed out.`,
        details: { attemptNumber, role, agentId, code: "ATTEMPT_TIMED_OUT", timeoutMs },
      }),

    attemptFailed: ({ runId, turnId, attemptId, attemptNumber, role, agentId, code, reason }) =>
      draft({
        runId,
        turnId,
        attemptId,
        type: "attempt.failed",
        actor: agentActor(agentId, role),
        message: `${roleLabel(role)} attempt ${attemptNumber} failed.`,
        details: { attemptNumber, role, agentId, code, reason },
      }),

    attemptCancelled: ({ runId, turnId, attemptId, attemptNumber, role, agentId, code, reason }) =>
      draft({
        runId,
        turnId,
        attemptId,
        type: "attempt.cancelled",
        actor: SYSTEM,
        message: `${roleLabel(role)} attempt ${attemptNumber} was cancelled.`,
        details: { attemptNumber, role, agentId, code, reason },
      }),

    attemptStaleIgnored: ({ runId, turnId, attemptId, attemptNumber, reason }) =>
      draft({
        runId,
        turnId,
        attemptId,
        type: "attempt.stale_ignored",
        actor: SYSTEM,
        // By the confirmed handoff decision 2.1 this event is the only record of
        // a refused late result; the attempt row keeps the status it settled as.
        message: `A late result for attempt ${attemptNumber} was ignored.`,
        details: { attemptNumber, reason },
      }),

    turnCommitted: ({
      runId,
      turnId,
      attemptId,
      artifactId,
      sequence,
      role,
      agentId,
      artifactType,
      sizeChars,
      outputDigest,
    }) =>
      draft({
        runId,
        turnId,
        attemptId,
        artifactId,
        type: "turn.committed",
        actor: agentActor(agentId, role),
        message: `Turn ${sequence}: ${roleLabel(role)} committed a ${artifactType}.`,
        details: { sequence, role, agentId, artifactType, sizeChars, outputDigest },
      }),

    reviewDecided: ({
      runId,
      turnId,
      artifactId,
      agentId,
      decision,
      issueCount,
      issueCodes,
      revision,
    }) =>
      draft({
        runId,
        turnId,
        artifactId,
        type: decision === "approve" ? "review.approved" : "review.rejected",
        actor: agentActor(agentId, "critic"),
        message:
          decision === "approve"
            ? "Critic approved the proposal."
            : `Critic requested changes (${issueCount} issue${issueCount === 1 ? "" : "s"}).`,
        details: { decision, issueCount, issueCodes, revision, role: "critic", agentId },
      }),

    runStopRequested: ({ runId }) =>
      draft({
        runId,
        type: "run.stop_requested",
        actor: USER,
        message: "Stop requested.",
        details: { code: "STOPPED_BY_USER" },
      }),

    runStopped: ({ runId, code }) =>
      draft({
        runId,
        type: "run.stopped",
        actor: SYSTEM,
        message: "Run stopped.",
        details: { code },
      }),

    runCompleted: ({ runId, artifactId }) =>
      draft({
        runId,
        artifactId,
        type: "run.completed",
        actor: SYSTEM,
        message: "Run completed.",
        details: { artifactType: "final" },
      }),

    runFailed: ({ runId, code, reason }) =>
      draft({
        runId,
        type: "run.failed",
        actor: SYSTEM,
        message: `Run failed: ${code}.`,
        details: { code, reason },
      }),

    runInterrupted: ({ runId, code }) =>
      draft({
        runId,
        type: "run.interrupted",
        actor: SYSTEM,
        message: "Run interrupted by a server restart.",
        details: { code },
      }),
  };
};

/** Materialise a draft once the repository has allocated its identity. */
export const materialiseEvent = (
  draft: CoordinationEventDraft,
  identity: { id: string; sequence: number; createdAt: string },
): CoordinationEvent => ({
  id: identity.id,
  runId: draft.runId,
  sequence: identity.sequence,
  type: draft.type,
  actor: draft.actor,
  ...(draft.turnId === undefined ? {} : { turnId: draft.turnId }),
  ...(draft.attemptId === undefined ? {} : { attemptId: draft.attemptId }),
  ...(draft.artifactId === undefined ? {} : { artifactId: draft.artifactId }),
  message: draft.message,
  details: draft.details,
  createdAt: identity.createdAt,
});
