import type {
  AgentId,
  AgentRunId,
  AgentSpecialization,
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
  CoordinationWavePurpose,
  SessionAuctionScoringVersion,
  SessionAwardArtifact,
  SessionAwardComponents,
  SessionAwardOutcome,
  AppendUserMessageRequest,
  CreateCoordinationRunRequest,
  CreateRunRequest,
  ExecutionThreadPolicy,
  RunUsage,
} from "./types.js";

export type { ExecutionThreadPolicy } from "./types.js";

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
  recordAwardFeedback(input: RecordAwardFeedbackInput): Promise<CoordinationRun>;
}

export interface CoordinationAgentView {
  id: AgentId;
  name: string;
  status: "ready" | "busy" | "stopped" | "error";
  specialization?: AgentSpecialization;
}

export interface CoordinationAgentDirectory {
  getAgentsByIds(ids: AgentId[]): Promise<CoordinationAgentView[]>;
}

export type WorkflowDecision =
  | {
      kind: "schedule";
      role: CoordinationRole;
      /**
       * Session turns name the selected member of the repeated participant
       * role. Verified-handoff decisions omit this and retain role lookup.
       */
      agentId?: AgentId;
      turnKind: CoordinationTurn["kind"];
      phase: CoordinationRun["phase"];
      revision: number;
      inputArtifactIds: CoordinationArtifactId[];
      expectedArtifactType: ArtifactType;
      /** A standalone Auto primary bid is still bidding work, not execution. */
      wavePurpose?: CoordinationWavePurpose;
      /** Awarded execution runs fresh; omitted elsewhere (PA14-11). */
      threadPolicy?: ExecutionThreadPolicy;
    }
  /**
   * Schedule several turns as one atomic wave (PA13-10).
   *
   * `wavePurpose` is chosen by backend code from durable policy, never from
   * Agent output. The members execute concurrently under the run's derived
   * concurrency cap, and the loop resumes only once every member has settled.
   */
  | {
      kind: "schedule_wave";
      wavePurpose: CoordinationWavePurpose;
      phase: CoordinationRun["phase"];
      revision: number;
      members: Array<{
        role: CoordinationRole;
        agentId: AgentId;
        turnKind: CoordinationTurn["kind"];
        inputArtifactIds: CoordinationArtifactId[];
        expectedArtifactType: ArtifactType;
        threadPolicy?: ExecutionThreadPolicy;
      }>;
    }
  | { kind: "complete"; finalArtifactId: CoordinationArtifactId }
  /**
   * Every bid opportunity for the current round has settled and no award
   * exists yet (PA14-09). The service scores the named bids with the run's
   * configured scoring version and commits exactly one award.
   */
  | {
      kind: "resolve_auction";
      userArtifactId: CoordinationArtifactId;
      bidArtifactIds: CoordinationArtifactId[];
      /**
       * Present when the Auto primary already satisfies every direct
       * publication gate, so the service awards `publish_candidate` without
       * ranking a wider field.
       */
      directCandidateBidArtifactId?: CoordinationArtifactId;
    }
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
  usage?: RunUsage | null | undefined;
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

/**
 * One version-checked award command (PA14-09, PA14-10).
 *
 * `publish_candidate` commits the award and the transcript projection of the
 * winning bid's candidate answer in the same mutation, so a restart can never
 * observe an award without its published message or a message without its
 * award. `fallback_execution` carries no winning bid.
 */
export interface AwardSessionBidInput {
  runId: CoordinationRunId;
  expectedRunVersion: number;
  userArtifactId: CoordinationArtifactId;
  winningBidArtifactId?: CoordinationArtifactId | undefined;
  selectedAgentId: AgentId;
  outcome: SessionAwardOutcome;
  scoringVersion: SessionAuctionScoringVersion;
  scoreBps: number;
  components: SessionAwardComponents;
  estimatedExecution: { inputTokens: number; outputTokens: number };
  /** Fallback awards only: which configured rule chose the Agent. */
  fallback?: "default_agent" | "round_robin" | undefined;
  /** Fallback awards only: the settled evidence recorded with the event. */
  fallbackEvidence?: { validBidCount: number; requiredBidCount: number } | undefined;
}

