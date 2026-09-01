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
  | "session_bid";

/** Backend-owned reason a session wave was scheduled. */
export type CoordinationWavePurpose = "session_execution" | "session_bidding";

/**
 * How a shared session answers one user prompt (PA13-10).
 *
 * `sequential` is the Phase 12 behaviour: one turn at a time, round-robin.
 * `parallel` schedules every participant as one atomic wave executed under a
 * bounded concurrency cap. The mode is durable policy chosen at create time and
 * read only by backend code, so no Agent output can widen its own fan-out.
 */
export type SessionWaveMode = "sequential" | "parallel";

export type SessionRoutingMode = "direct" | "auction" | "auto";
export type SessionAuctionFallback = "default_agent" | "round_robin" | "fail";
export type SessionAuctionScoringVersion = "confidence_cost_v1";

/** Durable, backend-normalized policy for an auction-capable session. */
export interface SessionAuctionPolicy {
  routingMode: SessionRoutingMode;
  defaultAgentId?: AgentId;
  directConfidenceThresholdBps: number;
  directOutputTokenBudget: number;
  minimumValidBids: number;
  maxBidOutputTokens: number;
  maxBidAttempts: number;
  auctionExecutionTokenBudget: number;
  auctionOnDirectFailure: boolean;
  fallback: SessionAuctionFallback;
  scoringVersion: SessionAuctionScoringVersion;
}

/** Create-time auction policy. Omitted fields receive backend-owned defaults. */
export interface SessionAuctionPolicyInput {
  routingMode?: SessionRoutingMode | undefined;
  defaultAgentId?: AgentId | undefined;
  directConfidenceThresholdBps?: number | undefined;
  directOutputTokenBudget?: number | undefined;
  minimumValidBids?: number | undefined;
  maxBidOutputTokens?: number | undefined;
  maxBidAttempts?: number | undefined;
  auctionExecutionTokenBudget?: number | undefined;
  auctionOnDirectFailure?: boolean | undefined;
  fallback?: SessionAuctionFallback | undefined;
  scoringVersion?: SessionAuctionScoringVersion | undefined;
}

/**
 * Which model thread an attempt runs on (PA13-09).
 *
 * `agent_default` resumes the Agent's existing Codex thread, which is what the
 * Playground and every pre-auction coordination turn do. `fresh` starts the
 * attempt with no prior thread and does not write its thread back to the Agent,
 * so a bid can never inherit hidden context that a sibling bidder lacks, and a
 * bid can never contaminate the Agent's own conversation.
 */
export type ExecutionThreadPolicy = "agent_default" | "fresh";

export interface AgentSpecialization {
  perspective: string;
  focusAreas: string[];
  biddingInstructions: string;
}

/** Provider-neutral token accounting safe to expose in coordination reads. */
export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface RunUsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** Counts every attempt with usage, whether or not that attempt produced an artifact. */
export const aggregateRunUsage = (
  attempts: ReadonlyArray<Pick<CoordinationAttempt, "usage">>,
): RunUsageTotals =>
  attempts.reduce<RunUsageTotals>(
    (total, attempt) => ({
      inputTokens: total.inputTokens + (attempt.usage?.inputTokens ?? 0),
      cachedInputTokens: total.cachedInputTokens + (attempt.usage?.cachedInputTokens ?? 0),
      outputTokens: total.outputTokens + (attempt.usage?.outputTokens ?? 0),
    }),
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  );

/**
 * The three token quantities an auction round must never conflate (PA14-15).
 *
 * `actualBidding` is already spent on bid attempts. `actualExecution` is spent
 * on awarded execution attempts. `projectedExecution` is what the committed
 * awards estimated before executing, so a reader can compare an estimate with
 * what it actually cost. Nothing here is a currency amount: these are token
 * counts only.
 */
export interface SessionAuctionUsage {
  actualBidding: RunUsageTotals;
  actualExecution: RunUsageTotals;
  projectedExecution: { inputTokens: number; outputTokens: number };
}

