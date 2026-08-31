import type {
  AgentId,
  CoordinationArtifact,
  CoordinationRun,
  SessionBidPayload,
} from "./types.js";
import { resolveMaxParallelTurns } from "./types.js";

export interface AuctionRatingHistory {
  accepted: boolean;
}

export interface AuctionExecutionHistory {
  failed: boolean;
  estimatedOutputTokens: number;
  actualOutputTokens?: number;
}

export interface AuctionScoreHistory {
  ratings: readonly AuctionRatingHistory[];
  executions: readonly AuctionExecutionHistory[];
}

export interface ScoredSessionBid {
  bidArtifactId: string;
  agentId: AgentId;
  declaredConfidenceBps: number;
  calibratedConfidenceBps: number;
  confidencePenaltyBps: number;
  normalizedProjectedCostBps: number;
  reliabilityPenaltyBps: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  projectedWeightedUnits: number;
  scoreBps: number;
  explanation: string;
}

export type BidEligibilityResult =
  | { eligible: true; score: ScoredSessionBid }
  | { eligible: false; bidArtifactId: string; agentId: AgentId; reason: string };

export interface ScoreBidInput {
  run: CoordinationRun;
  bid: Extract<CoordinationArtifact, { type: "session_bid" }>;
  /** Fully rendered prompt for each proposed execution assignment, in position order. */
  renderedExecutionPrompts: readonly string[];
  /** Conservative total input-token ceiling for this proposed execution. */
  contextCeilingInputTokens: number;
  availableAgentIds: ReadonlySet<AgentId>;
  remainingTurnCapacity: number;
  history?: AuctionScoreHistory;
}

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

/** Contract estimator: ceil UTF-8 bytes / 3, with sequential predecessor reserve. */
export const estimateExecutionInputTokens = (
  payload: SessionBidPayload,
  renderedPrompts: readonly string[],
): number => {
  const base = renderedPrompts.reduce((total, prompt) => total + Math.ceil(utf8Bytes(prompt) / 3), 0);
  if (payload.plan.mode !== "sequential") return base;
  // The v1 bid has one execution output allowance, so each earlier assignment
  // conservatively reserves that full allowance in every later prompt.
  const predecessorSlots = payload.plan.assignments.length * (payload.plan.assignments.length - 1) / 2;
  return base + predecessorSlots * payload.estimatedOutputTokens;
};

const latest = <T>(values: readonly T[], limit: number): readonly T[] =>
  values.slice(Math.max(0, values.length - limit));

export const confidencePenaltyBps = (
  declaredConfidenceBps: number,
  ratings: readonly AuctionRatingHistory[],
): number => {
  if (ratings.length < 5) return 500;
  const window = latest(ratings, 20);
  const accepted = window.filter((rating) => rating.accepted).length;
  const observedAcceptanceBps = Math.floor(accepted * 10_000 / window.length);
  return Math.min(2_500, Math.max(0, declaredConfidenceBps - observedAcceptanceBps));
};

export const reliabilityPenaltyBps = (
  executions: readonly AuctionExecutionHistory[],
): number => {
  const window = latest(executions, 20);
  if (window.length === 0) return 0;
  const failed = window.filter((execution) => execution.failed).length;
  const severeUnderestimates = window.filter((execution) =>
    execution.actualOutputTokens !== undefined &&
    execution.actualOutputTokens * 100 > execution.estimatedOutputTokens * 125,
  ).length;
  return Math.min(
    3_000,
    Math.floor(2_000 * failed / window.length) +
      Math.floor(1_000 * severeUnderestimates / window.length),
  );
};

const ineligible = (
  bid: ScoreBidInput["bid"],
  reason: string,
): BidEligibilityResult => ({
  eligible: false,
  bidArtifactId: bid.id,
  agentId: bid.createdByAgentId,
  reason,
});