export type AwardSessionBidResult =
  | {
      kind: "awarded";
      run: CoordinationRun;
      award: SessionAwardArtifact;
      publishedArtifact?: CoordinationArtifact;
    }
  /** An award already exists for this round. The command changed nothing. */
  | {
      kind: "already_awarded";
      run: CoordinationRun;
      award: SessionAwardArtifact;
      publishedArtifact?: CoordinationArtifact;
    }
  | { kind: "stale"; currentRun: CoordinationRun }
  | { kind: "invalid"; currentRun: CoordinationRun; reason: string }
  | { kind: "not_found" };

/**
 * One optional user rating of a committed award (PA14-17). The award artifact
 * is never mutated: the rating is a durable event, and the newest event for an
 * award is its current rating.
 */
export interface RecordAwardFeedbackInput {
  runId: CoordinationRunId;
  awardArtifactId: CoordinationArtifactId;
  decision: "accepted" | "rejected";
}

export type RecordAwardFeedbackResult =
  | { kind: "recorded"; run: CoordinationRun }
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
  usage?: RunUsage | null | undefined;
}

/**
 * A run that is not terminal, plus the two facts a reconciler needs to decide
 * whether anything is stranded: which turns the run still points at, and whether
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
  awardSessionBid(input: AwardSessionBidInput): Promise<AwardSessionBidResult>;
  recordAwardFeedback(input: RecordAwardFeedbackInput): Promise<RecordAwardFeedbackResult>;
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
  /**
   * Retire exactly one turn of a live wave without touching its siblings or the
   * run's terminal state (PA13-12). Used when a bidding-wave member exhausts its
   * budget: that bidder is unavailable for the round, and the run continues.
   */
  failTurn(input: FailTurnInput): Promise<FailTurnResult>;
}

export interface FailTurnInput {
  runId: CoordinationRunId;
  turnId: CoordinationTurnId;
  code: CoordinationErrorCode;
  message: string;
}

export type FailTurnResult =
  | { kind: "failed"; run: CoordinationRun; turn: CoordinationTurn }
  | { kind: "stale" }
  | { kind: "not_found" };

export interface RuntimeExecutionInput {
  runId: CoordinationRunId;
  turnId: CoordinationTurnId;
  attemptId: CoordinationAttemptId;
  leaseToken: string;
  agentId: AgentId;
  prompt: string;
  timeoutMs: number;
  /** Absent means `agent_default`, which is the pre-auction behaviour. */
  threadPolicy?: ExecutionThreadPolicy | undefined;
}

export type RuntimeOutcome =
  | { kind: "succeeded"; rawOutput: string; usage?: RunUsage | null }
  | { kind: "timed_out"; message: string; usage?: RunUsage | null }
  | { kind: "cancelled"; message: string; usage?: RunUsage | null }
  | { kind: "failed"; message: string; usage?: RunUsage | null };

export interface RuntimeExecutionHandle {
  agentRunId: AgentRunId;
  completion: Promise<RuntimeOutcome>;
}

export type RuntimeStartResult =
  | { kind: "started"; handle: RuntimeExecutionHandle }
  /**
   * `busy` marks the bounded, retryable contention case (PA13-13): the Agent is
   * already running something, so this attempt never reached the provider. It
   * is a distinct signal from a generic start failure because a bidding wave may
   * skip a persistently busy bidder, while an execution assignee may not.
   */
  | { kind: "failed"; message: string; busy?: boolean };

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
  /**
   * Absent means `agent_default`. Coordination sets `fresh` for bid-shaped
   * turns so every bidder starts from the same explicit context (PA13-09).
   */
  threadPolicy?: ExecutionThreadPolicy | undefined;
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
    usage?: RunUsage | null;
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
