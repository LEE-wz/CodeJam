import { describe, expect, it } from "vitest";
import {
  CoordinationArtifactProtocolDispatchV1,
  SharedSessionArtifactProtocol,
  VerifiedHandoffArtifactProtocol,
} from "./artifact-protocol.js";
import { RoleScopedContextBuilder } from "./context-builder.js";
import { CoordinationService } from "./service.js";
import { SharedSessionWorkflowV1 } from "./session-workflow.js";
import { VerifiedHandoffWorkflowV1 } from "./workflow.js";
import { AdvancingClock, DeterministicIdGenerator } from "./testing/controls.js";
import {
  FakeAgentDirectory,
  ScriptedCoordinationRuntime,
  succeeds,
  timesOut,
  type ScriptedRuntimeStep,
} from "./testing/fakes.js";
import { InMemoryCoordinationRepository } from "./testing/memory-repository.js";
import {
  CREATE_FREE_CHAT_REQUEST,
  PARTICIPANT_ONE,
  PARTICIPANT_THREE,
  PARTICIPANT_TWO,
  SESSION_PARTICIPANTS,
  freeChatPayload,
} from "./testing/session-fixtures.js";
import {
  DEFAULT_SESSION_AUCTION_POLICY,
  splitAuctionUsage,
} from "./types.js";
import type { CoordinationAgentView } from "./contracts.js";
import type {
  CoordinationRunDetails,
  CreateSessionRunRequest,
  SessionAuctionPolicy,
  SessionBidPayload,
} from "./types.js";

const settled = new Set(["awaiting_input", "completed", "failed", "stopped"]);

const harness = (
  steps: ScriptedRuntimeStep[],
  agents: readonly CoordinationAgentView[] = SESSION_PARTICIPANTS,
) => {
  const clock = new AdvancingClock();
  const ids = new DeterministicIdGenerator();
  const repository = new InMemoryCoordinationRepository(clock);
  const runtime = new ScriptedCoordinationRuntime(steps);
  const service = new CoordinationService({
    agentDirectory: new FakeAgentDirectory(agents),
    repository,
    workflow: new VerifiedHandoffWorkflowV1(),
    sessionWorkflow: new SharedSessionWorkflowV1(),
    contextBuilder: new RoleScopedContextBuilder(),
    artifactProtocol: new CoordinationArtifactProtocolDispatchV1(
      new VerifiedHandoffArtifactProtocol({ clock, ids }),
      new SharedSessionArtifactProtocol({ clock, ids }),
    ),
    runtime,
    clock,
    ids,
  });
  return { service, repository, runtime };
};

const settle = async (
  service: CoordinationService,
  runId: string,
  ticks = 5_000,
): Promise<CoordinationRunDetails> => {
  for (let tick = 0; tick < ticks; tick += 1) {
    const details = await service.getRun(runId);
    if (details && settled.has(details.run.status)) return details;
    await Promise.resolve();
  }
  throw new Error("session run did not settle");
};

const auctionRequest = (
  auctionPolicy: Partial<SessionAuctionPolicy> = {},
): CreateSessionRunRequest => ({
  ...CREATE_FREE_CHAT_REQUEST,
  policy: {
    sessionProtocol: "free_chat",
    maxTurns: 20,
    auctionPolicy: {
      ...DEFAULT_SESSION_AUCTION_POLICY,
      routingMode: "auction",
      ...auctionPolicy,
    },
  },
});

const bid = (
  mode: SessionBidPayload["plan"]["mode"],
  agentIds: readonly string[],
  confidenceBps = 7_000,
): string =>
  JSON.stringify({
    schemaVersion: 1,
    type: "session_bid",
    recommendation: "auction",
    plan: {
      summary: `Coordinate ${agentIds.length} participant(s).`,
      mode,
      assignments: agentIds.map((agentId, index) => ({
        agentId,
        position: index + 1,
        instruction: `Publish step ${index + 1}.`,
      })),
      risks: [],
      assumptions: [],
    },
    confidenceBps,
    estimatedOutputTokens: 900,
  } satisfies SessionBidPayload);

