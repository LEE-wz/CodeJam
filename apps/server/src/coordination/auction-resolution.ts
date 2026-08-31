import type { ContextBuilder, WorkflowDecision } from "./contracts.js";
import type { AwardSessionBidInput } from "./contracts.js";
import {
  auctionContextCeilingInputTokens,
  rankSessionBids,
  scoreSessionBid,
  type AuctionScoreHistory,
  type ScoreBidInput,
} from "./auction-scoring.js";
import type {
  AgentId,
  CoordinationArtifact,
  CoordinationAttempt,
  CoordinationEvent,
  CoordinationRun,
  CoordinationTurn,
} from "./types.js";

type BidArtifact = Extract<CoordinationArtifact, { type: "session_bid" }>;

export interface ResolveAuctionInput {
  run: CoordinationRun;
  turns: readonly CoordinationTurn[];
  artifacts: readonly CoordinationArtifact[];
  attempts?: readonly CoordinationAttempt[] | undefined;
  /** Award feedback is an event, never a mutation of the immutable award. */
  events?: readonly CoordinationEvent[] | undefined;
  decision: Extract<WorkflowDecision, { kind: "resolve_auction" }>;
  contextBuilder: ContextBuilder;
  availableAgentIds?: ReadonlySet<AgentId> | undefined;
}

/**
 * What the service should commit for a settled auction round.
 *
 * `award` is the exact repository command; `fail` is the configured safe
 * failure. Nothing here writes: the decision is a pure function of committed
 * evidence and durable policy, so a restart re-derives the same command.
 */
export type ResolveAuctionOutcome =
  | { kind: "award"; command: Omit<AwardSessionBidInput, "runId" | "expectedRunVersion"> }
  | { kind: "fail"; message: string };

/**
 * Render the prompt each proposed assignment would receive, for cost estimation
 * only (PA14-08 input). The turn is provisional and never persisted.
 *
 * A plan whose prompt does not fit the session context budget is priced at the
 * run's ceiling rather than being silently discounted, so an over-large plan can
 * never outrank a modest one by failing to render.
 */
const renderExecutionPrompts = (input: ResolveAuctionInput, bid: BidArtifact): string[] => {
  const transcriptInputIds = input.turns
    .filter((turn) => turn.kind === "session_bid")
    .flatMap((turn) => turn.inputArtifactIds);
  const inputArtifactIds = [...new Set(transcriptInputIds)];
  const ceilingPrompt = "x".repeat(input.run.policy.contextMaxChars);
  return bid.payload.plan.assignments.map((assignment) => {
    const turn: CoordinationTurn = {
      id: `projected-${bid.id}-${assignment.position}`,
      runId: input.run.id,
      sequence: input.run.nextTurnSequence,
      role: "participant",
      agentId: assignment.agentId,
      kind: "session_turn",
      wavePurpose: "session_execution",
      status: "scheduled",
      attemptCount: 0,
      inputArtifactIds,
      lastValidationErrors: [],
      createdAt: input.run.createdAt,
    };
    try {
      return input.contextBuilder.build({
        run: input.run,
        turn,
        artifacts: [...input.artifacts],
        retryValidationErrors: [],
      }).prompt;
    } catch {
      return ceilingPrompt;
    }
  });
};

/**
 * Per-Agent outcome history used for calibration and reliability penalties.
 *
 * It is derived from this run's own committed awards and their execution turns.
 * Ratings come from recorded user feedback (PA14-17); until a round is rated it
 * contributes nothing, which is what keeps the cold-start rule active.
 */
