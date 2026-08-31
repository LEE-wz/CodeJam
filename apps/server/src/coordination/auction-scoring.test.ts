import { describe, expect, it } from "vitest";
import {
  confidencePenaltyBps,
  estimateExecutionInputTokens,
  rankSessionBids,
  reliabilityPenaltyBps,
  scoreSessionBid,
  type ScoreBidInput,
} from "./auction-scoring.js";
import type { CoordinationArtifact, CoordinationRun } from "./types.js";
import { DEFAULT_COORDINATION_POLICY, DEFAULT_SESSION_AUCTION_POLICY } from "./types.js";

const ids = ["agent-a", "agent-b", "agent-c"] as const;
const run: CoordinationRun = {
  id: "run-1",
  name: "Auction",
  objective: "Answer",
  requiredSections: [],
  participants: ids.map((agentId) => ({ role: "participant", agentId, agentNameSnapshot: agentId })),
  policy: {
    ...DEFAULT_COORDINATION_POLICY,
    workflow: "shared_session_v1",
    sessionProtocol: "free_chat",
    maxTurns: 20,
    maxParallelTurns: 2,
    auctionPolicy: { ...DEFAULT_SESSION_AUCTION_POLICY, minimumValidBids: 1 },
  },
  status: "running",
  phase: "sessioning",
  revision: 0,
  nextTurnSequence: 1,
  activeTurnIds: [],
  lastUserArtifactId: "user-1",
  version: 1,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

const bid = (
  agentId: string,
  overrides: Partial<Extract<CoordinationArtifact, { type: "session_bid" }>["payload"]> = {},
): Extract<CoordinationArtifact, { type: "session_bid" }> => ({
  id: `bid-${agentId}`,
  runId: run.id,
  turnId: `turn-${agentId}`,
  createdByRole: "participant",
  createdByAgentId: agentId,
  sizeChars: 100,
  createdAt: run.createdAt,
  type: "session_bid",
  payload: {
    schemaVersion: 1,
    type: "session_bid",
    recommendation: "auction",
    plan: {
      summary: "Answer once",
      mode: "single",
      assignments: [{ agentId, position: 1, instruction: "Answer" }],
      risks: [],
      assumptions: [],
    },
    confidenceBps: 8_000,
    estimatedOutputTokens: 1_000,
    ...overrides,
  },
});

const scoreInput = (artifact = bid(ids[0])): ScoreBidInput => ({
  run,
  bid: artifact,
  renderedExecutionPrompts: ["abc"],
  contextCeilingInputTokens: 10_000,
  availableAgentIds: new Set(ids),
  remainingTurnCapacity: 10,
});

describe("confidence_cost_v1", () => {
  it("uses exact UTF-8 byte rounding and sequential predecessor reserves", () => {
    const payload = bid(ids[0], {
      plan: {
        summary: "Three",
        mode: "sequential",
        assignments: ids.map((agentId, index) => ({ agentId, position: index + 1, instruction: "x" })),
        risks: [], assumptions: [],
      },
      estimatedOutputTokens: 100,
    }).payload;
    expect(estimateExecutionInputTokens(payload, ["abc", "é", "四"])).toBe(303);
  });

  it("applies cold-start, latest-20 calibration, and bounded reliability exactly", () => {
    expect(confidencePenaltyBps(8_000, Array.from({ length: 4 }, () => ({ accepted: true })))).toBe(500);
    expect(confidencePenaltyBps(8_000, Array.from({ length: 20 }, (_, i) => ({ accepted: i < 10 })))).toBe(2_500);
    expect(reliabilityPenaltyBps([])).toBe(0);
    expect(reliabilityPenaltyBps([
      { failed: true, estimatedOutputTokens: 100, actualOutputTokens: 126 },
      { failed: false, estimatedOutputTokens: 100, actualOutputTokens: 125 },
    ])).toBe(1_500);
  });

  it("snapshot-tests integer score components and a raw-output-free explanation", () => {
    const result = scoreSessionBid(scoreInput());
    expect(result).toEqual({
      eligible: true,
      score: {
        bidArtifactId: "bid-agent-a",
        agentId: "agent-a",
        declaredConfidenceBps: 8000,
        calibratedConfidenceBps: 7500,
        confidencePenaltyBps: 500,
        normalizedProjectedCostBps: 1538,
        reliabilityPenaltyBps: 0,
        estimatedInputTokens: 1,
        estimatedOutputTokens: 1000,
        projectedWeightedUnits: 16004,
        scoreBps: 4865,
        explanation: "confidence_cost_v1 ranked this valid bid at 4865 bps (calibrated confidence 7500, normalized projected cost 1538, reliability penalty 0).",
      },
    });
  });

  it.each([
    ["unavailable assignment", { availableAgentIds: new Set([ids[1], ids[2]]) }],
    ["turn ceiling", { remainingTurnCapacity: 0 }],
    ["missing prompt estimate", { renderedExecutionPrompts: [] }],
  ])("rejects %s before ranking", (_label, overrides) => {
    expect(scoreSessionBid({ ...scoreInput(), ...overrides })).toMatchObject({ eligible: false });
  });

  it("rejects parallel plans above the concurrency cap", () => {
    const artifact = bid(ids[0], {
      plan: {
        summary: "Too wide", mode: "parallel",
        assignments: ids.map((agentId, index) => ({ agentId, position: index + 1, instruction: "x" })),
        risks: [], assumptions: [],
      },
    });
    expect(scoreSessionBid({
      ...scoreInput(artifact), renderedExecutionPrompts: ["a", "b", "c"],
    })).toMatchObject({ eligible: false, reason: "Plan exceeds the session concurrency limit" });
  });

  it("uses confidence, cost, roster position, then Agent ID as stable ties", () => {
    const inputs = [ids[1], ids[0]].map((agentId) => scoreInput(bid(agentId)));
    const ranked = rankSessionBids({ run, bids: inputs });
    expect(ranked.kind).toBe("ranked");
    if (ranked.kind === "ranked") {
      expect(ranked.ranked.map(({ agentId }) => agentId)).toEqual([ids[0], ids[1]]);
    }
  });

  it("returns the configured minimum-valid-bid fallback boundary", () => {
    const strictRun = {
      ...run,
      policy: {
        ...run.policy,
        auctionPolicy: { ...DEFAULT_SESSION_AUCTION_POLICY, minimumValidBids: 2 },
      },
    };
    expect(rankSessionBids({ run: strictRun, bids: [{ ...scoreInput(), run: strictRun }] }))
      .toMatchObject({ kind: "insufficient_valid_bids", validBidCount: 1, requiredBidCount: 2 });
  });

  it("rejects a bid whose run declares an unsupported scoring version", () => {
    const foreignRun = {
      ...run,
      policy: {
        ...run.policy,
        auctionPolicy: {
          ...DEFAULT_SESSION_AUCTION_POLICY,
          scoringVersion: "confidence_cost_v2" as unknown as "confidence_cost_v1",
        },
      },
    };
    expect(scoreSessionBid({ ...scoreInput(), run: foreignRun })).toMatchObject({
      eligible: false,
      reason: "Unsupported or missing auction scoring policy",
    });
  });

  it("ranks the same field identically whatever order the bids arrive in", () => {
    const forward = [ids[0], ids[1], ids[2]].map((agentId) => scoreInput(bid(agentId)));
    const reversed = [...forward].reverse();
    const rankedForward = rankSessionBids({ run, bids: forward });
    const rankedReversed = rankSessionBids({ run, bids: reversed });
    expect(rankedForward.kind).toBe("ranked");
    if (rankedForward.kind === "ranked" && rankedReversed.kind === "ranked") {
      // Only stored participant order and Agent ID break ties, so the input
      // array order cannot change the winner.
      expect(rankedReversed.ranked.map(({ agentId }) => agentId)).toEqual(
        rankedForward.ranked.map(({ agentId }) => agentId),
      );
      expect(rankedReversed.winner.scoreBps).toBe(rankedForward.winner.scoreBps);
    }
  });
});