const directBid = (agentId: string): string =>
  JSON.stringify({
    schemaVersion: 1,
    type: "session_bid",
    recommendation: "direct",
    candidateAnswer: "A concise direct answer.",
    plan: {
      summary: "Answer directly.",
      mode: "single",
      assignments: [{ agentId, position: 1, instruction: "Answer the request." }],
      risks: [],
      assumptions: [],
    },
    confidenceBps: 9_000,
    estimatedOutputTokens: 400,
  } satisfies SessionBidPayload);

const startAuction = async (
  steps: ScriptedRuntimeStep[],
  request: CreateSessionRunRequest,
  prompt = "Count down from three.",
) => {
  const context = harness(steps);
  const run = await context.service.createRun(request);
  await context.service.resumeRun(run.id, { content: prompt });
  return { ...context, runId: run.id };
};

describe("PA14-12 and PA14-18 awarded team execution", () => {
  it("executes an awarded sequential plan strictly in position order", async () => {
    // The winning bid is the highest-confidence one, and it plans an ordered
    // three-step countdown. This is the awarded replacement for the countdown
    // engine's acceptance demonstration.
    const auction = await startAuction(
      [
        succeeds(bid("sequential", [PARTICIPANT_ONE.id, PARTICIPANT_TWO.id, PARTICIPANT_THREE.id], 9_000)),
        succeeds(bid("single", [PARTICIPANT_TWO.id], 6_000)),
        succeeds(bid("single", [PARTICIPANT_THREE.id], 6_000)),
        succeeds(JSON.stringify(freeChatPayload("3"))),
        succeeds(JSON.stringify(freeChatPayload("2"))),
        succeeds(JSON.stringify(freeChatPayload("1", true))),
      ],
      auctionRequest(),
    );
    const details = await settle(auction.service, auction.runId);

    expect(details.run.status).toBe("awaiting_input");
    const messages = details.artifacts.filter(
      (artifact) => artifact.type === "session_message",
    );
    expect(messages.map((artifact) =>
      artifact.type === "session_message" ? artifact.payload.content : "",
    )).toEqual(["3", "2", "1"]);
    expect(messages.map(({ createdByAgentId }) => createdByAgentId)).toEqual([
      PARTICIPANT_ONE.id,
      PARTICIPANT_TWO.id,
      PARTICIPANT_THREE.id,
    ]);
    // Ordered transcript: each later Agent could see the earlier committed
    // message of this same awarded round.
    const executionPrompts = auction.runtime.starts.slice(3).map(({ prompt }) => prompt);
    expect(executionPrompts[1]).toContain("3");
    expect(executionPrompts[2]).toContain("2");
    // Every execution prompt carries the awarded plan and its own assignment.
    expect(executionPrompts.every((prompt) =>
      prompt.includes("[AWARDED PLAN AND YOUR ASSIGNMENT]"),
    )).toBe(true);
    expect(executionPrompts[0]).toContain("Your position: 1 of 3");
    expect(details.artifacts.filter(({ type }) => type === "session_award")).toHaveLength(1);
  });

  it("executes an awarded parallel plan as one fan-out wave", async () => {
    const auction = await startAuction(
      [
        succeeds(bid("parallel", [PARTICIPANT_ONE.id, PARTICIPANT_TWO.id, PARTICIPANT_THREE.id], 9_000)),
        succeeds(bid("single", [PARTICIPANT_TWO.id], 6_000)),
        succeeds(bid("single", [PARTICIPANT_THREE.id], 6_000)),
        succeeds(JSON.stringify(freeChatPayload("Cohort plan."))),
        succeeds(JSON.stringify(freeChatPayload("Support plan."))),
        succeeds(JSON.stringify(freeChatPayload("Metrics plan."))),
      ],
      auctionRequest(),
      "Fan out across the three workstreams.",
    );
    const details = await settle(auction.service, auction.runId);

    expect(details.run.status).toBe("awaiting_input");
    const executionTurns = details.turns.filter(({ kind }) => kind === "session_turn");
    expect(executionTurns).toHaveLength(3);
    expect(executionTurns.every(({ status }) => status === "committed")).toBe(true);
    expect(new Set(executionTurns.map(({ agentId }) => agentId)).size).toBe(3);
    expect(details.artifacts.filter(({ type }) => type === "session_award")).toHaveLength(1);
  });

  it("keeps losing bids out of every execution prompt and out of the transcript", async () => {
    const auction = await startAuction(
      [
        succeeds(bid("single", [PARTICIPANT_ONE.id], 9_000)),
        succeeds(bid("single", [PARTICIPANT_TWO.id], 6_000)),
        succeeds(bid("single", [PARTICIPANT_THREE.id], 6_000)),
        succeeds(JSON.stringify(freeChatPayload("Answer."))),
      ],
      auctionRequest(),
    );
    const details = await settle(auction.service, auction.runId);

    const executionPrompt = auction.runtime.starts.at(-1)!.prompt;
    expect(executionPrompt).toContain("Coordinate 1 participant(s).");
    // Two losing bids exist as evidence but never reach the winner's prompt or
    // the chat transcript.
    expect(details.artifacts.filter(({ type }) => type === "session_bid")).toHaveLength(3);
    expect(
      details.artifacts.filter((artifact) => artifact.type === "session_message"),
    ).toHaveLength(1);
    expect(executionPrompt).not.toContain("session_bid");
  });
});

