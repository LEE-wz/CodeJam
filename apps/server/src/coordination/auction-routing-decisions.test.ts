import { describe, expect, it } from "vitest";
import type { WorkflowView } from "./contracts.js";
import { SharedSessionWorkflowV1 } from "./session-workflow.js";
import {
  PARTICIPANT_ONE,
  PARTICIPANT_THREE,
  PARTICIPANT_TWO,
} from "./testing/session-fixtures.js";
import {
  DEFAULT_COORDINATION_POLICY,
  DEFAULT_SESSION_AUCTION_POLICY,
} from "./types.js";
import type {
  CoordinationArtifact,
  CoordinationRun,
  CoordinationTurn,
  SessionAuctionPolicy,
  SessionAwardPayload,
  SessionBidPayload,
  SessionMessageRouting,
} from "./types.js";

const now = "2026-08-31T00:00:00.000Z";
const RUN_ID = "run-session";
const USER_ID = "user-artifact-1";
const AGENTS = [PARTICIPANT_ONE, PARTICIPANT_TWO, PARTICIPANT_THREE];

const workflow = new SharedSessionWorkflowV1();

const run = (
  auctionPolicy: Partial<SessionAuctionPolicy>,
  overrides: Partial<CoordinationRun> = {},
): CoordinationRun => ({
  id: RUN_ID,
  name: "Session",
  objective: "Work together",
  requiredSections: [],
  participants: AGENTS.map((agent) => ({
    role: "participant" as const,
    agentId: agent.id,
    agentNameSnapshot: agent.name,
  })),
  policy: {
    ...DEFAULT_COORDINATION_POLICY,
    workflow: "shared_session_v1",
    sessionProtocol: "free_chat",
    maxTurns: 20,
    auctionPolicy: { ...DEFAULT_SESSION_AUCTION_POLICY, ...auctionPolicy },
  },
  status: "running",
  phase: "sessioning",
  revision: 0,
  nextTurnSequence: 1,
  activeTurnIds: [],
  lastUserArtifactId: USER_ID,
  version: 3,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const userMessage = (routing?: SessionMessageRouting): CoordinationArtifact => ({
  id: USER_ID,
  runId: RUN_ID,
  type: "user_message",
  payload: {
    schemaVersion: 1,
    type: "user_message",
    content: "Review the deployment plan",
  },
  createdBy: { kind: "user" },
  ...(routing === undefined ? {} : { routing }),
  transcriptSequence: 1,
  sizeChars: 26,
  createdAt: now,
});

const bidPlan = (
  mode: SessionBidPayload["plan"]["mode"],
  agentIds: readonly string[],
): SessionBidPayload["plan"] => ({
  summary: "Split the work.",
  mode,
  assignments: agentIds.map((agentId, index) => ({
    agentId,
    position: index + 1,
    instruction: `Handle part ${index + 1}.`,
  })),
  risks: [],
  assumptions: [],
});

const bid = (
  index: number,
  agentId: string,
  plan: SessionBidPayload["plan"],
): { turn: CoordinationTurn; artifact: CoordinationArtifact } => {
  const payload: SessionBidPayload = {
    schemaVersion: 1,
    type: "session_bid",
    recommendation: "auction",
    plan,
    confidenceBps: 7_000,
    estimatedOutputTokens: 900,
  };
  return {
    turn: {
      id: `turn-bid-${index}`,
      runId: RUN_ID,
      sequence: index,
      role: "participant",
      agentId,
      kind: "session_bid",
      wavePurpose: "session_bidding",
      status: "committed",
      attemptCount: 1,
      inputArtifactIds: [USER_ID],
      outputArtifactId: `artifact-bid-${index}`,
      lastValidationErrors: [],
      createdAt: now,
      completedAt: now,
    },
    artifact: {
      id: `artifact-bid-${index}`,
      runId: RUN_ID,
      turnId: `turn-bid-${index}`,
      createdByRole: "participant",
      createdByAgentId: agentId,
      type: "session_bid",
      payload,
      sizeChars: 128,
      createdAt: now,
    },
  };
};

const award = (
  overrides: Partial<SessionAwardPayload> = {},
  createdAt = now,
): CoordinationArtifact => ({
  id: `award-${overrides.userArtifactId ?? USER_ID}`,
  runId: RUN_ID,
  type: "session_award",
  createdBy: { kind: "system" },
  payload: {
    schemaVersion: 1,
    type: "session_award",
    userArtifactId: USER_ID,
    winningBidArtifactId: "artifact-bid-1",
    selectedAgentId: PARTICIPANT_ONE.id,
    outcome: "execute_plan",
    scoringVersion: "confidence_cost_v1",
    scoreBps: 5_000,
    components: {
      calibratedConfidenceBps: 6_500,
      normalizedProjectedCostBps: 500,
      reliabilityPenaltyBps: 0,
    },
    estimatedExecution: { inputTokens: 1_000, outputTokens: 900 },
    ...overrides,
  },
  sizeChars: 256,
  createdAt,
});

const executionTurn = (
  index: number,
  agentId: string,
  status: CoordinationTurn["status"],
  awardId: string,
): CoordinationTurn => ({
  id: `turn-exec-${index}`,
  runId: RUN_ID,
  sequence: 10 + index,
  role: "participant",
  agentId,
  kind: "session_turn",
  wavePurpose: "session_execution",
  status,
  attemptCount: 1,
  inputArtifactIds: [USER_ID, awardId],
  ...(status === "committed" ? { outputArtifactId: `artifact-msg-${index}` } : {}),
  lastValidationErrors: [],
  createdAt: now,
  completedAt: now,
});

const executionMessage = (index: number, agentId: string): CoordinationArtifact => ({
  id: `artifact-msg-${index}`,
  runId: RUN_ID,
  turnId: `turn-exec-${index}`,
  createdByRole: "participant",
  createdByAgentId: agentId,
  type: "session_message",
  payload: { schemaVersion: 1, type: "session_message", content: `part ${index}` },
  transcriptSequence: 10 + index,
  sizeChars: 6,
  createdAt: now,
});

const view = (
  runRecord: CoordinationRun,
  turns: CoordinationTurn[],
  artifacts: CoordinationArtifact[],
  availableAgentIds?: string[],
): WorkflowView => ({
  run: { ...runRecord, nextTurnSequence: Math.max(1, ...turns.map(({ sequence }) => sequence)) + 1 },
  turns,
  artifacts,
  ...(availableAgentIds === undefined ? {} : { availableAgentIds }),
});

describe("PA14-20 routing decisions", () => {
  it("routes an explicit direct session to one execution turn and no bid wave", () => {
    const decision = workflow.decideNext(
      view(run({ routingMode: "direct" }), [], [userMessage()]),
    );
    expect(decision).toMatchObject({
      kind: "schedule",
      turnKind: "session_turn",
      expectedArtifactType: "session_message",
      agentId: PARTICIPANT_ONE.id,
    });
  });

  it("escalates a failed direct turn into one bounded auction when explicitly enabled", () => {
    const failedDirect = {
      ...executionTurn(1, PARTICIPANT_ONE.id, "failed", "unused-award"),
      inputArtifactIds: [USER_ID],
    };
    const decision = workflow.decideNext(
      view(
        run({ routingMode: "direct", auctionOnDirectFailure: true }),
        [failedDirect],
        [userMessage()],
      ),
    );
    expect(decision).toMatchObject({
      kind: "schedule_wave",
      wavePurpose: "session_bidding",
    });
    expect((decision as { members: unknown[] }).members).toHaveLength(AGENTS.length);
  });

  it("fails a direct round without a hidden auction when escalation is disabled", () => {
    const failedDirect = {
      ...executionTurn(1, PARTICIPANT_ONE.id, "failed", "unused-award"),
      inputArtifactIds: [USER_ID],
    };
    expect(workflow.decideNext(
      view(
        run({ routingMode: "direct", auctionOnDirectFailure: false }),
        [failedDirect],
        [userMessage()],
      ),
    )).toMatchObject({ kind: "fail", code: "MAX_ATTEMPTS_EXCEEDED" });
  });

  it("uses the service availability snapshot for production primary selection", () => {
    const decision = workflow.decideNext(
      view(
        run({ routingMode: "auto" }),
        [],
        [userMessage()],
        [PARTICIPANT_THREE.id],
      ),
    );
    expect(decision).toMatchObject({
      kind: "schedule",
      turnKind: "session_bid",
      agentId: PARTICIPANT_THREE.id,
    });
  });

  it("lets a message request an auction for its own round without changing policy", () => {
    const decision = workflow.decideNext(
      view(
        run({ routingMode: "direct" }),
        [],
        [userMessage({ routingMode: "auction" })],
      ),
    );
    expect(decision).toMatchObject({ kind: "schedule_wave", wavePurpose: "session_bidding" });
    expect((decision as { members: unknown[] }).members).toHaveLength(AGENTS.length);
  });

  it("forces an auction for a high-risk message even under Auto routing", () => {
    // The repository normalizes riskLevel high to routingMode auction, which is
    // what the workflow then reads.
    const decision = workflow.decideNext(
      view(
        run({ routingMode: "auto" }),
        [],
        [userMessage({ routingMode: "auction", riskLevel: "high" })],
      ),
    );
    expect(decision).toMatchObject({ kind: "schedule_wave", wavePurpose: "session_bidding" });
  });

  it("honours an explicitly selected Agent for a direct round", () => {
    const decision = workflow.decideNext(
      view(
        run({ routingMode: "direct" }),
        [],
        [userMessage({ selectedAgentId: PARTICIPANT_THREE.id })],
      ),
    );
    expect(decision).toMatchObject({ kind: "schedule", agentId: PARTICIPANT_THREE.id });
  });

  it("gives the follow-up round to the previously awarded Agent", () => {
    const previousAward = award({ userArtifactId: "user-artifact-0" }, "2026-08-30T00:00:00.000Z");
    (previousAward as { id: string }).id = "award-previous";
    (previousAward.payload as SessionAwardPayload).selectedAgentId = PARTICIPANT_TWO.id;
    const decision = workflow.decideNext(
      view(run({ routingMode: "auto" }), [], [userMessage(), previousAward]),
    );
    expect(decision).toMatchObject({
      kind: "schedule",
      turnKind: "session_bid",
      agentId: PARTICIPANT_TWO.id,
    });
  });

  it("resolves the auction once every bid opportunity has settled", () => {
    const bids = AGENTS.map((agent, index) =>
      bid(index + 1, agent.id, bidPlan("single", [agent.id])),
    );
    const decision = workflow.decideNext(
      view(
        run({ routingMode: "auction" }),
        bids.map(({ turn }) => turn),
        [userMessage(), ...bids.map(({ artifact }) => artifact)],
      ),
    );
    expect(decision).toMatchObject({
      kind: "resolve_auction",
      userArtifactId: USER_ID,
      bidArtifactIds: ["artifact-bid-1", "artifact-bid-2", "artifact-bid-3"],
    });
  });
});

describe("PA14-11 and PA14-12 awarded execution", () => {
  const singleBid = bid(1, PARTICIPANT_ONE.id, bidPlan("single", [PARTICIPANT_ONE.id]));

  it("schedules the single winner with the award as an explicit input", () => {
    const committed = award();
    const decision = workflow.decideNext(
      view(
        run({ routingMode: "auction" }),
        [singleBid.turn],
        [userMessage(), singleBid.artifact, committed],
      ),
    );
    expect(decision).toMatchObject({
      kind: "schedule",
      turnKind: "session_turn",
      agentId: PARTICIPANT_ONE.id,
    });
    // The award is on the turn's inputs, which is how the winning plan reaches
    // the prompt. No losing bid is referenced.
    expect((decision as { inputArtifactIds: string[] }).inputArtifactIds).toContain(committed.id);
    expect((decision as { inputArtifactIds: string[] }).inputArtifactIds).not.toContain(
      "artifact-bid-2",
    );
  });

  it("schedules a sequential plan strictly by position, one assignment at a time", () => {
    const sequential = bid(
      1,
      PARTICIPANT_ONE.id,
      bidPlan("sequential", [PARTICIPANT_TWO.id, PARTICIPANT_THREE.id]),
    );
    const committed = award();
    const first = workflow.decideNext(
      view(
        run({ routingMode: "auction" }),
        [sequential.turn],
        [userMessage(), sequential.artifact, committed],
      ),
    );
    expect(first).toMatchObject({ kind: "schedule", agentId: PARTICIPANT_TWO.id });

    const second = workflow.decideNext(
      view(
        run({ routingMode: "auction" }),
        [
          sequential.turn,
          executionTurn(1, PARTICIPANT_TWO.id, "committed", committed.id),
        ],
        [
          userMessage(),
          sequential.artifact,
          committed,
          executionMessage(1, PARTICIPANT_TWO.id),
        ],
      ),
    );
    // The second Agent runs only after the first committed. Phase 15 pins that
    // message through the inclusive transcript sequence instead of copying its
    // artifact id into every later turn.
    expect(second).toMatchObject({ kind: "schedule", agentId: PARTICIPANT_THREE.id });
    expect(second).toMatchObject({
      inputArtifactIds: [USER_ID, committed.id],
      inputThroughSequence: 11,
    });
  });

  it("schedules a parallel plan as one bounded execution wave", () => {
    const parallel = bid(
      1,
      PARTICIPANT_ONE.id,
      bidPlan("parallel", [PARTICIPANT_ONE.id, PARTICIPANT_TWO.id, PARTICIPANT_THREE.id]),
    );
    const decision = workflow.decideNext(
      view(
        run({ routingMode: "auction" }),
        [parallel.turn],
        [userMessage(), parallel.artifact, award()],
      ),
    );
    expect(decision).toMatchObject({ kind: "schedule_wave", wavePurpose: "session_execution" });
    expect((decision as { members: Array<{ agentId: string }> }).members.map(
      ({ agentId }) => agentId,
    )).toEqual(AGENTS.map(({ id }) => id));
  });

  it("returns to the user once every assignment has committed", () => {
    const committed = award();
    const decision = workflow.decideNext(
      view(
        run({ routingMode: "auction" }),
        [singleBid.turn, executionTurn(1, PARTICIPANT_ONE.id, "committed", committed.id)],
        [
          userMessage(),
          singleBid.artifact,
          committed,
          executionMessage(1, PARTICIPANT_ONE.id),
        ],
      ),
    );
    expect(decision).toEqual({ kind: "await_input" });
  });

  it("never re-ranks after an award: a failed winner fails the round", () => {
    const committed = award();
    const decision = workflow.decideNext(
      view(
        run({ routingMode: "auction" }),
        [singleBid.turn, executionTurn(1, PARTICIPANT_ONE.id, "failed", committed.id)],
        [userMessage(), singleBid.artifact, committed],
      ),
    );
    expect(decision).toMatchObject({ kind: "fail", code: "MAX_ATTEMPTS_EXCEEDED" });
  });

  it("schedules an ordinary execution turn for a fallback award", () => {
    const fallback = award({
      winningBidArtifactId: undefined,
      selectedAgentId: PARTICIPANT_THREE.id,
      outcome: "fallback_execution",
      fallback: "round_robin",
      scoreBps: 0,
    });
    delete (fallback.payload as SessionAwardPayload).winningBidArtifactId;
    const decision = workflow.decideNext(
      view(run({ routingMode: "auction" }), [], [userMessage(), fallback]),
    );
    expect(decision).toMatchObject({
      kind: "schedule",
      turnKind: "session_turn",
      agentId: PARTICIPANT_THREE.id,
    });
  });

  it("returns to the user immediately after a published direct candidate", () => {
    const published = award({ outcome: "publish_candidate" });
    const projection: CoordinationArtifact = {
      id: "artifact-published",
      runId: RUN_ID,
      turnId: "turn-bid-1",
      createdByRole: "participant",
      createdByAgentId: PARTICIPANT_ONE.id,
      type: "session_message",
      payload: { schemaVersion: 1, type: "session_message", content: "answer" },
      sourceBidArtifactId: "artifact-bid-1",
      transcriptSequence: 5,
      sizeChars: 6,
      createdAt: now,
    };
    const directBid = bid(1, PARTICIPANT_ONE.id, bidPlan("single", [PARTICIPANT_ONE.id]));
    (directBid.artifact.payload as SessionBidPayload).candidateAnswer = "answer";
    const decision = workflow.decideNext(
      view(
        run({ routingMode: "auto" }),
        [directBid.turn],
        [userMessage(), directBid.artifact, published, projection],
      ),
    );
    expect(decision).toEqual({ kind: "await_input" });
  });
});

describe("PA14-23 restart derivation", () => {
  it("re-derives the same execution decision after a restart mid-execution", () => {
    const singleBid = bid(1, PARTICIPANT_ONE.id, bidPlan("single", [PARTICIPANT_ONE.id]));
    const committed = award();
    const before = workflow.decideNext(
      view(
        run({ routingMode: "auction" }),
        [singleBid.turn],
        [userMessage(), singleBid.artifact, committed],
      ),
    );
    // A restart loses in-memory state entirely; the same committed evidence
    // must produce the identical next action.
    const after = workflow.decideNext(
      view(
        run({ routingMode: "auction" }, { version: 99 }),
        [singleBid.turn],
        [userMessage(), singleBid.artifact, committed],
      ),
    );
    expect(after).toEqual(before);
  });

  it("rejects a view carrying two awards for the same user message", () => {
    const first = award();
    const second = { ...award(), id: "award-duplicate" };
    const decision = workflow.decideNext(
      view(run({ routingMode: "auction" }), [], [userMessage(), first, second]),
    );
    expect(decision).toMatchObject({ kind: "fail", code: "INVALID_STATE" });
  });
});
