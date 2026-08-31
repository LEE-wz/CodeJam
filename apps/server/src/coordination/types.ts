export type CoordinationRunId = string;
export type CoordinationTurnId = string;
export type CoordinationAttemptId = string;
export type CoordinationArtifactId = string;
export type CoordinationEventId = string;
export type AgentId = string;
export type AgentRunId = string;

export type CoordinationRole = "planner" | "critic" | "finalizer" | "participant";
export type CoordinationPhase =
  | "drafting"
  | "reviewing"
  | "revising"
  | "finalizing"
  | "sessioning"
  | "done";

export type CoordinationRunStatus =
  | "created"
  | "running"
  | "stop_requested"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "stopped";

export type CoordinationTurnKind =
  | "initial_proposal"
  | "proposal_revision"
  | "proposal_review"
  | "finalization"
  | "session_turn";

export type CoordinationTurnStatus =
  | "scheduled"
  | "running"
  | "committed"
  | "failed"
  | "cancelled";

export type CoordinationAttemptStatus =
  | "running"
  | "succeeded"
  | "invalid_output"
  | "timed_out"
  | "failed"
  | "cancelled"
  | "stale_ignored";

export type ArtifactType =
  | "proposal"
  | "review"
  | "final"
  | "session_message"
  | "user_message";
export type ReviewDecision = "approve" | "reject";

/**
 * Which workflow drives a run. The backend selects the decision source from
 * this value; an Agent can never change it. `verified_handoff_v1` is the
 * existing Planner -> Critic -> Finaliser pipeline and remains the default for
 * every create request that does not name a workflow.
 */
export type CoordinationWorkflowKind = "verified_handoff_v1" | "shared_session_v1";

/**
 * Which rules a shared session turn is validated against. `countdown` requires
 * each message to be the exact next integer; `free_chat` accepts any bounded
 * non-empty message and never judges its substance (overview-sessions.md
 * Sections 6.1 and 6.5).
 */
export type SessionProtocol = "countdown" | "free_chat";

export type CoordinationErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "DUPLICATE_AGENT"
  | "AGENT_NOT_READY"
  | "AGENT_RESERVED"
  | "ACTIVE_RUN_CONFLICT"
  | "ATTEMPT_TIMED_OUT"
  | "AGENT_EXECUTION_FAILED"
  | "INVALID_AGENT_OUTPUT"
  | "OUTPUT_TOO_LARGE"
  | "MAX_ATTEMPTS_EXCEEDED"
  | "MAX_REVISIONS_EXCEEDED"
  | "MAX_TURNS_EXCEEDED"
  | "SERVER_RESTARTED"
  | "STOPPED_BY_USER"
  /**
   * A run whose orchestration loop exited without a terminal repository call and
   * could not be safely resumed (Phase 11, P11-02). It names an abandoned run,
   * never an Agent fault: the Agents behaved, the loop lost its claim on the run.
   */
  | "RUN_ABANDONED"
  | "INTERNAL_ERROR";

export interface CoordinationParticipant {
  role: CoordinationRole;
  agentId: AgentId;
  agentNameSnapshot: string;
}

export interface CoordinationPolicy {
  workflow: CoordinationWorkflowKind;
  maxRevisions: number;
  maxTurns: number;
  maxAttemptsPerTurn: number;
  perAttemptTimeoutMs: number;
  contextMaxChars: number;
  outputMaxChars: number;
  /**
   * Shared-session runs only. Absent on verified-handoff runs.
   */
  sessionProtocol?: SessionProtocol;
  /**
   * Countdown sessions only: the first number the participants must publish.
   * Absent on free-chat and verified-handoff runs.
   */
  sessionStartValue?: number;
}

export const DEFAULT_COORDINATION_POLICY: CoordinationPolicy = {
  workflow: "verified_handoff_v1",
  maxRevisions: 2,
  maxTurns: 8,
  maxAttemptsPerTurn: 2,
  perAttemptTimeoutMs: 120_000,
  contextMaxChars: 12_000,
  outputMaxChars: 20_000,
};

export interface RequiredSection {
  key: string;
  title: string;
}

/**
 * Durable state a shared session run carries between turns. Countdown runs hold
 * the next integer the workflow will accept; the repository decrements it in the
 * same atomic mutation that commits the message. Free-chat runs have no shared
 * state and omit this object entirely (overview-sessions.md Section 6.5).
 */
export interface CoordinationSharedState {
  nextExpectedNumber: number;
}