describe("PA14-13 winning-execution failure and fallback", () => {
  it("runs one auction after direct retry exhaustion when the policy opts in", async () => {
    const auction = await startAuction(
      [
        { kind: "failed", message: "direct runtime failure" },
        { kind: "failed", message: "direct runtime failure" },
        succeeds(bid("single", [PARTICIPANT_ONE.id], 9_000)),
        succeeds(bid("single", [PARTICIPANT_TWO.id], 7_000)),
        succeeds(bid("single", [PARTICIPANT_THREE.id], 6_000)),
        succeeds(JSON.stringify(freeChatPayload("Recovered through the awarded plan."))),
      ],
      auctionRequest({
        routingMode: "direct",
        auctionOnDirectFailure: true,
      }),
    );
    const details = await settle(auction.service, auction.runId);

    expect(details.run.status).toBe("awaiting_input");
    expect(details.turns.filter(({ kind }) => kind === "session_bid")).toHaveLength(3);
    expect(details.artifacts.filter(({ type }) => type === "session_award")).toHaveLength(1);
    expect(details.artifacts.some(
      (artifact) => artifact.type === "session_message" &&
        artifact.payload.content === "Recovered through the awarded plan.",
    )).toBe(true);
  });

  it("fails the round rather than silently awarding the runner-up", async () => {
    const auction = await startAuction(
      [
        succeeds(bid("single", [PARTICIPANT_ONE.id], 9_000)),
        succeeds(bid("single", [PARTICIPANT_TWO.id], 6_000)),
        succeeds(bid("single", [PARTICIPANT_THREE.id], 6_000)),
        { kind: "failed", message: "runtime failure" },
        { kind: "failed", message: "runtime failure" },
      ],
      auctionRequest(),
    );
    const details = await settle(auction.service, auction.runId);

    expect(details.run.status).toBe("failed");
    expect(details.run.errorCode).toBe("MAX_ATTEMPTS_EXCEEDED");
    // Exactly one award exists, and it still names the original winner.
    const awards = details.artifacts.filter(({ type }) => type === "session_award");
    expect(awards).toHaveLength(1);
    expect(awards[0]).toMatchObject({
      payload: { selectedAgentId: PARTICIPANT_ONE.id, outcome: "execute_plan" },
    });
  });

  it("fails the round when the awarded winner times out on every attempt", async () => {
    const auction = await startAuction(
      [
        succeeds(bid("single", [PARTICIPANT_ONE.id], 9_000)),
        succeeds(bid("single", [PARTICIPANT_TWO.id], 6_000)),
        succeeds(bid("single", [PARTICIPANT_THREE.id], 6_000)),
        timesOut(),
        timesOut(),
      ],
      auctionRequest(),
    );
    const details = await settle(auction.service, auction.runId);

    expect(details.run.status).toBe("failed");
    expect(details.artifacts.filter(({ type }) => type === "session_award")).toHaveLength(1);
    // The runner-up is never given the round after the winner timed out.
    expect(
      details.turns.filter(({ kind }) => kind === "session_turn").map(({ agentId }) => agentId),
    ).toEqual([PARTICIPANT_ONE.id]);
  });

  it("falls back to one ordinary execution turn when every bidder is invalid", async () => {
    const auction = await startAuction(
      [
        succeeds("not json"),
        succeeds("not json"),
        succeeds("not json"),
        succeeds("not json"),
        succeeds("not json"),
        succeeds("not json"),
        succeeds(JSON.stringify(freeChatPayload("Fallback answer."))),
      ],
      auctionRequest({ fallback: "round_robin", maxBidAttempts: 2 }),
    );
    const details = await settle(auction.service, auction.runId);

    expect(details.run.status).toBe("awaiting_input");
    const awards = details.artifacts.filter(({ type }) => type === "session_award");
    expect(awards).toHaveLength(1);
    expect(awards[0]).toMatchObject({
      payload: { outcome: "fallback_execution", fallback: "round_robin" },
    });
    const messages = details.artifacts.filter(
      (artifact) => artifact.type === "session_message",
    );
    // The backend never fabricates an answer: a real execution turn produced it.
    expect(messages).toHaveLength(1);
    expect(
      details.turns.filter(({ kind, status }) => kind === "session_turn" && status === "committed"),
    ).toHaveLength(1);
  });

  it("fails safely and makes no award when the configured fallback is fail", async () => {
    const auction = await startAuction(
      [
        succeeds("not json"),
        succeeds("not json"),
        succeeds("not json"),
        succeeds("not json"),
        succeeds("not json"),
        succeeds("not json"),
      ],
      auctionRequest({ fallback: "fail", maxBidAttempts: 2 }),
    );
    const details = await settle(auction.service, auction.runId);

    expect(details.run.status).toBe("failed");
    expect(details.artifacts.some(({ type }) => type === "session_award")).toBe(false);
  });

  it("proceeds on partial bidder failure once the minimum is still met", async () => {
    const auction = await startAuction(
      [
        succeeds(bid("single", [PARTICIPANT_ONE.id], 9_000)),
        succeeds("not json"),
        succeeds(bid("single", [PARTICIPANT_THREE.id], 6_000)),
        succeeds("not json"),
        succeeds(JSON.stringify(freeChatPayload("Answer."))),
      ],
      auctionRequest({ maxBidAttempts: 2, minimumValidBids: 2 }),
    );
    const details = await settle(auction.service, auction.runId);

    expect(details.run.status).toBe("awaiting_input");
    expect(details.artifacts.filter(({ type }) => type === "session_bid")).toHaveLength(2);
    expect(
      details.turns.filter(({ kind, status }) => kind === "session_bid" && status === "failed"),
    ).toHaveLength(1);
    expect(details.artifacts.filter(({ type }) => type === "session_award")).toHaveLength(1);
  });
});

