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
  | "session_turn"
  /**
   * The coordinator turn scheduled once per user message (P14-01). It produces
   * a `session_plan` artifact naming who answers, in what order, and with what
   * instruction. The backend still owns every scheduling decision; this turn
   * only proposes one.
   */
  | "session_plan";

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
  | "session_plan"
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
 * Which rules a shared session turn is validated against. `free_chat` accepts
 * any bounded non-empty message and never judges its substance
 * (overview-sessions.md Sections 6.1 and 6.5).
 *
 * The `countdown` member was deleted in Phase 14 (P14-07): ordered output is
 * now produced by coordinator planning plus transcript visibility rather than
 * by an engine-side numeric validator. Stored countdown runs keep their
 * persisted `"countdown"` value and stay readable; no engine path accepts one.
 */
export type SessionProtocol = "free_chat";

/**
 * How a session decides who answers each user message (P14-05).
 *
 * `coordinator` schedules one `session_plan` turn per user message and executes
 * the validated plan. `round_robin` restores the deterministic Phase 13
 * behaviour with no planning turn, and is the demo-safe fallback when a model
 * plans badly. The workflow reads this from durable policy only: no Agent
 * output can change it.
 */
export type SessionPlanningPolicy = "coordinator" | "round_robin";

/** Whether a plan's assignments run as one fan-out wave or strictly in order. */
export type SessionPlanMode = "parallel" | "sequential";

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
  /** Enables deterministic fan-out for the active user message. */
  sessionParallel?: boolean;
  /** Shared-session only; enforced by the wave supervisor. */
  maxParallelTurns?: number;
  /**
   * Shared-session only. Absent on verified-handoff runs and on stored session
   * runs created before Phase 14, which are read as `round_robin`.
   */
  sessionPlanning?: SessionPlanningPolicy;
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
 * A session run carries no protocol shared state. `CoordinationSharedState`
 * and `run.sharedState` existed only for the countdown protocol and were
 * deleted with it (P14-07).
 *
 * Deletion applies to the engine, not to the ledger. A stored pre-Phase-14 run
 * still carries `sharedState` and `policy.sessionStartValue` in its JSON: the
 * repository normalises runs by spread, so unknown fields survive a read and
 * are returned unchanged through the API for display. No engine path writes,
 * reads, or validates them any more.
 */
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
  /** Every scheduled or running turn in the current durable wave. */
  activeTurnIds: CoordinationTurnId[];
  latestProposalArtifactId?: CoordinationArtifactId;
  latestReviewArtifactId?: CoordinationArtifactId;
  finalArtifactId?: CoordinationArtifactId;
  /** The most recent user prompt being answered by the current session wave. */
  lastUserArtifactId?: CoordinationArtifactId;
  /** Present only when an explicit End session action completed the run. */
  endedByUser?: boolean;
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
  /**
   * Transcript bound for session turns (P15-05).
   *
   * The workflow pins what this turn may read as "every `session_message` and
   * `user_message` of this run with `transcriptSequence` at or below this
   * value", instead of listing every id. Listing them made turn *n* store *n*
   * ids, so the ledger grew O(n^2): `P15-01` measured `inputArtifactIds` as 93%
   * of all turn bytes at 400 turns, and that growth is what puts a hard
   * `RangeError` ceiling near 4,400 committed turns.
   *
   * The trust boundary is unchanged. The workflow still decides what is
   * readable, the durable record still pins that decision, and the context
   * builder still applies the role whitelist on top; only the encoding is
   * smaller. Artifacts outside the transcript - the round's committed plan -
   * stay listed explicitly in `inputArtifactIds`, so a bound can never widen a
   * turn onto a plan the workflow did not name.
   *
   * Absent on turns stored before P15-05 and on verified-handoff turns, which
   * name their few inputs explicitly. When absent, `inputArtifactIds` is the
   * whole answer and the legacy path applies.
   */
  inputThroughSequence?: number;
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
 * `done` is the advisory wave signal. An Agent may declare that it considers
 * the current user request addressed; an Agent never ends the session. What the
 * signal does depends on how the round is being driven:
 *
 * - Under `sessionPlanning: "round_robin"`, a wave ends when every
 *   participant's most recent message *in that wave* carries `done: true` --
 *   unanimous consent across one full round. A later message from the same
 *   participant that omits the flag clears that participant's signal.
 * - Under `sessionPlanning: "coordinator"` (the default since P14-05), `done`
 *   is not consulted: the round ends when every assignment in the committed
 *   plan has committed.
 *
 * In both cases the round ends by returning the run to `awaiting_input`, where
 * it accepts another prompt (P12-07). It does **not** complete the run. A
 * session becomes terminal only on an explicit user End, on failure, or at the
 * hard `maxTurns` ceiling -- which fails the run with `MAX_TURNS_EXCEEDED`
 * rather than completing it.
 *
 * Every one of these rules is computed from committed artifacts by backend
 * code, so the trust boundary in overview.md Section 5.1 is unchanged: Agents
 * supply input, the state machine decides.
 *
 * `done` is valid on any session message. The rule that rejected it on a
 * countdown message went with that protocol in P14-07.
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

