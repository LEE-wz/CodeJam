import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import type { Agent } from "../types.js";
import { DurableCoordinationRepository } from "./repository.js";
import { AdvancingClock, DeterministicIdGenerator } from "./testing/controls.js";
import {
  PARTICIPANT_ONE,
  PARTICIPANT_THREE,
  PARTICIPANT_TWO,
} from "./testing/session-fixtures.js";
import { buildAuctionHistory, resolveAuction } from "./auction-resolution.js";
import { RoleScopedContextBuilder } from "./context-builder.js";
import {
  DEFAULT_COORDINATION_POLICY,
  DEFAULT_SESSION_AUCTION_POLICY,
  SESSION_CONTEXT_MAX_CHARS,
} from "./types.js";
import type {
  CoordinationArtifact,
  CoordinationRun,
  CoordinationTurn,
  SessionAuctionPolicy,
  SessionBidPayload,
} from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const PARTICIPANTS = [PARTICIPANT_ONE, PARTICIPANT_TWO, PARTICIPANT_THREE];
const RUN_ID = "run-auction";
const USER_ARTIFACT_ID = "artifact-user-1";
const NOW = "2026-08-31T00:00:00.000Z";

const agentRow = (id: string, name: string): Agent => ({
  id,
  name,
  description: "",
  instructions: "",
  status: "ready",
  workspacePath: `/workspaces/${id}`,
  codexThreadId: null,
  lastError: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const auctionRun = (
  auctionPolicy: Partial<SessionAuctionPolicy> = {},
  overrides: Partial<CoordinationRun> = {},
): CoordinationRun => ({
  id: RUN_ID,
  name: "Auction session",
  objective: "Answer the user together.",
  requiredSections: [],
  participants: PARTICIPANTS.map((agent) => ({
    role: "participant" as const,
    agentId: agent.id,
    agentNameSnapshot: agent.name,
  })),
  policy: {
    ...DEFAULT_COORDINATION_POLICY,
    workflow: "shared_session_v1",
    maxRevisions: 0,
    maxTurns: 20,
    contextMaxChars: SESSION_CONTEXT_MAX_CHARS,
    sessionProtocol: "free_chat",
    auctionPolicy: { ...DEFAULT_SESSION_AUCTION_POLICY, ...auctionPolicy },
  },
  status: "running",
  phase: "sessioning",
  revision: 0,
  nextTurnSequence: 4,
  activeTurnIds: [],
  lastUserArtifactId: USER_ARTIFACT_ID,
  version: 5,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const userArtifact = (): CoordinationArtifact => ({
  id: USER_ARTIFACT_ID,
  runId: RUN_ID,
  type: "user_message",
  payload: { schemaVersion: 1, type: "user_message", content: "Summarise the launch risks." },
  createdBy: { kind: "user" },
  transcriptSequence: 1,
  sizeChars: 26,
  createdAt: NOW,
});

const bidPayload = (
  agentId: string,
  overrides: Partial<SessionBidPayload> = {},
): SessionBidPayload => ({
  schemaVersion: 1,
  type: "session_bid",
  recommendation: "auction",
  plan: {
    summary: "Answer with one specialist.",
    mode: "single",
    assignments: [{ agentId, position: 1, instruction: "Answer the request." }],
    risks: [],
    assumptions: [],
  },
  confidenceBps: 7_000,
  estimatedOutputTokens: 1_000,
  ...overrides,
});

const bidTurn = (index: number, agentId: string): CoordinationTurn => ({
  id: `turn-bid-${index}`,
  runId: RUN_ID,
  sequence: index,
  role: "participant",
  agentId,
  kind: "session_bid",
  wavePurpose: "session_bidding",
  status: "committed",
  attemptCount: 1,
  activeAttemptId: undefined,
  inputArtifactIds: [USER_ARTIFACT_ID],
  outputArtifactId: `artifact-bid-${index}`,
  lastValidationErrors: [],
  createdAt: NOW,
  completedAt: NOW,
});

const bidArtifact = (
  index: number,
  agentId: string,
  payload: SessionBidPayload,
): CoordinationArtifact => ({
  id: `artifact-bid-${index}`,
  runId: RUN_ID,
  turnId: `turn-bid-${index}`,
  createdByRole: "participant",
  createdByAgentId: agentId,
  type: "session_bid",
  payload,
  sizeChars: JSON.stringify(payload).length,
  createdAt: NOW,
});

interface Harness {
  store: JsonStore;
  repository: DurableCoordinationRepository;
}

const createHarness = async (
  run: CoordinationRun,
  turns: CoordinationTurn[],
  artifacts: CoordinationArtifact[],
): Promise<Harness> => {
  const root = await mkdtemp(path.join(tmpdir(), "relay-auction-award-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    for (const agent of PARTICIPANTS) database.agents.push(agentRow(agent.id, agent.name));
    database.coordinationRuns.push(structuredClone(run));
    database.coordinationTurns.push(...structuredClone(turns));
    database.coordinationArtifacts.push(...structuredClone(artifacts));
  });
  return {
    store,
    repository: new DurableCoordinationRepository({
      store,
      clock: new AdvancingClock(),
      ids: new DeterministicIdGenerator(),
    }),
  };
};

const AWARD_COMMAND = {
  userArtifactId: USER_ARTIFACT_ID,
  winningBidArtifactId: "artifact-bid-1",
  selectedAgentId: PARTICIPANT_ONE.id,
  outcome: "execute_plan" as const,
  scoringVersion: "confidence_cost_v1" as const,
  scoreBps: 4_200,
  components: {
    calibratedConfidenceBps: 6_500,
    normalizedProjectedCostBps: 900,
    reliabilityPenaltyBps: 0,
  },
  estimatedExecution: { inputTokens: 2_400, outputTokens: 1_000 },
};

const settledRound = (): {
  run: CoordinationRun;
  turns: CoordinationTurn[];
  artifacts: CoordinationArtifact[];
} => ({
  run: auctionRun({ routingMode: "auction" }),
  turns: PARTICIPANTS.map((agent, index) => bidTurn(index + 1, agent.id)),
  artifacts: [
    userArtifact(),
    ...PARTICIPANTS.map((agent, index) =>
      bidArtifact(index + 1, agent.id, bidPayload(agent.id)),
    ),
  ],
});

describe("PA14-09 durable session award", () => {
  it("commits exactly one award per user message under competing calls", async () => {
    const round = settledRound();
    const { repository } = await createHarness(round.run, round.turns, round.artifacts);

    const [first, second] = await Promise.all([
      repository.awardSessionBid({
        runId: RUN_ID,
        expectedRunVersion: round.run.version,
        ...AWARD_COMMAND,
      }),
      repository.awardSessionBid({
        runId: RUN_ID,
        expectedRunVersion: round.run.version,
        ...AWARD_COMMAND,
        winningBidArtifactId: "artifact-bid-2",
        selectedAgentId: PARTICIPANT_TWO.id,
      }),
    ]);

    // One caller wins outright; the other observes the committed award and
    // changes nothing.
    const kinds = [first!.kind, second!.kind].sort();
    expect(kinds).toEqual(["already_awarded", "awarded"]);

    const details = await repository.getRunDetails(RUN_ID);
    const awards = details!.artifacts.filter(({ type }) => type === "session_award");
    expect(awards).toHaveLength(1);
    expect(awards[0]).toMatchObject({
      type: "session_award",
      createdBy: { kind: "system" },
      payload: {
        userArtifactId: USER_ARTIFACT_ID,
        selectedAgentId: PARTICIPANT_ONE.id,
        outcome: "execute_plan",
        scoringVersion: "confidence_cost_v1",
      },
    });
    expect(
      details!.events.filter(({ type }) => type === "award.created"),
    ).toHaveLength(1);
  });

  it("is a no-op when a restarted loop replays the award at a stale version", async () => {
    const round = settledRound();
    const { repository } = await createHarness(round.run, round.turns, round.artifacts);

    const first = await repository.awardSessionBid({
      runId: RUN_ID,
      expectedRunVersion: round.run.version,
      ...AWARD_COMMAND,
    });
    expect(first.kind).toBe("awarded");

    // A restarted loop re-derives the same command from committed evidence and
    // still holds the pre-award version.
    const replay = await repository.awardSessionBid({
      runId: RUN_ID,
      expectedRunVersion: round.run.version,
      ...AWARD_COMMAND,
    });
    expect(replay.kind).toBe("already_awarded");

    const details = await repository.getRunDetails(RUN_ID);
    expect(details!.artifacts.filter(({ type }) => type === "session_award")).toHaveLength(1);
    expect(details!.run.version).toBe(round.run.version + 1);
  });

  it("rejects an award naming a bid from another round", async () => {
    const round = settledRound();
    round.turns[1] = { ...round.turns[1]!, inputArtifactIds: ["artifact-user-0"] };
    const { repository } = await createHarness(round.run, round.turns, round.artifacts);

    const result = await repository.awardSessionBid({
      runId: RUN_ID,
      expectedRunVersion: round.run.version,
      ...AWARD_COMMAND,
      winningBidArtifactId: "artifact-bid-2",
      selectedAgentId: PARTICIPANT_TWO.id,
    });
    expect(result).toMatchObject({ kind: "invalid" });
  });

  it("rejects an award whose selected Agent did not author the winning bid", async () => {
    const round = settledRound();
    const { repository } = await createHarness(round.run, round.turns, round.artifacts);

    const result = await repository.awardSessionBid({
      runId: RUN_ID,
      expectedRunVersion: round.run.version,
      ...AWARD_COMMAND,
      selectedAgentId: PARTICIPANT_THREE.id,
    });
    expect(result).toMatchObject({ kind: "invalid" });
  });

  it("rejects a fallback award that also names a winning bid", async () => {
    const round = settledRound();
    const { repository } = await createHarness(round.run, round.turns, round.artifacts);

    const result = await repository.awardSessionBid({
      runId: RUN_ID,
      expectedRunVersion: round.run.version,
      ...AWARD_COMMAND,
      outcome: "fallback_execution",
      fallback: "round_robin",
    });
    expect(result).toMatchObject({ kind: "invalid" });
  });
});

describe("PA14-10 atomic direct-candidate publication", () => {
  const directRound = () => {
    const payload = bidPayload(PARTICIPANT_ONE.id, {
      recommendation: "direct",
      candidateAnswer: "  The three launch risks are scope, staffing, and latency.  ",
      confidenceBps: 9_000,
      estimatedOutputTokens: 500,
    });
    return {
      run: auctionRun(),
      turns: [bidTurn(1, PARTICIPANT_ONE.id)],
      artifacts: [userArtifact(), bidArtifact(1, PARTICIPANT_ONE.id, payload)],
    };
  };

  it("commits the award and its transcript projection in one mutation", async () => {
    const round = directRound();
    const { repository } = await createHarness(round.run, round.turns, round.artifacts);

    const result = await repository.awardSessionBid({
      runId: RUN_ID,
      expectedRunVersion: round.run.version,
      ...AWARD_COMMAND,
      outcome: "publish_candidate",
    });
    expect(result.kind).toBe("awarded");

    const details = await repository.getRunDetails(RUN_ID);
    const award = details!.artifacts.find(({ type }) => type === "session_award");
    const published = details!.artifacts.find(
      (artifact) => artifact.type === "session_message",
    );
    expect(award).toBeDefined();
    expect(published).toMatchObject({
      type: "session_message",
      sourceBidArtifactId: "artifact-bid-1",
      createdByAgentId: PARTICIPANT_ONE.id,
      // Publication normalizes whitespace and cannot alter the candidate text.
      payload: { content: "The three launch risks are scope, staffing, and latency." },
      transcriptSequence: 2,
    });
    // The run advanced exactly one version for both writes together.
    expect(details!.run.version).toBe(round.run.version + 1);
    expect(details!.events.filter(({ type }) => type === "award.created")).toHaveLength(1);
    expect(
      details!.events.filter(({ type }) => type === "bid.candidate_published"),
    ).toHaveLength(1);
  });

  it("publishes exactly one candidate under a competing direct-award collision", async () => {
    const round = directRound();
    const { repository } = await createHarness(round.run, round.turns, round.artifacts);
    const command = {
      runId: RUN_ID,
      expectedRunVersion: round.run.version,
      ...AWARD_COMMAND,
      outcome: "publish_candidate" as const,
    };

    const results = await Promise.all([
      repository.awardSessionBid(command),
      repository.awardSessionBid(command),
    ]);
    expect(results.map(({ kind }) => kind).sort()).toEqual(["already_awarded", "awarded"]);

    const details = await repository.getRunDetails(RUN_ID);
    expect(details!.artifacts.filter(({ type }) => type === "session_award")).toHaveLength(1);
    expect(details!.artifacts.filter(({ type }) => type === "session_message")).toHaveLength(1);
    expect(details!.events.filter(({ type }) => type === "bid.candidate_published")).toHaveLength(1);
  });

  it("scores an Auto-direct award without applying the competitive bid minimum", () => {
    const round = directRound();
    const resolution = resolveAuction({
      run: round.run,
      turns: round.turns,
      artifacts: round.artifacts,
      decision: {
        kind: "resolve_auction",
        userArtifactId: USER_ARTIFACT_ID,
        bidArtifactIds: ["artifact-bid-1"],
        directCandidateBidArtifactId: "artifact-bid-1",
      },
      contextBuilder: new RoleScopedContextBuilder(),
    });

    expect(resolution.kind).toBe("award");
    if (resolution.kind !== "award") return;
    expect(resolution.command).toMatchObject({
      outcome: "publish_candidate",
      scoreBps: expect.any(Number),
      components: {
        // 9,000 declared confidence minus the documented 500-bps cold start.
        calibratedConfidenceBps: 8_500,
        normalizedProjectedCostBps: expect.any(Number),
        reliabilityPenaltyBps: 0,
      },
      estimatedExecution: {
        inputTokens: expect.any(Number),
        outputTokens: 500,
      },
    });
    expect(resolution.command.scoreBps).toBeGreaterThan(0);
    expect(resolution.command.components.normalizedProjectedCostBps).toBeGreaterThan(0);
    expect(resolution.command.estimatedExecution.inputTokens).toBeGreaterThan(0);
  });

  it("refuses publication when the candidate no longer passes its gates", async () => {
    const round = directRound();
    round.run.policy.auctionPolicy!.directConfidenceThresholdBps = 9_500;
    const { repository } = await createHarness(round.run, round.turns, round.artifacts);

    const result = await repository.awardSessionBid({
      runId: RUN_ID,
      expectedRunVersion: round.run.version,
      ...AWARD_COMMAND,
      outcome: "publish_candidate",
    });
    expect(result).toMatchObject({ kind: "invalid" });

    const details = await repository.getRunDetails(RUN_ID);
    expect(details!.artifacts.some(({ type }) => type === "session_award")).toBe(false);
    expect(details!.artifacts.some(({ type }) => type === "session_message")).toBe(false);
  });
});

describe("PA14-08 reliability history provenance", () => {
  it("uses provider usage from every awarded-plan attempt instead of artifact characters", () => {
    const payload = bidPayload(PARTICIPANT_ONE.id, {
      estimatedOutputTokens: 100,
      plan: {
        summary: "Delegate the awarded plan.",
        mode: "sequential",
        assignments: [
          { agentId: PARTICIPANT_TWO.id, position: 1, instruction: "First step." },
          { agentId: PARTICIPANT_THREE.id, position: 2, instruction: "Second step." },
        ],
        risks: [],
        assumptions: [],
      },
    });
    const winningBid = bidArtifact(1, PARTICIPANT_ONE.id, payload);
    const award: CoordinationArtifact = {
      id: "artifact-award-history",
      runId: RUN_ID,
      type: "session_award",
      createdBy: { kind: "system" },
      payload: {
        schemaVersion: 1,
        type: "session_award",
        userArtifactId: USER_ARTIFACT_ID,
        winningBidArtifactId: winningBid.id,
        selectedAgentId: PARTICIPANT_ONE.id,
        outcome: "execute_plan",
        scoringVersion: "confidence_cost_v1",
        scoreBps: 4_000,
        components: {
          calibratedConfidenceBps: 6_500,
          normalizedProjectedCostBps: 1_000,
          reliabilityPenaltyBps: 0,
        },
        estimatedExecution: { inputTokens: 500, outputTokens: 100 },
      },
      sizeChars: 240,
      createdAt: NOW,
    };
    const executionTurns: CoordinationTurn[] = [
      {
        id: "turn-exec-history-1",
        runId: RUN_ID,
        sequence: 4,
        role: "participant",
        agentId: PARTICIPANT_TWO.id,
        kind: "session_turn",
        wavePurpose: "session_execution",
        status: "failed",
        attemptCount: 1,
        inputArtifactIds: [USER_ARTIFACT_ID, award.id],
        lastValidationErrors: [],
        createdAt: NOW,
      },
      {
        id: "turn-exec-history-2",
        runId: RUN_ID,
        sequence: 5,
        role: "participant",
        agentId: PARTICIPANT_THREE.id,
        kind: "session_turn",
        wavePurpose: "session_execution",
        status: "committed",
        attemptCount: 1,
        inputArtifactIds: [USER_ARTIFACT_ID, award.id],
        lastValidationErrors: [],
        createdAt: NOW,
      },
    ];
    const history = buildAuctionHistory({
      run: auctionRun(),
      turns: [bidTurn(1, PARTICIPANT_ONE.id), ...executionTurns],
      attempts: [
        {
          id: "attempt-history-1",
          runId: RUN_ID,
          turnId: executionTurns[0]!.id,
          number: 1,
          agentId: PARTICIPANT_TWO.id,
          leaseToken: "lease-history-1",
          status: "failed",
          usage: { inputTokens: 40, cachedInputTokens: 0, outputTokens: 80 },
          createdAt: NOW,
        },
        {
          id: "attempt-history-2",
          runId: RUN_ID,
          turnId: executionTurns[1]!.id,
          number: 1,
          agentId: PARTICIPANT_THREE.id,
          leaseToken: "lease-history-2",
          status: "succeeded",
          usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 70 },
          createdAt: NOW,
        },
      ],
      artifacts: [userArtifact(), winningBid, award],
    }, PARTICIPANT_ONE.id);

    expect(history.executions).toEqual([{
      failed: true,
      estimatedOutputTokens: 100,
      actualOutputTokens: 150,
    }]);
  });
});

describe("PA14-13 bounded no-valid-bid fallback", () => {
  const contextBuilder = new RoleScopedContextBuilder();
  const resolveFor = (
    policy: Partial<SessionAuctionPolicy>,
    artifacts: CoordinationArtifact[],
    turns: CoordinationTurn[],
    bidArtifactIds: string[],
  ) =>
    resolveAuction({
      run: auctionRun({ routingMode: "auction", ...policy }),
      turns,
      artifacts,
      decision: {
        kind: "resolve_auction",
        userArtifactId: USER_ARTIFACT_ID,
        bidArtifactIds,
      },
      contextBuilder,
    });

  it("awards the highest-ranked valid bid when the minimum is met", () => {
    const round = settledRound();
    round.artifacts[1] = bidArtifact(
      1,
      PARTICIPANT_ONE.id,
      bidPayload(PARTICIPANT_ONE.id, { confidenceBps: 9_000 }),
    );
    const outcome = resolveFor({}, round.artifacts, round.turns, [
      "artifact-bid-1",
      "artifact-bid-2",
      "artifact-bid-3",
    ]);
    expect(outcome).toMatchObject({
      kind: "award",
      command: {
        outcome: "execute_plan",
        selectedAgentId: PARTICIPANT_ONE.id,
        winningBidArtifactId: "artifact-bid-1",
      },
    });
  });

  it("applies the round-robin fallback exactly once when no bid is valid", () => {
    const outcome = resolveFor(
      { fallback: "round_robin" },
      [userArtifact()],
      PARTICIPANTS.map((agent, index) => ({
        ...bidTurn(index + 1, agent.id),
        status: "failed" as const,
        outputArtifactId: undefined,
      })),
      [],
    );
    expect((outcome as { command: Record<string, unknown> }).command)
      .not.toHaveProperty("winningBidArtifactId");
    expect(outcome).toMatchObject({
      kind: "award",
      command: {
        outcome: "fallback_execution",
        fallback: "round_robin",
        selectedAgentId: PARTICIPANT_ONE.id,
        fallbackEvidence: { validBidCount: 0, requiredBidCount: 2 },
      },
    });
  });

  it("uses the configured default Agent for the default_agent fallback", () => {
    const outcome = resolveFor(
      { fallback: "default_agent", defaultAgentId: PARTICIPANT_THREE.id },
      [userArtifact()],
      [],
      [],
    );
    expect(outcome).toMatchObject({
      kind: "award",
      command: { outcome: "fallback_execution", selectedAgentId: PARTICIPANT_THREE.id },
    });
  });

  it("fails safely when the configured fallback is fail", () => {
    const outcome = resolveFor({ fallback: "fail" }, [userArtifact()], [], []);
    expect(outcome).toMatchObject({ kind: "fail" });
  });

  it("stops one valid bid from winning below the minimum-valid-bid threshold", () => {
    const round = settledRound();
    const outcome = resolveFor({ minimumValidBids: 2 }, round.artifacts, round.turns, [
      "artifact-bid-1",
    ]);
    expect(outcome).toMatchObject({
      kind: "award",
      command: { outcome: "fallback_execution", fallbackEvidence: { validBidCount: 1 } },
    });
  });

  it("commits a fallback award and records its evidence event", async () => {
    const round = settledRound();
    const { repository } = await createHarness(round.run, round.turns, [userArtifact()]);
    const result = await repository.awardSessionBid({
      runId: RUN_ID,
      expectedRunVersion: round.run.version,
      userArtifactId: USER_ARTIFACT_ID,
      selectedAgentId: PARTICIPANT_TWO.id,
      outcome: "fallback_execution",
      scoringVersion: "confidence_cost_v1",
      scoreBps: 0,
      components: {
        calibratedConfidenceBps: 0,
        normalizedProjectedCostBps: 0,
        reliabilityPenaltyBps: 0,
      },
      estimatedExecution: { inputTokens: 0, outputTokens: 0 },
      fallback: "round_robin",
      fallbackEvidence: { validBidCount: 0, requiredBidCount: 2 },
    });
    expect(result.kind).toBe("awarded");

    const details = await repository.getRunDetails(RUN_ID);
    const fallbackEvents = details!.events.filter(
      ({ type }) => type === "auction.fallback_applied",
    );
    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0]!.details).toMatchObject({
      fallback: "round_robin",
      validBidCount: 0,
      requiredBidCount: 2,
    });
    // No chat message is fabricated for a fallback: the Agent still has to answer.
    expect(details!.artifacts.some(({ type }) => type === "session_message")).toBe(false);
  });
});

describe("PA14-17 award feedback", () => {
  it("records a rating without mutating the award or the run status", async () => {
    const round = settledRound();
    const { repository } = await createHarness(round.run, round.turns, round.artifacts);
    const awarded = await repository.awardSessionBid({
      runId: RUN_ID,
      expectedRunVersion: round.run.version,
      ...AWARD_COMMAND,
    });
    expect(awarded.kind).toBe("awarded");
    const awardId = (awarded as { award: { id: string } }).award.id;

    const before = await repository.getRunDetails(RUN_ID);
    const recorded = await repository.recordAwardFeedback({
      runId: RUN_ID,
      awardArtifactId: awardId,
      decision: "accepted",
    });
    expect(recorded.kind).toBe("recorded");

    const after = await repository.getRunDetails(RUN_ID);
    expect(after!.artifacts.find(({ id }) => id === awardId)).toEqual(
      before!.artifacts.find(({ id }) => id === awardId),
    );
    expect(after!.run.status).toBe(before!.run.status);
    const feedback = after!.events.filter(({ type }) => type === "award.feedback_recorded");
    expect(feedback).toHaveLength(1);
    expect(feedback[0]!.details).toMatchObject({ decision: "accepted" });
  });

  it("reports not_found for an unknown award", async () => {
    const round = settledRound();
    const { repository } = await createHarness(round.run, round.turns, round.artifacts);
    await expect(
      repository.recordAwardFeedback({
        runId: RUN_ID,
        awardArtifactId: "artifact-missing",
        decision: "rejected",
      }),
    ).resolves.toEqual({ kind: "not_found" });
  });

  it("keeps a concurrent detail read valid while feedback is appended", async () => {
    const round = settledRound();
    const { repository } = await createHarness(round.run, round.turns, round.artifacts);
    const awarded = await repository.awardSessionBid({
      runId: RUN_ID,
      expectedRunVersion: round.run.version,
      ...AWARD_COMMAND,
    });
    expect(awarded.kind).toBe("awarded");
    const awardId = (awarded as { award: { id: string } }).award.id;

    const [recorded, concurrentRead] = await Promise.all([
      repository.recordAwardFeedback({
        runId: RUN_ID,
        awardArtifactId: awardId,
        decision: "rejected",
      }),
      repository.getRunDetails(RUN_ID),
    ]);
    expect(recorded.kind).toBe("recorded");
    expect(concurrentRead?.run.id).toBe(RUN_ID);
    expect(concurrentRead?.artifacts.some(({ id }) => id === awardId)).toBe(true);

    const after = await repository.getRunDetails(RUN_ID);
    expect(after!.events.filter(({ type }) => type === "award.feedback_recorded")).toHaveLength(1);
  });
});

describe("PA14-15 usage separation", () => {
  it("keeps actual bid usage, actual execution usage, and projections apart", async () => {
    const round = settledRound();
    const { store, repository } = await createHarness(round.run, round.turns, round.artifacts);
    await store.mutate((database) => {
      database.coordinationTurns.push({
        id: "turn-exec-1",
        runId: RUN_ID,
        sequence: 4,
        role: "participant",
        agentId: PARTICIPANT_ONE.id,
        kind: "session_turn",
        wavePurpose: "session_execution",
        status: "committed",
        attemptCount: 1,
        inputArtifactIds: [USER_ARTIFACT_ID],
        lastValidationErrors: [],
        createdAt: NOW,
      });
      database.coordinationAttempts.push(
        {
          id: "attempt-bid-1",
          runId: RUN_ID,
          turnId: "turn-bid-1",
          number: 1,
          agentId: PARTICIPANT_ONE.id,
          leaseToken: "lease-1",
          status: "succeeded",
          usage: { inputTokens: 100, cachedInputTokens: 10, outputTokens: 40 },
          createdAt: NOW,
        },
        {
          id: "attempt-exec-1",
          runId: RUN_ID,
          turnId: "turn-exec-1",
          number: 1,
          agentId: PARTICIPANT_ONE.id,
          leaseToken: "lease-2",
          status: "succeeded",
          usage: { inputTokens: 900, cachedInputTokens: 200, outputTokens: 700 },
          createdAt: NOW,
        },
      );
    });
    await repository.awardSessionBid({
      runId: RUN_ID,
      expectedRunVersion: round.run.version,
      ...AWARD_COMMAND,
    });

    const details = await repository.getRunDetails(RUN_ID);
    expect(details!.auctionUsage).toEqual({
      actualBidding: { inputTokens: 100, cachedInputTokens: 10, outputTokens: 40 },
      actualExecution: { inputTokens: 900, cachedInputTokens: 200, outputTokens: 700 },
      projectedExecution: { inputTokens: 2_400, outputTokens: 1_000 },
    });
    // The two actual totals always reconstruct the run total.
    expect(details!.usageTotals).toEqual({
      inputTokens: 1_000,
      cachedInputTokens: 210,
      outputTokens: 740,
    });
  });
});
