import type {
  AgentId,
  AgentRunId,
  ArtifactType,
  CoordinationArtifact,
  CoordinationArtifactId,
  CoordinationAttempt,
  CoordinationAttemptId,
  CoordinationErrorCode,
  CoordinationRole,
  CoordinationRun,
  CoordinationRunDetails,
  CoordinationRunId,
  CoordinationTurn,
  CoordinationTurnId,
  AppendUserMessageRequest,
  CreateCoordinationRunRequest,
  CreateRunRequest,
} from "./types.js";

export interface Clock {
  nowIso(): string;
}

export interface IdGenerator {
  runId(): CoordinationRunId;
  turnId(): CoordinationTurnId;
  attemptId(): CoordinationAttemptId;
  artifactId(): CoordinationArtifactId;
  eventId(): string;
  leaseToken(): string;
}

export interface CoordinationServiceContract {
  initialize(): Promise<void>;
  listRuns(): Promise<CoordinationRun[]>;
  getRun(id: CoordinationRunId): Promise<CoordinationRunDetails | undefined>;
  createRun(input: CreateRunRequest): Promise<CoordinationRun>;
  startRun(id: CoordinationRunId): Promise<CoordinationRun>;
  stopRun(id: CoordinationRunId): Promise<CoordinationRun>;
  resumeRun(id: CoordinationRunId, input: AppendUserMessageRequest): Promise<CoordinationRun>;
  endRun(id: CoordinationRunId): Promise<CoordinationRun>;
}

export interface CoordinationAgentView {
  id: AgentId;
  name: string;
  status: "ready" | "busy" | "stopped" | "error";
}

export interface CoordinationAgentDirectory {
  getAgentsByIds(ids: AgentId[]): Promise<CoordinationAgentView[]>;
}

export interface ScheduledTurnSpec {
  role: CoordinationRole;
  /**
   * Session turns name the selected member of the repeated participant role.
   * Verified-handoff decisions omit this and retain role lookup.
   */
  agentId?: AgentId;
  turnKind: CoordinationTurn["kind"];
  phase: CoordinationRun["phase"];
  revision: number;
  inputArtifactIds: CoordinationArtifactId[];
  expectedArtifactType: ArtifactType;
}

export type WorkflowDecision =
  | ({ kind: "schedule" } & ScheduledTurnSpec)
  | { kind: "schedule_wave"; turns: ScheduledTurnSpec[] }
  | { kind: "complete"; finalArtifactId: CoordinationArtifactId }
  | { kind: "await_input" }
  | { kind: "fail"; code: CoordinationErrorCode; message: string };

export interface WorkflowView {
  run: CoordinationRun;
  turns: CoordinationTurn[];
  artifacts: CoordinationArtifact[];
}

export interface VerifiedHandoffWorkflow {
  decideNext(view: WorkflowView): WorkflowDecision;
}

/**
 * The shared-session decision source. Deliberately the same shape as
 * `VerifiedHandoffWorkflow`: both are pure functions of committed durable state
 * and both return the frozen `WorkflowDecision`, so the orchestration loop in
 * `CoordinationService` needs no branch of its own.
 *
 * Round-robin position derives from committed session turns only, so a retry
 * never advances it (overview-sessions.md Section 5).
 */
export interface SharedSessionWorkflow {
  decideNext(view: WorkflowView): WorkflowDecision;
}

/**
 * Selects the decision source for a run from `run.policy.workflow`.
 *
 * The dispatch is backend-owned and reads only durable state. An Agent cannot
 * reach it, so no Agent can move its run onto a different workflow. A run's
 * workflow is fixed at create time and never changes.
 */
export interface CoordinationWorkflowDispatch {
  forRun(run: CoordinationRun): {
    decideNext(view: WorkflowView): WorkflowDecision;
  };
}

export interface PromptEnvelope {
  prompt: string;
  promptDigest: string;
  truncated: boolean;
}

export interface ContextBuildInput {
  run: CoordinationRun;
  turn: CoordinationTurn;
  artifacts: CoordinationArtifact[];
  retryValidationErrors: string[];
}

export interface ContextBuilder {
  build(input: ContextBuildInput): PromptEnvelope;
}

export interface ArtifactValidationError {
  path: string;
  code: string;
  message: string;
}

export type ArtifactValidationResult =
  | { ok: true; artifact: CoordinationArtifact }
  | {
      ok: false;
      code: "INVALID_AGENT_OUTPUT" | "OUTPUT_TOO_LARGE";
      errors: ArtifactValidationError[];
    };

export interface ArtifactProtocol {
  validate(input: {
    run: CoordinationRun;
    turn: CoordinationTurn;
    attempt: CoordinationAttempt;
    rawOutput: string;
  }): ArtifactValidationResult;
}

export interface CreateRunRecordInput {
  run: CoordinationRun;
}