/**
 * One participant's share of a planned round: which Agent answers, where it
 * falls in the order, and what it is being asked to do.
 *
 * `position` is 1-based and, across a whole plan, forms a contiguous run from 1
 * to the assignment count. In `sequential` mode it is the execution order; in
 * `parallel` mode it only orders the assignments for display, because every
 * assignment is scheduled in one wave.
 */
export interface SessionPlanAssignment {
  agentId: AgentId;
  position: number;
  instruction: string;
}

/**
 * A coordinator's proposal for one round (P14-01).
 *
 * The Agent proposes; the backend disposes. The middleware validates this
 * payload structurally -- participants, distinct ids, contiguous positions,
 * bounded instructions -- and never judges whether the plan is a *good* plan.
 * Scheduling, leases, limits, cancellation, and completion stay backend-owned,
 * and no field here can change policy, participants, limits, or another run.
 */
export interface SessionPlanPayload {
  schemaVersion: 1;
  type: "session_plan";
  mode: SessionPlanMode;
  assignments: SessionPlanAssignment[];
}

export type ArtifactPayload =
  | ProposalPayload
  | ReviewPayload
  | FinalPayload
  | SessionMessagePayload
  | SessionPlanPayload
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
  | (CoordinationArtifactBase & {
      type: "session_plan";
      payload: SessionPlanPayload;
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
        sessionParallel?: boolean | undefined;
        maxParallelTurns?: number | undefined;
        sessionPlanning?: SessionPlanningPolicy | undefined;
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
 * The countdown start-value bounds were deleted with the protocol (P14-07).
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
  minSessionTurns: 3,
  maxSessionTurns: 100_000,
  defaultSessionTurns: 200,
  /**
   * Measured guidance from `P15-01`, re-measured after the `P15-05` data-model
   * fix. Not a type bound.
   *
   * Before the fix a session cost O(n^2) and one prompt took 1.65s at 500
   * committed turns. With the transcript pinned as a bound the ledger is linear
   * at ~4.28 KB per turn, and one prompt takes 0.45s at 500, 0.94s at 1,000 and
   * 2.06s at 2,000. 2,000 is where a prompt first crosses two seconds, so it is
   * the honest comfortable length. `defaultSessionTurns` stays well under it.
   */
  recommendedMaxSessionTurns: 2_000,
  /** Where the UI starts warning: 80% of the measured recommendation. */
  sessionTurnWarningThreshold: 1_600,
  /**
   * The largest session a caller may request (P15-05).
   *
   * `persist()` serialises the whole database into one string, so Node's
   * 512 MiB `MAX_STRING_LENGTH` is a hard wall: past it the session cannot be
   * saved at all. Before the `P15-05` fix that wall sat near 4,426 committed
   * turns. At the measured post-fix rate it sits near 120,000, so this cap is
   * set at roughly half of that - headroom for longer messages, more
   * participants, and retry attempts, none of which the measurement maximised.
   *
   * `maxSessionTurns` remains the type-level ceiling; stored runs above this cap
   * keep loading, and only new requests are bounded.
   */
  maxSaveableSessionTurns: 50_000,
  maxParallelTurns: 10,
  messageMinChars: 1,
  messageMaxChars: 500,
  /** Per-assignment instruction bound for a `session_plan` artifact (P14-01). */
  planInstructionMaxChars: 500,
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