/**
 * Split run usage by what each attempt was for. An attempt belongs to bidding
 * when its turn is a bid turn; every other session or handoff attempt is
 * execution, so the two totals always reconstruct `usageTotals`.
 */
export const splitAuctionUsage = (input: {
  turns: ReadonlyArray<Pick<CoordinationTurn, "id" | "kind">>;
  attempts: ReadonlyArray<Pick<CoordinationAttempt, "turnId" | "usage">>;
  artifacts: ReadonlyArray<CoordinationArtifact>;
}): SessionAuctionUsage => {
  const bidTurnIds = new Set(
    input.turns.filter(({ kind }) => kind === "session_bid").map(({ id }) => id),
  );
  const bidding = input.attempts.filter(({ turnId }) => bidTurnIds.has(turnId));
  const execution = input.attempts.filter(({ turnId }) => !bidTurnIds.has(turnId));
  const projectedExecution = input.artifacts.reduce(
    (total, artifact) =>
      artifact.type === "session_award"
        ? {
            inputTokens: total.inputTokens + artifact.payload.estimatedExecution.inputTokens,
            outputTokens: total.outputTokens + artifact.payload.estimatedExecution.outputTokens,
          }
        : total,
    { inputTokens: 0, outputTokens: 0 },
  );
  return {
    actualBidding: aggregateRunUsage(bidding),
    actualExecution: aggregateRunUsage(execution),
    projectedExecution,
  };
};

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
  | "session_bid"
  | "session_award"
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
 * Which rules a shared session turn is validated against. `free_chat` accepts
 * any bounded non-empty message and never judges its substance
 * (overview-sessions.md Sections 6.1 and 6.5).
 *
 * The `countdown` member was deleted in auction Phase 14 (PA14-18): ordered
 * output is now produced by an awarded sequential plan rather than by an
 * engine-side numeric validator. Stored countdown runs keep their persisted
 * `"countdown"` value and stay readable; no engine path accepts one.
 */
export type SessionProtocol = "free_chat";

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
  specializationSnapshot?: AgentSpecialization;
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
   * Shared-session runs only. Absent means `sequential`, so every run stored
   * before PA13-10 keeps its exact Phase 12 behaviour on reload.
   */
  sessionWaveMode?: SessionWaveMode;
  /**
   * Backend-owned purpose given to every turn of a parallel wave. Absent means
   * `session_execution`. A `session_bidding` run produces bid-shaped evidence
   * only: Phase 13 makes no award, and Phase 14 owns bid artifacts and scoring.
   */
  sessionWavePurpose?: CoordinationWavePurpose;
  /**
   * Upper bound on turns of one wave executing at the same time. Absent means
   * the derived default in `resolveMaxParallelTurns`.
   */
  maxParallelTurns?: number;
  /**
   * Present only on auction-capable free-chat sessions. Absence is the durable
   * legacy-session marker: old sessions retain their pre-auction routing.
   */
  auctionPolicy?: SessionAuctionPolicy;
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
 * A session run carries no protocol shared state. `CoordinationSharedState` and
 * `run.sharedState` existed only for the countdown protocol and were deleted
 * with it (PA14-18).
 *
 * Deletion applies to the engine, not to the ledger: a run persisted before the
 * deletion still carries `sharedState` and `policy.sessionStartValue` in its
 * JSON, and the read path returns the stored document untouched, so that
 * history still loads and renders.
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
  /** Turn leases currently owned by this run, in scheduling order. */
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
  /** Missing only on pre-auction stored history; reads normalize it to execution. */
  wavePurpose?: CoordinationWavePurpose;
  /**
   * Which provider thread this turn runs on. Absent means the pre-auction
   * default for the turn kind. Written by backend scheduling only (PA14-11):
   * an awarded execution starts fresh so the answer depends on the committed
   * plan and transcript rather than on an Agent's private history.
   */
  threadPolicy?: ExecutionThreadPolicy;
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
  /** Missing on pre-auction history and null when the provider supplied no usage. */
  usage?: RunUsage | null;
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
 */
export interface SessionMessagePayload {
  schemaVersion: 1;
  type: "session_message";
  content: string;
  done?: boolean;
}