export type StartRunCommitResult =
  | { kind: "started"; run: CoordinationRun }
  | { kind: "not_found" }
  | {
      kind: "conflict";
      code: "INVALID_STATE" | "AGENT_NOT_READY" | "AGENT_RESERVED";
      message: string;
    };

export interface ScheduleTurnInput {
  runId: CoordinationRunId;
  expectedRunVersion: number;
  turn: CoordinationTurn;
  nextPhase: CoordinationRun["phase"];
  nextRevision: number;
}

/** Atomically schedules every sibling in one session wave. */
export interface ScheduleTurnsInput {
  runId: CoordinationRunId;
  expectedRunVersion: number;
  turns: CoordinationTurn[];
  nextPhase: CoordinationRun["phase"];
  nextRevision: number;
}

export type ScheduleTurnResult =
  | { kind: "scheduled"; run: CoordinationRun; turn: CoordinationTurn }
  | { kind: "stale"; currentRun: CoordinationRun }
  | { kind: "not_found" };

export type ScheduleTurnsResult =
  | { kind: "scheduled"; run: CoordinationRun; turns: CoordinationTurn[] }
  | { kind: "stale"; currentRun: CoordinationRun }
  | { kind: "not_found" };

export interface BeginAttemptInput {
  runId: CoordinationRunId;
  turnId: CoordinationTurnId;
  attempt: CoordinationAttempt;
  /**
   * Whether the prompt for this attempt was truncated to fit
   * `policy.contextMaxChars`. Recorded in the `attempt.started` event details
   * rather than on the attempt, per the confirmed handoff decision 1.2.
   */
  truncated?: boolean | undefined;
}

export type BeginAttemptResult =
  | { kind: "started"; run: CoordinationRun; turn: CoordinationTurn }
  | { kind: "stale" }
  | { kind: "not_found" };

export interface CommitAcceptedArtifactInput {
  runId: CoordinationRunId;
  turnId: CoordinationTurnId;
  attemptId: CoordinationAttemptId;
  leaseToken: string;
  artifact: CoordinationArtifact;
  /**
   * Digest of the raw Agent output this artifact was parsed from. Written to
   * `attempt.outputDigest` on commit, per the confirmed handoff decision 1.3.
   */
  outputDigest?: string | undefined;
}

export type CommitAcceptedArtifactResult =
  | {
      kind: "committed";
      run: CoordinationRun;
      turn: CoordinationTurn;
      artifact: CoordinationArtifact;
    }
  | { kind: "stale" }
  | { kind: "not_found" };

export interface FinishAttemptInput {
  runId: CoordinationRunId;
  turnId: CoordinationTurnId;
  attemptId: CoordinationAttemptId;
  leaseToken: string;
  status: "invalid_output" | "timed_out" | "failed" | "cancelled";
  errorCode: CoordinationErrorCode;
  errorMessage: string;
  validationErrors?: string[];
}

/**
 * A run that is not terminal, plus the two facts a reconciler needs to decide
 * whether anything is stranded: which turn the run still points at, and whether
 * any attempt of the run is durably `running` (P11-04).
 */
export interface NonTerminalRunSummary {
  runId: CoordinationRunId;
  status: "running" | "stop_requested";
  activeTurnIds: CoordinationTurnId[];
  hasRunningAttempt: boolean;
}

/**
 * Outcome of one reconciliation pass over a single run (P11-04).
 *
 * `reconciled` settled a stranded turn and attempt and left the run `running`
 * and schedulable. `noop` found nothing to settle, which is what makes the
 * command idempotent. `owned` means another actor is responsible for the run's
 * next transition (a `stop_requested` run belongs to the stop path). `terminal`
 * and `not_found` are both "there is nothing to reconcile here".
 */
export type ReconcileRunResult =
  | { kind: "reconciled"; run: CoordinationRun }
  | { kind: "noop"; run: CoordinationRun }
  | { kind: "owned"; run: CoordinationRun }
  | { kind: "terminal"; run: CoordinationRun }
  | { kind: "not_found" };

export interface AppendUserMessageInput extends AppendUserMessageRequest {
  runId: CoordinationRunId;
}

export type AppendUserMessageResult =
  | { kind: "appended"; run: CoordinationRun; artifact: CoordinationArtifact }
  | { kind: "duplicate"; run: CoordinationRun }
  | {
      kind: "conflict";
      run: CoordinationRun;
      code?: "INVALID_STATE" | "AGENT_NOT_READY" | "AGENT_RESERVED";
      message?: string;
    }
  | { kind: "terminal"; run: CoordinationRun }
  | { kind: "not_found" };