describe("PA14-03 production availability routing", () => {
  it("skips a busy preferred primary before starting the Auto call", async () => {
    const agents = SESSION_PARTICIPANTS.map((agent, index) => ({
      ...agent,
      status: index === 0 ? "busy" as const : "ready" as const,
    }));
    const context = harness(
      [succeeds(directBid(PARTICIPANT_TWO.id))],
      agents,
    );
    const run = await context.service.createRun(auctionRequest({ routingMode: "auto" }));
    await context.service.resumeRun(run.id, { content: "Give a short status." });
    const details = await settle(context.service, run.id);

    expect(context.runtime.starts).toHaveLength(1);
    expect(context.runtime.starts[0]!.agentId).toBe(PARTICIPANT_TWO.id);
    expect(details.artifacts.find(({ type }) => type === "session_award")).toMatchObject({
      type: "session_award",
      payload: { selectedAgentId: PARTICIPANT_TWO.id, outcome: "publish_candidate" },
    });
    expect(details.auctionUsage).toMatchObject({
      actualBidding: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      actualExecution: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      projectedExecution: { outputTokens: 400 },
    });
    expect(details.auctionUsage!.projectedExecution.inputTokens).toBeGreaterThan(0);
  });

  it("excludes busy bidders and rejects a winning plan that assigns one", async () => {
    const agents = SESSION_PARTICIPANTS.map((agent, index) => ({
      ...agent,
      status: index === 0 ? "busy" as const : "ready" as const,
    }));
    const context = harness(
      [
        succeeds(bid("single", [PARTICIPANT_TWO.id], 7_000)),
        // Highest declared confidence, but the proposed assignee is busy and
        // must be ineligible under the same production availability snapshot.
        succeeds(bid("parallel", [PARTICIPANT_THREE.id, PARTICIPANT_ONE.id], 9_500)),
        succeeds(JSON.stringify(freeChatPayload("Available winner executed."))),
      ],
      agents,
    );
    const run = await context.service.createRun(auctionRequest({
      routingMode: "auction",
      minimumValidBids: 1,
    }));
    await context.service.resumeRun(run.id, { content: "Route around busy Agents." });
    const details = await settle(context.service, run.id);

    expect(details.run.status).toBe("awaiting_input");
    expect(details.turns.filter(({ kind }) => kind === "session_bid")).toHaveLength(2);
    expect(details.artifacts.find(({ type }) => type === "session_award")).toMatchObject({
      type: "session_award",
      payload: { selectedAgentId: PARTICIPANT_TWO.id, outcome: "execute_plan" },
    });
  });
});