export type SessionBidRecommendation = "direct" | "auction";
export type SessionBidPlanMode = "single" | "sequential" | "parallel";

export interface SessionBidAssignment {
  agentId: AgentId;
  position: number;
  instruction: string;
}

export interface SessionBidPlan {
  summary: string;
  mode: SessionBidPlanMode;
  assignments: SessionBidAssignment[];
  risks: string[];
  assumptions: string[];
}

export interface SessionBidPayload {
  schemaVersion: 1;
  type: "session_bid";
  recommendation: SessionBidRecommendation;
  candidateAnswer?: string;
  plan: SessionBidPlan;
  confidenceBps: number;
  estimatedOutputTokens: number;
}

/**
 * What an award instructs the session to do next (PA14-09).
 *
 * `publish_candidate` publishes the winning bid's own candidate answer as the
 * round's response. `execute_plan` schedules the winning plan's assignments.
 * `fallback_execution` is the durable, exactly-once record that the round drew
 * fewer than `minimumValidBids` valid bids and the configured fallback Agent
 * received an ordinary execution turn instead; it is the only outcome whose
 * award has no winning bid.
 */
export type SessionAwardOutcome =
  | "publish_candidate"
  | "execute_plan"
  | "fallback_execution";

export interface SessionAwardComponents {
  calibratedConfidenceBps: number;
  normalizedProjectedCostBps: number;
  reliabilityPenaltyBps: number;
}

/**
 * Backend-authored, immutable record of the one selection made for one user
 * message. No Agent can author it: it has no turn and no Agent provenance, and
 * the repository is its only writer.
 */
export interface SessionAwardPayload {
  schemaVersion: 1;
  type: "session_award";
  userArtifactId: CoordinationArtifactId;
  winningBidArtifactId?: CoordinationArtifactId;
  selectedAgentId: AgentId;
  outcome: SessionAwardOutcome;
  scoringVersion: SessionAuctionScoringVersion;
  scoreBps: number;
  components: SessionAwardComponents;
  estimatedExecution: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Present only on a fallback award: which configured rule chose the Agent. */
  fallback?: Exclude<SessionAuctionFallback, "fail">;
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
  | SessionBidPayload
  | SessionAwardPayload
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
  /** Bounded per-round routing request. Absent on every pre-PA14-14 message. */
  routing?: SessionMessageRouting;
  transcriptSequence: number;
  sizeChars: number;
  createdAt: string;
  turnId?: undefined;
}

/**
 * The award has no turn, no attempt, and no Agent author. Keeping it off
 * `CoordinationArtifactBase` is the structural guarantee that it can only be
 * produced by the repository, and its absent `transcriptSequence` keeps it out
 * of every transcript projection.
 */
export interface SessionAwardArtifact {
  id: CoordinationArtifactId;
  runId: CoordinationRunId;
  type: "session_award";
  payload: SessionAwardPayload;
  createdBy: { kind: "system" };
  sizeChars: number;
  createdAt: string;
  turnId?: undefined;
  transcriptSequence?: undefined;
}

export type CoordinationArtifact =
  | (CoordinationArtifactBase & { type: "proposal"; payload: ProposalPayload })
  | (CoordinationArtifactBase & { type: "review"; payload: ReviewPayload })
  | (CoordinationArtifactBase & { type: "final"; payload: FinalPayload })
  | (CoordinationArtifactBase & { type: "session_bid"; payload: SessionBidPayload })
  | (CoordinationArtifactBase & {
      type: "session_message";
      payload: SessionMessagePayload;
      /** Backend publication of an accepted Auto bid candidate (PA14-07). */
      sourceBidArtifactId?: CoordinationArtifactId;
    })
  | SessionAwardArtifact
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
  /**
   * One turn of a wave was retired without committing, while the run continued
   * (PA13-12). It is the durable record that a bidder was unavailable for a
   * round. It never appears for a verified-handoff turn and never replaces a
   * terminal run event.
   */
  | "turn.failed"
  | "bid.candidate_published"
  /**
   * Exactly one award was committed for the current user-message round
   * (PA14-09). It is authored by the system and names only IDs, the outcome,
   * the scoring version, and integer score components.
   */
  | "award.created"
  /**
   * The round drew fewer than `minimumValidBids` valid bids and the configured
   * bounded fallback was applied exactly once (PA14-13).
   */
  | "auction.fallback_applied"
  /**
   * One optional user rating of a committed award (PA14-17). It is an event, so
   * the award itself stays immutable, and it carries only IDs and the enum.
   */
  | "award.feedback_recorded"
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
  usageTotals: RunUsageTotals;
  /** Present on every read. Bid, awarded-execution, and projected token counts. */
  auctionUsage: SessionAuctionUsage;
  artifacts: CoordinationArtifact[];
  events: CoordinationEvent[];
  /** Present only for a delta detail response. */
  cursor?: number;
}