export interface CoordinationRun {
  id: CoordinationRunId;
  name: string;
  objective: string;
  requiredSections: RequiredSection[];
  participants: CoordinationParticipant[];
  policy: CoordinationPolicy;
  status: CoordinationRunStatus;
  phase: CoordinationPhase;
  revision: number;
  nextTurnSequence: number;
  activeTurnId?: CoordinationTurnId;
  latestProposalArtifactId?: CoordinationArtifactId;
  latestReviewArtifactId?: CoordinationArtifactId;
  finalArtifactId?: CoordinationArtifactId;
  /** The most recent user prompt being answered by the current session wave. */
  lastUserArtifactId?: CoordinationArtifactId;
  /** Present only when an explicit End session action completed the run. */
  endedByUser?: boolean;
  /** Countdown sessions only. Absent on free-chat and verified-handoff runs. */
  sharedState?: CoordinationSharedState;
  version: number;
  errorCode?: CoordinationErrorCode;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  stoppedAt?: string;
}

export interface CoordinationTurn {
  id: CoordinationTurnId;
  runId: CoordinationRunId;
  sequence: number;
  role: CoordinationRole;
  agentId: AgentId;
  kind: CoordinationTurnKind;
  status: CoordinationTurnStatus;
  attemptCount: number;
  activeAttemptId?: CoordinationAttemptId;
  inputArtifactIds: CoordinationArtifactId[];
  outputArtifactId?: CoordinationArtifactId;
  lastValidationErrors: string[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CoordinationAttempt {
  id: CoordinationAttemptId;
  runId: CoordinationRunId;
  turnId: CoordinationTurnId;
  number: number;
  agentId: AgentId;
  leaseToken: string;
  status: CoordinationAttemptStatus;
  agentRunId?: AgentRunId;
  promptDigest?: string;
  outputDigest?: string;
  errorCode?: CoordinationErrorCode;
  errorMessage?: string;
  createdAt: string;
  finishedAt?: string;
}

export interface ProposalSection {
  key: string;
  title: string;
  content: string;
}

export interface ProposalPayload {
  schemaVersion: 1;
  type: "proposal";
  summary: string;
  sections: ProposalSection[];
}

export interface ReviewIssue {
  code: string;
  sectionKey?: string;
  message: string;
}

export interface ReviewPayload {
  schemaVersion: 1;
  type: "review";
  decision: ReviewDecision;
  issues: ReviewIssue[];
  feedback: string;
}

export interface FinalPayload {
  schemaVersion: 1;
  type: "final";
  title: string;
  content: string;
}

/**
 * One participant's contribution to a shared session transcript.
 *
 * `done` is the free-chat completion signal. It is advisory: an Agent may
 * declare that it considers the shared objective met, but the Agent never ends
 * the run. `SharedSessionWorkflowV1` completes a free-chat run only when every
 * participant's most recent committed message carries `done: true` -- unanimous
 * consent across one full round -- or at `maxTurns`, or on user stop, whichever
 * comes first. A later message from the same participant without the flag
 * clears that participant's signal. The rule is computed from committed
 * artifacts by backend code, so the trust boundary in overview.md Section 5.1
 * is unchanged: Agents supply input, the state machine decides.
 *
 * `done` is rejected on countdown messages, where the numeric validator is the
 * sole authority on completion (P6-05 cross-field rule).
 */
export interface SessionMessagePayload {
  schemaVersion: 1;
  type: "session_message";
  content: string;
  done?: boolean;
}

export interface UserMessagePayload {
  schemaVersion: 1;
  type: "user_message";
  content: string;
}

export type ArtifactPayload =
  | ProposalPayload
  | ReviewPayload
  | FinalPayload
  | SessionMessagePayload
  | UserMessagePayload;

export interface CoordinationArtifactBase {
  id: CoordinationArtifactId;
  runId: CoordinationRunId;
  turnId: CoordinationTurnId;
  createdByRole: CoordinationRole;
  createdByAgentId: AgentId;
  sizeChars: number;
  createdAt: string;
  /** Total order across user and Agent transcript entries. Absent on legacy data. */
  transcriptSequence?: number;
}

export interface UserMessageArtifact {
  id: CoordinationArtifactId;
  runId: CoordinationRunId;
  type: "user_message";
  payload: UserMessagePayload;
  createdBy: { kind: "user" };
  /** Optional idempotency key supplied by the client. */
  clientMessageId?: string;
  transcriptSequence: number;
  sizeChars: number;
  createdAt: string;
  turnId?: undefined;
}

export type CoordinationArtifact =
  | (CoordinationArtifactBase & { type: "proposal"; payload: ProposalPayload })
  | (CoordinationArtifactBase & { type: "review"; payload: ReviewPayload })
  | (CoordinationArtifactBase & { type: "final"; payload: FinalPayload })
  | (CoordinationArtifactBase & {
      type: "session_message";
      payload: SessionMessagePayload;
    })
  | UserMessageArtifact;

export type CoordinationEventType =
  | "run.created"
  | "run.started"
  | "turn.scheduled"
  | "attempt.started"
  | "attempt.invalid_output"
  | "attempt.timed_out"
  | "attempt.failed"
  | "attempt.cancelled"
  | "attempt.stale_ignored"
  | "turn.committed"
  | "review.approved"
  | "review.rejected"
  | "run.stop_requested"
  | "run.stopped"
  | "run.completed"
  | "run.failed"
  | "run.interrupted"
  /**
   * A non-terminal run whose stranded turn and attempt were settled so the run
   * stays schedulable (Phase 11, P11-02). Additive: it never replaces a terminal
   * event, and a run may carry several across its life.
   */
  | "run.reconciled"
  | "user.message_appended"
  | "run.awaiting_input";

export type CoordinationEventActor =
  | { type: "system" }
  | { type: "user" }
  | { type: "agent"; agentId: AgentId; role: CoordinationRole };

export type SafeEventValue = string | number | boolean | null | string[];

export interface CoordinationEvent {
  id: CoordinationEventId;
  runId: CoordinationRunId;
  sequence: number;
  type: CoordinationEventType;
  actor: CoordinationEventActor;
  turnId?: CoordinationTurnId;
  attemptId?: CoordinationAttemptId;
  artifactId?: CoordinationArtifactId;
  message: string;
  details: Record<string, SafeEventValue>;
  createdAt: string;
}

export interface CoordinationRunDetails {
  run: CoordinationRun;
  turns: CoordinationTurn[];
  attempts: CoordinationAttempt[];
  artifacts: CoordinationArtifact[];
  events: CoordinationEvent[];
  /** Present only for a delta detail response. */
  cursor?: number;
}

export interface AppendUserMessageRequest {
  content: string;
  clientMessageId?: string;
}

export interface RoleAgentSelection {
  plannerAgentId: AgentId;
  criticAgentId: AgentId;
  finalizerAgentId: AgentId;
}

export interface CreateCoordinationRunRequest {
  /** Optional and defaulted, so existing clients keep working unchanged. */
  workflow?: "verified_handoff_v1" | undefined;
  name: string;
  objective: string;
  requiredSections: RequiredSection[];
  agents: RoleAgentSelection;
  policy?:
    | {
        maxRevisions?: number | undefined;
        maxTurns?: number | undefined;
        perAttemptTimeoutMs?: number | undefined;
      }
    | undefined;
}

/**
 * Create body for a shared session run. `agents` is ordered: the array order is
 * the round-robin turn order (overview-sessions.md Section 7). Session runs
 * accept no `requiredSections` and no `maxRevisions`.
 */
export interface CreateSessionRunRequest {
  workflow: "shared_session_v1";
  name: string;
  objective: string;
  agents: AgentId[];
  policy?:
    | {
        sessionProtocol?: SessionProtocol | undefined;
        sessionStartValue?: number | undefined;
        maxTurns?: number | undefined;
        perAttemptTimeoutMs?: number | undefined;
      }
    | undefined;
}

/** Either create body. The service discriminates on `workflow`. */
export type CreateRunRequest = CreateCoordinationRunRequest | CreateSessionRunRequest;

/**
 * Frozen session limits, referenced by the routes, the service, and the UI.
 *
 * The participant and turn ranges were widened by the Session v2 mini-RFC
 * (P10-03, P10-04). `maxSessionTurns` is a ceiling for callers that ask for it
 * explicitly; `defaultSessionTurns` is what a session gets when it does not, so
 * a runaway wave costs a bounded number of turns rather than the ceiling.
 *
 * The countdown values remain until P14-07 deletes the protocol.
 */
/**
 * Context budget for shared-session runs (P10-05). Ten participants holding a
 * long conversation overflow the 12,000-character verified-handoff budget, and
 * an overflowing session prompt degrades into an unreadable transcript. The
 * verified workflow keeps `DEFAULT_COORDINATION_POLICY.contextMaxChars`.
 */
export const SESSION_CONTEXT_MAX_CHARS = 40_000;

export const SESSION_LIMITS = {
  minParticipants: 2,
  maxParticipants: 10,
  minStartValue: 2,
  maxStartValue: 12,
  defaultStartValue: 10,
  minSessionTurns: 3,
  maxSessionTurns: 100_000,
  defaultSessionTurns: 200,
  messageMinChars: 1,
  messageMaxChars: 500,
} as const;

export interface ListCoordinationRunsResponse {
  runs: CoordinationRun[];
}

/** The HTTP read model excludes the internal attempt lease capability. */
export type CoordinationAttemptResponse = Omit<CoordinationAttempt, "leaseToken">;

export interface GetCoordinationRunResponse
  extends Omit<CoordinationRunDetails, "attempts"> {
  attempts: CoordinationAttemptResponse[];
}

export interface CreateCoordinationRunResponse {
  run: CoordinationRun;
}

export interface StartCoordinationRunResponse {
  run: CoordinationRun;
  accepted: true;
}

export interface StopCoordinationRunResponse {
  run: CoordinationRun;
  accepted: true;
}

export interface ApiErrorResponse {
  error: {
    code: CoordinationErrorCode;
    message: string;
    fieldErrors?: Record<string, string[]>;
    requestId?: string;
  };
}