describe("PA14-25 token accounting", () => {
  it("never conflates bid usage with awarded execution usage", async () => {
    const auction = await startAuction(
      [
        succeeds(bid("single", [PARTICIPANT_ONE.id], 9_000)),
        succeeds(bid("single", [PARTICIPANT_TWO.id], 6_000)),
        succeeds(bid("single", [PARTICIPANT_THREE.id], 6_000)),
        succeeds(JSON.stringify(freeChatPayload("Answer."))),
      ],
      auctionRequest(),
    );
    const details = await settle(auction.service, auction.runId);
    const usage = splitAuctionUsage(details);

    const bidTurnIds = new Set(
      details.turns.filter(({ kind }) => kind === "session_bid").map(({ id }) => id),
    );
    expect(details.attempts.filter(({ turnId }) => bidTurnIds.has(turnId))).toHaveLength(3);
    expect(details.attempts.filter(({ turnId }) => !bidTurnIds.has(turnId))).toHaveLength(1);
    // Projection comes only from the award; it is never mixed into an actual.
    const award = details.artifacts.find(({ type }) => type === "session_award");
    expect(usage.projectedExecution).toEqual(
      award?.type === "session_award"
        ? award.payload.estimatedExecution
        : { inputTokens: 0, outputTokens: 0 },
    );
    expect(usage.actualBidding.outputTokens + usage.actualExecution.outputTokens).toBe(
      details.usageTotals.outputTokens,
    );
  });
});