export const buildAuctionHistory = (
  input: Pick<ResolveAuctionInput, "run" | "turns" | "attempts" | "artifacts" | "events">,
  agentId: AgentId,
): AuctionScoreHistory => {
  const awards = input.artifacts.filter(
    (artifact): artifact is Extract<CoordinationArtifact, { type: "session_award" }> =>
      artifact.type === "session_award" && artifact.payload.selectedAgentId === agentId,
  );
  const bidsById = new Map(
    input.artifacts
      .filter((artifact): artifact is BidArtifact => artifact.type === "session_bid")
      .map((artifact) => [artifact.id, artifact] as const),
  );
  const executions = awards.flatMap((award) => {
    const bid = award.payload.winningBidArtifactId
      ? bidsById.get(award.payload.winningBidArtifactId)
      : undefined;
    if (!bid) return [];
    const executionTurns = input.turns.filter(
      (turn) =>
        turn.kind === "session_turn" &&
        turn.inputArtifactIds.includes(award.id),
    );
    if (executionTurns.length === 0) return [];
    const failed = executionTurns.some(({ status }) => status === "failed");
    const executionTurnIds = new Set(executionTurns.map(({ id }) => id));
    const attemptsWithUsage = (input.attempts ?? []).filter(
      (attempt) => executionTurnIds.has(attempt.turnId) && attempt.usage != null,
    );
    const actualOutputTokens = attemptsWithUsage.reduce(
      (total, attempt) => total + (attempt.usage?.outputTokens ?? 0),
      0,
    );
    return [
      {
        failed,
        estimatedOutputTokens: bid.payload.estimatedOutputTokens,
        // Reliability compares the estimate with provider-reported usage from
        // every attempt that incurred output, including failed and retried
        // attempts. Artifact character counts are not token evidence.
        ...(attemptsWithUsage.length > 0 ? { actualOutputTokens } : {}),
      },
    ];
  });
  // One current rating per award: a later rating for the same award replaces
  // the earlier one rather than counting twice.
  const awardIds = new Set(awards.map(({ id }) => id));
  const currentRatings = new Map<string, boolean>();
  for (const event of input.events ?? []) {
    if (
      event.type === "award.feedback_recorded" &&
      event.artifactId !== undefined &&
      awardIds.has(event.artifactId)
    ) {
      currentRatings.set(event.artifactId, event.details.decision === "accepted");
    }
  }
  const ratings = [...currentRatings.values()].map((accepted) => ({ accepted }));
  return { ratings, executions };
};

/**
 * Resolve one settled auction round into exactly one durable command.
 *
 * An accepted Auto candidate is still scored, so its award records the same
 * reproducible components as a ranked one. When fewer than `minimumValidBids`
 * survive eligibility, the configured bounded fallback applies exactly once.
 */