export interface CoordinationRepository {
  listRuns(limit?: number): Promise<CoordinationRun[]>;
  getRunDetails(id: CoordinationRunId): Promise<CoordinationRunDetails | undefined>;
  createRun(input: CreateRunRecordInput): Promise<CoordinationRun>;
  startRun(id: CoordinationRunId): Promise<StartRunCommitResult>;
  appendUserMessage(input: AppendUserMessageInput): Promise<AppendUserMessageResult>;
  awaitInput(id: CoordinationRunId): Promise<CoordinationRun | undefined>;
  endSession(id: CoordinationRunId): Promise<
    | { kind: "ended"; run: CoordinationRun }
    | { kind: "conflict"; run: CoordinationRun }
    | { kind: "not_found" }
  >;
  scheduleTurn(input: ScheduleTurnInput): Promise<ScheduleTurnResult>;
  scheduleTurns(input: ScheduleTurnsInput): Promise<ScheduleTurnsResult>;
  beginAttempt(input: BeginAttemptInput): Promise<BeginAttemptResult>;
  attachAgentRun(input: {
    attemptId: CoordinationAttemptId;
    leaseToken: string;
    agentRunId: AgentRunId;
  }): Promise<"attached" | "stale">;
  commitAcceptedArtifact(
    input: CommitAcceptedArtifactInput,
  ): Promise<CommitAcceptedArtifactResult>;
  finishAttempt(input: FinishAttemptInput): Promise<"finished" | "stale">;
  requestStop(id: CoordinationRunId): Promise<CoordinationRun | undefined>;
  finishStopped(id: CoordinationRunId): Promise<CoordinationRun | undefined>;
  completeRun(input: {
    runId: CoordinationRunId;
    finalArtifactId: CoordinationArtifactId;
  }): Promise<CoordinationRun | undefined>;
  failRun(input: {
    runId: CoordinationRunId;
    code: CoordinationErrorCode;
    message: string;
  }): Promise<CoordinationRun | undefined>;
  interruptActiveRuns(): Promise<CoordinationRunId[]>;
  /**
   * Every run that is neither terminal nor `created`. The reconciler pairs this
   * with its own `activeLoops` map to decide which runs have no owner.
   */
  listNonTerminalRuns(): Promise<NonTerminalRunSummary[]>;
  /**
   * Settle a stranded turn and attempt in one mutation, leaving the run
   * `running` and schedulable. Idempotent on a run that needs nothing, and it
   * never re-opens a terminal run.
   */
  reconcileRun(input: {
    runId: CoordinationRunId;
    reason: string;
  }): Promise<ReconcileRunResult>;
}

export interface RuntimeExecutionInput {
  runId: CoordinationRunId;
  turnId: CoordinationTurnId;
  attemptId: CoordinationAttemptId;
  leaseToken: string;
  agentId: AgentId;
  prompt: string;
  timeoutMs: number;
}

export type RuntimeOutcome =
  | { kind: "succeeded"; rawOutput: string }
  | { kind: "timed_out"; message: string }
  | { kind: "cancelled"; message: string }
  | { kind: "failed"; message: string };

export interface RuntimeExecutionHandle {
  agentRunId: AgentRunId;
  completion: Promise<RuntimeOutcome>;
}

export type RuntimeStartResult =
  | { kind: "started"; handle: RuntimeExecutionHandle }
  | { kind: "failed"; message: string };

export interface CoordinationRuntime {
  start(input: RuntimeExecutionInput): Promise<RuntimeStartResult>;
  cancelAttempt(attemptId: CoordinationAttemptId): Promise<boolean>;
}

export interface Redactor {
  text(value: string, maxChars: number): string;
  eventDetails(
    value: Record<string, unknown>,
  ): Record<string, string | number | boolean | null | string[]>;
}

export interface StartAgentExecutionRequest {
  agentId: AgentId;
  prompt: string;
  source: "playground" | "coordination";
  coordination?: {
    runId: CoordinationRunId;
    turnId: CoordinationTurnId;
    attemptId: CoordinationAttemptId;
  };
}

export interface AgentExecutionHandle {
  agentRunId: AgentRunId;
  messageId: string;
  completion: Promise<{
    status: "completed" | "failed" | "cancelled";
    output?: string;
    error?: string;
  }>;
}

export interface AgentExecutionControl {
  startExecution(input: StartAgentExecutionRequest): Promise<AgentExecutionHandle>;
  cancelRun(agentRunId: AgentRunId): Promise<boolean>;
}

/**
 * Display-only description of the run an Agent is enrolled in (P11-05, P11-08).
 * It carries the run's id and its name snapshot and nothing else: no lease, no
 * prompt, no turn or attempt internals.
 */
export interface CoordinationReservationAdvisory {
  runId: CoordinationRunId;
  name: string;
}

export interface CoordinationReservationSource {
  getReservingRunId(agentId: AgentId): Promise<CoordinationRunId | undefined>;
  /**
   * Optional so existing compositions and test doubles keep working. When
   * present, the reservation message can name the session instead of being
   * opaque.
   */
  getReservingRunSummary?(
    agentId: AgentId,
  ): Promise<CoordinationReservationAdvisory | undefined>;
}