/**
 * Per-round routing a user may request (PA14-14).
 *
 * Every field is a bounded enum or a participant id. Budgets, concurrency,
 * attempt ceilings, and participant scope are deliberately absent: those live
 * only in durable session policy, so no message can widen what a round costs.
 * `riskLevel: "high"` forces an auction for that round and can never lower it
 * to direct.
 */
export interface SessionMessageRouting {
  routingMode?: "direct" | "auction" | undefined;
  selectedAgentId?: AgentId | undefined;
  coordinationPreference?: "any" | "single" | "team" | undefined;
  riskLevel?: "standard" | "high" | undefined;
}

export interface AppendUserMessageRequest {
  content: string;
  clientMessageId?: string;
  routing?: SessionMessageRouting | undefined;
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
        maxTurns?: number | undefined;
        perAttemptTimeoutMs?: number | undefined;
        sessionWaveMode?: SessionWaveMode | undefined;
        sessionWavePurpose?: CoordinationWavePurpose | undefined;
        maxParallelTurns?: number | undefined;
        auctionPolicy?: SessionAuctionPolicyInput | undefined;
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
  messageMinChars: 1,
  messageMaxChars: 500,
  minParallelTurns: 1,
  maxParallelTurns: 10,
  defaultParallelTurns: 4,
} as const;

export const SESSION_AUCTION_LIMITS = {
  minConfidenceBps: 0,
  maxConfidenceBps: 10_000,
  minDirectOutputTokens: 1,
  maxDirectOutputTokens: 4_000,
  minBidOutputTokens: 128,
  maxBidOutputTokens: 4_096,
  minBidAttempts: 1,
  maxBidAttempts: 3,
  minExecutionOutputTokens: 128,
  maxExecutionOutputTokens: 16_000,
} as const;

export const DEFAULT_SESSION_AUCTION_POLICY: SessionAuctionPolicy = {
  routingMode: "auto",
  directConfidenceThresholdBps: 8_000,
  directOutputTokenBudget: 4_000,
  minimumValidBids: 2,
  maxBidOutputTokens: 2_048,
  maxBidAttempts: 2,
  auctionExecutionTokenBudget: 4_000,
  auctionOnDirectFailure: false,
  fallback: "round_robin",
  scoringVersion: "confidence_cost_v1",
};

/**
 * The concurrency cap actually applied to a wave (PA13-10).
 *
 * The default is `min(participantCount, 4)` with a hard ceiling of
 * `SESSION_LIMITS.maxParallelTurns`. An explicit policy value is still clamped
 * to `[1, ceiling]`, so a malformed durable record cannot widen the cap, and a
 * ten-participant wave can never open more than ten concurrent attempts.
 */
export const resolveMaxParallelTurns = (run: {
  participants: ReadonlyArray<unknown>;
  policy: CoordinationPolicy;
}): number => {
  const ceiling = SESSION_LIMITS.maxParallelTurns;
  const requested = run.policy.maxParallelTurns;
  const base =
    typeof requested === "number" && Number.isInteger(requested) && requested > 0
      ? requested
      : Math.min(run.participants.length, SESSION_LIMITS.defaultParallelTurns);
  return Math.max(SESSION_LIMITS.minParallelTurns, Math.min(base, ceiling));
};

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