export const resolveAuction = (input: ResolveAuctionInput): ResolveAuctionOutcome => {
  const policy = input.run.policy.auctionPolicy;
  if (!policy) {
    return { kind: "fail", message: "Auction resolution requires an auction policy" };
  }
  const availableAgentIds =
    input.availableAgentIds ?? new Set(input.run.participants.map(({ agentId }) => agentId));
  const remainingTurnCapacity = Math.max(
    0,
    input.run.policy.maxTurns - input.turns.length,
  );
  const contextCeilingInputTokens = auctionContextCeilingInputTokens(input.run);

  const byId = new Map(
    input.artifacts
      .filter((artifact): artifact is BidArtifact => artifact.type === "session_bid")
      .map((artifact) => [artifact.id, artifact] as const),
  );
  const toScoreInput = (bid: BidArtifact): ScoreBidInput => ({
    run: input.run,
    bid,
    renderedExecutionPrompts: renderExecutionPrompts(input, bid),
    contextCeilingInputTokens,
    availableAgentIds,
    remainingTurnCapacity,
    history: buildAuctionHistory(input, bid.createdByAgentId),
  });

  const direct = input.decision.directCandidateBidArtifactId
    ? byId.get(input.decision.directCandidateBidArtifactId)
    : undefined;
  if (direct) {
    const directScore = scoreSessionBid({
      ...toScoreInput(direct),
      // Publishing an accepted candidate needs no second execution turn. Give
      // its already validated single-assignment plan one projection slot so
      // the common scorer can price it without applying the competitive
      // minimum-valid-bids rule.
      remainingTurnCapacity: Math.max(1, remainingTurnCapacity),
    });
    // The accepted candidate is one bounded self-assigned answer that already
    // passed every publication gate, so `minimumValidBids` does not apply to it:
    // that threshold governs choosing between competitors.
    if (!directScore.eligible) {
      return { kind: "fail", message: directScore.reason };
    }
    const score = directScore.score;
    return {
      kind: "award",
      command: {
        userArtifactId: input.decision.userArtifactId,
        winningBidArtifactId: direct.id,
        selectedAgentId: direct.createdByAgentId,
        outcome: "publish_candidate",
        scoringVersion: policy.scoringVersion,
        scoreBps: score.scoreBps,
        components: {
          calibratedConfidenceBps: score.calibratedConfidenceBps,
          normalizedProjectedCostBps: score.normalizedProjectedCostBps,
          reliabilityPenaltyBps: score.reliabilityPenaltyBps,
        },
        estimatedExecution: {
          inputTokens: score.estimatedInputTokens,
          outputTokens: score.estimatedOutputTokens,
        },
      },
    };
  }

  const bids = input.decision.bidArtifactIds.flatMap((id) => {
    const bid = byId.get(id);
    return bid ? [bid] : [];
  });
  const ranked = rankSessionBids({ run: input.run, bids: bids.map(toScoreInput) });
  if (ranked.kind === "ranked") {
    const winner = ranked.winner;
    return {
      kind: "award",
      command: {
        userArtifactId: input.decision.userArtifactId,
        winningBidArtifactId: winner.bidArtifactId,
        selectedAgentId: winner.agentId,
        outcome: "execute_plan",
        scoringVersion: policy.scoringVersion,
        scoreBps: winner.scoreBps,
        components: {
          calibratedConfidenceBps: winner.calibratedConfidenceBps,
          normalizedProjectedCostBps: winner.normalizedProjectedCostBps,
          reliabilityPenaltyBps: winner.reliabilityPenaltyBps,
        },
        estimatedExecution: {
          inputTokens: winner.estimatedInputTokens,
          outputTokens: winner.estimatedOutputTokens,
        },
      },
    };
  }

  if (policy.fallback === "fail") {
    return {
      kind: "fail",
      message: "Auction round produced fewer valid bids than the configured minimum",
    };
  }
  const fallbackAgentId = selectFallbackAgent(
    input.run,
    policy.fallback,
    input.artifacts,
    availableAgentIds,
  );
  if (!fallbackAgentId) {
    return { kind: "fail", message: "Auction fallback found no eligible participant" };
  }
  return {
    kind: "award",
    command: {
      userArtifactId: input.decision.userArtifactId,
      selectedAgentId: fallbackAgentId,
      outcome: "fallback_execution",
      scoringVersion: policy.scoringVersion,
      scoreBps: 0,
      components: {
        calibratedConfidenceBps: 0,
        normalizedProjectedCostBps: 0,
        reliabilityPenaltyBps: 0,
      },
      estimatedExecution: { inputTokens: 0, outputTokens: 0 },
      fallback: policy.fallback,
      fallbackEvidence: {
        validBidCount: ranked.validBidCount,
        requiredBidCount: ranked.requiredBidCount,
      },
    },
  };
};

/**
 * The bounded fallback Agent, exactly as the approved addendum specifies.
 *
 * `default_agent` uses the configured Agent and falls back to stored
 * participant order when it is absent or unavailable. `round_robin` advances by
 * the count of earlier fallback awards modulo stored participant order, so
 * repeated fallbacks do not pin the same Agent, and it skips unavailable Agents
 * by continuing deterministically around the roster.
 */
export const selectFallbackAgent = (
  run: CoordinationRun,
  fallback: "default_agent" | "round_robin",
  artifacts: readonly CoordinationArtifact[],
  availableAgentIds?: ReadonlySet<AgentId>,
): AgentId | undefined => {
  const participants = run.participants;
  if (participants.length === 0) return undefined;
  const available = (agentId: AgentId): boolean =>
    availableAgentIds === undefined || availableAgentIds.has(agentId);
  if (fallback === "default_agent") {
    const configured = run.policy.auctionPolicy?.defaultAgentId;
    if (
      configured &&
      participants.some(({ agentId }) => agentId === configured) &&
      available(configured)
    ) {
      return configured;
    }
    return participants.find(({ agentId }) => available(agentId))?.agentId;
  }
  const earlierFallbacks = artifacts.filter(
    (artifact) =>
      artifact.type === "session_award" && artifact.payload.outcome === "fallback_execution",
  ).length;
  for (let offset = 0; offset < participants.length; offset += 1) {
    const candidate = participants[(earlierFallbacks + offset) % participants.length]!;
    if (available(candidate.agentId)) return candidate.agentId;
  }
  return undefined;
};