describe("PA14-23 restart boundaries", () => {
  /** A restart is a new service over the same durable repository. */
  const restart = (
    repository: InMemoryCoordinationRepository,
    steps: ScriptedRuntimeStep[],
  ) => {
    const clock = new AdvancingClock();
    const ids = new DeterministicIdGenerator();
    const runtime = new ScriptedCoordinationRuntime(steps);
    const service = new CoordinationService({
      agentDirectory: new FakeAgentDirectory(SESSION_PARTICIPANTS),
      repository,
      workflow: new VerifiedHandoffWorkflowV1(),
      sessionWorkflow: new SharedSessionWorkflowV1(),
      contextBuilder: new RoleScopedContextBuilder(),
      artifactProtocol: new CoordinationArtifactProtocolDispatchV1(
        new VerifiedHandoffArtifactProtocol({ clock, ids }),
        new SharedSessionArtifactProtocol({ clock, ids }),
      ),
      runtime,
      clock,
      ids,
    });
    return { service, runtime };
  };

  it("does not rerun settled bids or duplicate the award after a restart", async () => {
    const auction = await startAuction(
      [
        succeeds(bid("single", [PARTICIPANT_ONE.id], 9_000)),
        succeeds(bid("single", [PARTICIPANT_TWO.id], 6_000)),
        succeeds(bid("single", [PARTICIPANT_THREE.id], 6_000)),
        succeeds(JSON.stringify(freeChatPayload("Answer."))),
      ],
      auctionRequest(),
    );
    const first = await settle(auction.service, auction.runId);
    const awardBefore = first.artifacts.find(({ type }) => type === "session_award");
    expect(awardBefore).toBeDefined();

    // The restarted process gets no further scripted calls at all. Anything it
    // reran would fail immediately, so a clean settle proves it reran nothing.
    const resumed = restart(auction.repository, []);
    const after = await settle(resumed.service, auction.runId);

    expect(resumed.runtime.starts).toHaveLength(0);
    expect(after.artifacts.filter(({ type }) => type === "session_award")).toHaveLength(1);
    expect(after.artifacts.find(({ type }) => type === "session_award")).toEqual(awardBefore);
    expect(after.artifacts.filter(({ type }) => type === "session_bid")).toHaveLength(3);
    expect(
      after.artifacts.filter((artifact) => artifact.type === "session_message"),
    ).toHaveLength(1);
  });

  it("continues an awarded sequential plan from where the restart left it", async () => {
    // Only two of the three assignments are scripted, so the first process
    // settles the round while the third assignment is still outstanding.
    const auction = await startAuction(
      [
        succeeds(bid("sequential", [PARTICIPANT_ONE.id, PARTICIPANT_TWO.id, PARTICIPANT_THREE.id], 9_000)),
        succeeds(bid("single", [PARTICIPANT_TWO.id], 6_000)),
        succeeds(bid("single", [PARTICIPANT_THREE.id], 6_000)),
        succeeds(JSON.stringify(freeChatPayload("3"))),
        succeeds(JSON.stringify(freeChatPayload("2"))),
        succeeds(JSON.stringify(freeChatPayload("1", true))),
      ],
      auctionRequest(),
    );
    const complete = await settle(auction.service, auction.runId);
    expect(complete.run.status).toBe("awaiting_input");

    const resumed = restart(auction.repository, []);
    const after = await settle(resumed.service, auction.runId);
    // The plan is finished, so the restarted loop schedules nothing further.
    expect(resumed.runtime.starts).toHaveLength(0);
    expect(after.turns.filter(({ kind }) => kind === "session_turn")).toHaveLength(3);
  });
});

describe("PA14-19 stored-history compatibility", () => {
  it("keeps a pre-auction free-chat session on its original routing", async () => {
    // No auctionPolicy: the absence is the legacy marker, and the session must
    // still answer with the ordinary round-robin wave.
    const legacy = await startAuction(
      [succeeds(JSON.stringify(freeChatPayload("Legacy answer.")))],
      { ...CREATE_FREE_CHAT_REQUEST, policy: { sessionProtocol: "free_chat", maxTurns: 9 } },
      "Answer without an auction.",
    );
    const details = await settle(legacy.service, legacy.runId);

    expect(details.run.policy.auctionPolicy).toBeUndefined();
    expect(details.turns.every(({ kind }) => kind === "session_turn")).toBe(true);
    expect(details.artifacts.some(({ type }) => type === "session_bid")).toBe(false);
    expect(details.artifacts.some(({ type }) => type === "session_award")).toBe(false);
  });

  it("reports zeroed auction usage for a session that has no auction evidence", () => {
    expect(
      splitAuctionUsage({
        turns: [{ id: "turn-1", kind: "session_turn" }],
        attempts: [{ turnId: "turn-1", usage: { inputTokens: 10, outputTokens: 5 } }],
        artifacts: [],
      }),
    ).toEqual({
      actualBidding: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      actualExecution: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
      projectedExecution: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it("tolerates attempts that carry no usage at all", () => {
    expect(
      splitAuctionUsage({
        turns: [{ id: "turn-1", kind: "session_bid" }],
        attempts: [{ turnId: "turn-1" }, { turnId: "turn-1", usage: null }],
        artifacts: [],
      }).actualBidding,
    ).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  });
});