export const scoreSessionBid = (input: ScoreBidInput): BidEligibilityResult => {
  const { run, bid } = input;
  const policy = run.policy.auctionPolicy;
  if (!policy || policy.scoringVersion !== "confidence_cost_v1") {
    return ineligible(bid, "Unsupported or missing auction scoring policy");
  }
  const assignments = bid.payload.plan.assignments;
  if (assignments.some(({ agentId }) => !input.availableAgentIds.has(agentId))) {
    return ineligible(bid, "Plan references an unavailable participant");
  }
  if (assignments.length > input.remainingTurnCapacity) {
    return ineligible(bid, "Plan exceeds the remaining session turn capacity");
  }
  if (bid.payload.plan.mode === "parallel" && assignments.length > resolveMaxParallelTurns(run)) {
    return ineligible(bid, "Plan exceeds the session concurrency limit");
  }
  if (bid.payload.estimatedOutputTokens > policy.auctionExecutionTokenBudget) {
    return ineligible(bid, "Plan exceeds the auction execution output budget");
  }
  if (
    input.renderedExecutionPrompts.length !== assignments.length ||
    !Number.isSafeInteger(input.contextCeilingInputTokens) ||
    input.contextCeilingInputTokens <= 0
  ) {
    return ineligible(bid, "Execution prompt estimate is unavailable");
  }

  const estimatedInputTokens = estimateExecutionInputTokens(
    bid.payload,
    input.renderedExecutionPrompts,
  );
  const projectedWeightedUnits =
    4 * estimatedInputTokens + 16 * bid.payload.estimatedOutputTokens;
  const ceilingUnits =
    4 * input.contextCeilingInputTokens + 16 * policy.auctionExecutionTokenBudget;
  const normalizedProjectedCostBps = Math.min(
    10_000,
    Math.floor(10_000 * projectedWeightedUnits / ceilingUnits),
  );
  const history = input.history ?? { ratings: [], executions: [] };
  const confidencePenalty = confidencePenaltyBps(bid.payload.confidenceBps, history.ratings);
  const calibratedConfidenceBps = Math.max(0, bid.payload.confidenceBps - confidencePenalty);
  const reliabilityPenalty = reliabilityPenaltyBps(history.executions);
  const rawScore = Math.floor((
    70 * calibratedConfidenceBps -
    25 * normalizedProjectedCostBps -
    5 * reliabilityPenalty
  ) / 100);
  const scoreBps = Math.max(0, Math.min(10_000, rawScore));
  return {
    eligible: true,
    score: {
      bidArtifactId: bid.id,
      agentId: bid.createdByAgentId,
      declaredConfidenceBps: bid.payload.confidenceBps,
      calibratedConfidenceBps,
      confidencePenaltyBps: confidencePenalty,
      normalizedProjectedCostBps,
      reliabilityPenaltyBps: reliabilityPenalty,
      estimatedInputTokens,
      estimatedOutputTokens: bid.payload.estimatedOutputTokens,
      projectedWeightedUnits,
      scoreBps,
      explanation:
        `confidence_cost_v1 ranked this valid bid at ${scoreBps} bps ` +
        `(calibrated confidence ${calibratedConfidenceBps}, normalized projected cost ` +
        `${normalizedProjectedCostBps}, reliability penalty ${reliabilityPenalty}).`,
    },
  };
};

export interface RankSessionBidsInput {
  run: CoordinationRun;
  bids: readonly ScoreBidInput[];
}

export type RankSessionBidsResult =
  | {
      kind: "ranked";
      winner: ScoredSessionBid;
      ranked: ScoredSessionBid[];
      ineligible: Array<Extract<BidEligibilityResult, { eligible: false }>>;
    }
  | {
      kind: "insufficient_valid_bids";
      validBidCount: number;
      requiredBidCount: number;
      ineligible: Array<Extract<BidEligibilityResult, { eligible: false }>>;
    };

export const rankSessionBids = (input: RankSessionBidsInput): RankSessionBidsResult => {
  const policy = input.run.policy.auctionPolicy;
  const results = input.bids.map(scoreSessionBid);
  const ineligible = results.filter(
    (result): result is Extract<BidEligibilityResult, { eligible: false }> => !result.eligible,
  );
  const ranked = results
    .filter((result): result is Extract<BidEligibilityResult, { eligible: true }> => result.eligible)
    .map(({ score }) => score)
    .sort((left, right) => {
      const leftIndex = input.run.participants.findIndex(({ agentId }) => agentId === left.agentId);
      const rightIndex = input.run.participants.findIndex(({ agentId }) => agentId === right.agentId);
      return right.scoreBps - left.scoreBps ||
        right.calibratedConfidenceBps - left.calibratedConfidenceBps ||
        left.projectedWeightedUnits - right.projectedWeightedUnits ||
        leftIndex - rightIndex ||
        left.agentId.localeCompare(right.agentId);
    });
  const required = policy?.minimumValidBids ?? Number.MAX_SAFE_INTEGER;
  if (ranked.length < required) {
    return {
      kind: "insufficient_valid_bids",
      validBidCount: ranked.length,
      requiredBidCount: required,
      ineligible,
    };
  }
  return { kind: "ranked", winner: ranked[0]!, ranked, ineligible };
};
