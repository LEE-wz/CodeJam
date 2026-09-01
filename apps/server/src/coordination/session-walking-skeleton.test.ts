import { describe, expect, it } from "vitest";
import {
  CoordinationArtifactProtocolDispatchV1,
  SharedSessionArtifactProtocol,
  VerifiedHandoffArtifactProtocol,
} from "./artifact-protocol.js";
import type { ContextBuildInput, ContextBuilder } from "./contracts.js";
import { RoleScopedContextBuilder } from "./context-builder.js";
import { CoordinationService } from "./service.js";
import { SharedSessionWorkflowV1 } from "./session-workflow.js";
import { VerifiedHandoffWorkflowV1 } from "./workflow.js";
import type { CoordinationRun, CoordinationRunDetails, CreateSessionRunRequest } from "./types.js";
import {
  DEFAULT_COORDINATION_POLICY,
  DEFAULT_SESSION_AUCTION_POLICY,
  SESSION_CONTEXT_MAX_CHARS,
  SESSION_LIMITS,
} from "./types.js";
import { AdvancingClock, DeterministicIdGenerator } from "./testing/controls.js";
import {
  FakeAgentDirectory,
  ScriptedCoordinationRuntime,
  deferred,
  succeeds,
  timesOut,
  type ScriptedRuntimeStep,
} from "./testing/fakes.js";
import { InMemoryCoordinationRepository } from "./testing/memory-repository.js";
import {
  CREATE_FREE_CHAT_REQUEST,
  PARTICIPANT_ONE,
  EMPTY_CONTENT_OUTPUT,
  PROSE_MESSAGE_OUTPUT,
  VALID_MESSAGE_OUTPUT,
  PARTICIPANT_THREE,
  PARTICIPANT_TWO,
  SESSION_PARTICIPANTS,
  UNANIMOUS_DONE_ROUND,
  freeChatPayload,
} from "./testing/session-fixtures.js";

const settled = new Set(["awaiting_input", "completed", "failed", "stopped"]);

const sessionHarness = (
  steps: ScriptedRuntimeStep[],
  contextBuilder: ContextBuilder = new RoleScopedContextBuilder(),
) => {
  const clock = new AdvancingClock();
  const ids = new DeterministicIdGenerator();
  const repository = new InMemoryCoordinationRepository(clock);
  const runtime = new ScriptedCoordinationRuntime(steps);
  const verifiedProtocol = new VerifiedHandoffArtifactProtocol({ clock, ids });
  const sessionProtocol = new SharedSessionArtifactProtocol({ clock, ids });
  const service = new CoordinationService({
    agentDirectory: new FakeAgentDirectory(SESSION_PARTICIPANTS),
    repository,
    workflow: new VerifiedHandoffWorkflowV1(),
    sessionWorkflow: new SharedSessionWorkflowV1(),
    contextBuilder,
    artifactProtocol: new CoordinationArtifactProtocolDispatchV1(
      verifiedProtocol,
      sessionProtocol,
    ),
    runtime,
    clock,
    ids,
  });
  return { service, repository, runtime, clock, ids };
};

const settle = async (
  service: CoordinationService,
  runId: string,
  ticks = 3_000,
): Promise<CoordinationRunDetails> => {
  for (let tick = 0; tick < ticks; tick += 1) {
    const details = await service.getRun(runId);
    if (details && settled.has(details.run.status)) return details;
    await Promise.resolve();
  }
  throw new Error("session run did not reach a terminal state");
};

const flush = async (ticks = 200): Promise<void> => {
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
};

const startSession = async (
  steps: ScriptedRuntimeStep[],
  request: CreateSessionRunRequest = CREATE_FREE_CHAT_REQUEST,
) => {
  const context = sessionHarness(steps);
  const run = await context.service.createRun(request);
  await context.service.resumeRun(run.id, { content: "Work on the shared objective" });
  return { ...context, runId: run.id };
};

/** One committed message per scripted turn. */
const messageSteps = (count: number): ScriptedRuntimeStep[] =>
  Array.from({ length: count }, (_unused, index) =>
    succeeds(JSON.stringify(freeChatPayload(`Contribution ${index + 1}`))));

/** A session whose turn ceiling is high enough for a multi-round transcript. */
const longSessionRequest = (maxTurns: number): CreateSessionRunRequest => ({
  ...CREATE_FREE_CHAT_REQUEST,
  policy: { sessionProtocol: "free_chat", maxTurns },
});

describe("session create validation and context probe", () => {
  it("normalizes free-chat policy defaults", async () => {
    const named = sessionHarness([]);
    const namedRun = await named.service.createRun({
      ...CREATE_FREE_CHAT_REQUEST,
      name: "  Checklist  ",
      policy: undefined,
    });
    // An unnamed protocol is free chat now that countdown is deleted (PA14-18).
    expect(namedRun).toMatchObject({
      name: "Checklist",
      phase: "sessioning",
      revision: 0,
      policy: { sessionProtocol: "free_chat", maxTurns: SESSION_LIMITS.defaultSessionTurns },
    });
    expect(namedRun).not.toHaveProperty("sharedState");

    const freeChat = sessionHarness([]);
    const freeChatRun = await freeChat.service.createRun({
      ...CREATE_FREE_CHAT_REQUEST,
      policy: { sessionProtocol: "free_chat" },
    });
    expect(freeChatRun).not.toHaveProperty("sharedState");
    expect(freeChatRun.policy).toMatchObject({
      sessionProtocol: "free_chat",
      maxTurns: SESSION_LIMITS.defaultSessionTurns,
    });
    expect(freeChatRun.policy).not.toHaveProperty("sessionStartValue");
  });

  it.each([
    { policy: { maxTurns: SESSION_LIMITS.maxSessionTurns + 1 }, label: "turns above range" },
    { policy: { perAttemptTimeoutMs: 9_999 }, label: "timeout below range" },
    { policy: { perAttemptTimeoutMs: 180_001 }, label: "timeout above range" },
  ])("rejects a session policy with $label", async ({ policy }) => {
    await expect(sessionHarness([]).service.createRun({
      ...CREATE_FREE_CHAT_REQUEST,
      policy,
    })).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });
  });

  it("rejects free-chat turn limits outside the session range", async () => {
    for (const policy of [
      { sessionProtocol: "free_chat" as const, maxTurns: SESSION_LIMITS.minSessionTurns - 1 },
      { sessionProtocol: "free_chat" as const, maxTurns: SESSION_LIMITS.maxSessionTurns + 1 },
      { sessionProtocol: "free_chat" as const, maxTurns: 12.5 },
    ]) {
      await expect(sessionHarness([]).service.createRun({
        ...CREATE_FREE_CHAT_REQUEST,
        policy,
      })).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });
    }
  });

  // P10-04: the raise applies to session runs. Values that were rejected before
  // the raise are now accepted, including at the new ceiling.
  it.each([13, 1_000, SESSION_LIMITS.maxSessionTurns])(
    "accepts a free-chat turn ceiling of %i",
    async (maxTurns) => {
      const run = await sessionHarness([]).service.createRun({
        ...CREATE_FREE_CHAT_REQUEST,
        policy: { sessionProtocol: "free_chat", maxTurns },
      });
      expect(run.policy.maxTurns).toBe(maxTurns);
    },
  );

  // P10-04: the verified workflow keeps its own frozen 3..12 range. The session
  // raise must not leak across the workflow boundary.
  it("leaves the verified-handoff turn range unchanged", async () => {
    const verifiedRequest = {
      workflow: "verified_handoff_v1" as const,
      name: "Verified range regression",
      objective: "Prove the session turn raise did not cross the workflow boundary.",
      requiredSections: [{ key: "summary", title: "Summary" }],
      agents: {
        plannerAgentId: PARTICIPANT_ONE.id,
        criticAgentId: PARTICIPANT_TWO.id,
        finalizerAgentId: PARTICIPANT_THREE.id,
      },
    };

    await expect(sessionHarness([]).service.createRun({
      ...verifiedRequest,
      policy: { maxTurns: 13 },
    })).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });

    const accepted = await sessionHarness([]).service.createRun({
      ...verifiedRequest,
      policy: { maxTurns: 12 },
    });
    expect(accepted.policy.maxTurns).toBe(12);
  });

  // P10-05: a session run carries the wider transcript budget, not the
  // verified-handoff document budget.
  it("gives session runs the session context budget", async () => {
    const run = await sessionHarness([]).service.createRun(CREATE_FREE_CHAT_REQUEST);
    expect(run.policy.contextMaxChars).toBe(SESSION_CONTEXT_MAX_CHARS);
    expect(DEFAULT_COORDINATION_POLICY.contextMaxChars).toBe(12_000);
  });

  it("enforces name/objective bounds and rejects verified-only fields", async () => {
    const invalid = [
      { ...CREATE_FREE_CHAT_REQUEST, name: " " },
      { ...CREATE_FREE_CHAT_REQUEST, name: "n".repeat(81) },
      { ...CREATE_FREE_CHAT_REQUEST, objective: " " },
      { ...CREATE_FREE_CHAT_REQUEST, objective: "o".repeat(4_001) },
      { ...CREATE_FREE_CHAT_REQUEST, requiredSections: [] },
      { ...CREATE_FREE_CHAT_REQUEST, policy: { maxRevisions: 1 } },
    ];
    for (const request of invalid) {
      await expect(
        sessionHarness([]).service.createRun(request as CreateSessionRunRequest),
      ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });
    }
  });

  it("probes the real session turn shape before persisting", async () => {
    const probes: ContextBuildInput[] = [];
    const contextBuilder: ContextBuilder = {
      build(input) {
        probes.push(input);
        return { prompt: "probe", promptDigest: "digest", truncated: false };
      },
    };
    const context = sessionHarness([], contextBuilder);
    await context.service.createRun(CREATE_FREE_CHAT_REQUEST);
    expect(probes).toHaveLength(1);
    expect(probes[0]?.turn).toMatchObject({
      role: "participant",
      agentId: PARTICIPANT_ONE.id,
      kind: "session_turn",
      sequence: 1,
    });
  });
});

describe("session walking skeleton", () => {
  const autoBid = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    schemaVersion: 1,
    type: "session_bid",
    recommendation: "direct",
    candidateAnswer: "Published from the primary bid.",
    plan: {
      summary: "Answer directly.",
      mode: "single",
      assignments: [{
        agentId: PARTICIPANT_ONE.id,
        position: 1,
        instruction: "Answer the request.",
      }],
      risks: [],
      assumptions: [],
    },
    confidenceBps: 8_000,
    estimatedOutputTokens: 1_000,
    ...overrides,
  });

  it("publishes a qualifying Auto primary candidate with no second model call", async () => {
    const auto = await startSession([succeeds(autoBid())], {
      ...CREATE_FREE_CHAT_REQUEST,
      policy: {
        sessionProtocol: "free_chat",
        maxTurns: 10,
        auctionPolicy: DEFAULT_SESSION_AUCTION_POLICY,
      },
    });
    const details = await settle(auto.service, auto.runId);
    const bid = details.artifacts.find(({ type }) => type === "session_bid");
    const message = details.artifacts.find(({ type }) => type === "session_message");

    expect(details.run.status).toBe("awaiting_input");
    expect(details.turns).toHaveLength(1);
    expect(details.turns[0]).toMatchObject({ kind: "session_bid", status: "committed" });
    expect(auto.runtime.starts).toHaveLength(1);
    expect(auto.runtime.starts[0]?.threadPolicy).toBe("fresh");
    expect(message).toMatchObject({
      type: "session_message",
      sourceBidArtifactId: bid?.id,
      createdByAgentId: PARTICIPANT_ONE.id,
      payload: { content: "Published from the primary bid." },
      transcriptSequence: 2,
    });
  });

  it.each([
    ["auction recommendation", { recommendation: "auction", candidateAnswer: undefined }],
    ["confidence below threshold", { confidenceBps: 7_999 }],
  ])("escalates Auto for %s and reuses the primary bid", async (_label, overrides) => {
    const remainingBid = autoBid({
      recommendation: "auction",
      candidateAnswer: undefined,
      plan: {
        summary: "Use the first participant.",
        mode: "sequential",
        assignments: [{
          agentId: PARTICIPANT_ONE.id,
          position: 1,
          instruction: "Answer the request.",
        }],
        risks: [],
        assumptions: [],
      },
    });
    const auto = await startSession([
      succeeds(autoBid(overrides)),
      succeeds(remainingBid),
      succeeds(remainingBid),
      succeeds(JSON.stringify(freeChatPayload("Awarded answer", true))),
    ], {
      ...CREATE_FREE_CHAT_REQUEST,
      policy: {
        sessionProtocol: "free_chat",
        maxTurns: 10,
        auctionPolicy: DEFAULT_SESSION_AUCTION_POLICY,
      },
    });
    const details = await settle(auto.service, auto.runId);

    // Escalation collects one bid per participant, commits exactly one award,
    // and then executes the awarded plan.
    expect(details.run.status).toBe("awaiting_input");
    expect(details.turns.slice(0, 3).map(({ agentId }) => agentId)).toEqual([
      PARTICIPANT_ONE.id,
      PARTICIPANT_TWO.id,
      PARTICIPANT_THREE.id,
    ]);
    expect(details.turns).toHaveLength(4);
    expect(details.turns[3]).toMatchObject({
      kind: "session_turn",
      wavePurpose: "session_execution",
      status: "committed",
      agentId: PARTICIPANT_ONE.id,
    });
    expect(auto.runtime.starts).toHaveLength(4);
    expect(details.artifacts.filter(({ type }) => type === "session_bid")).toHaveLength(3);
    const awards = details.artifacts.filter(({ type }) => type === "session_award");
    expect(awards).toHaveLength(1);
    expect(awards[0]).toMatchObject({
      type: "session_award",
      createdBy: { kind: "system" },
      payload: { outcome: "execute_plan", scoringVersion: "confidence_cost_v1" },
    });
    // The only chat message is the awarded execution: no losing bid is published.
    const messages = details.artifacts.filter(({ type }) => type === "session_message");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      createdByAgentId: PARTICIPANT_ONE.id,
      payload: { content: "Awarded answer" },
    });
  });

  it("executes explicit direct routing once without scheduling a bid wave", async () => {
    const direct = await startSession([
      succeeds(JSON.stringify(freeChatPayload("Direct answer", true))),
    ], {
      ...CREATE_FREE_CHAT_REQUEST,
      policy: {
        sessionProtocol: "free_chat",
        maxTurns: 10,
        auctionPolicy: {
          ...DEFAULT_SESSION_AUCTION_POLICY,
          routingMode: "direct",
        },
      },
    });
    const details = await settle(direct.service, direct.runId);

    expect(details.run.status).toBe("awaiting_input");
    expect(details.turns).toHaveLength(1);
    expect(details.turns[0]).toMatchObject({
      kind: "session_turn",
      wavePurpose: "session_execution",
      status: "committed",
    });
    expect(details.artifacts.map(({ type }) => type)).toEqual([
      "user_message",
      "session_message",
    ]);
    expect(direct.runtime.starts).toHaveLength(1);
    expect(direct.runtime.starts[0]?.threadPolicy).toBe("agent_default");
  });

  it("executes one fresh-thread bid opportunity per explicit-auction participant", async () => {
    const output = JSON.stringify({
      schemaVersion: 1,
      type: "session_bid",
      recommendation: "auction",
      plan: {
        summary: "Use the first participant.",
        mode: "sequential",
        assignments: [{
          agentId: PARTICIPANT_ONE.id,
          position: 1,
          instruction: "Answer the request.",
        }],
        risks: [],
        assumptions: [],
      },
      confidenceBps: 7_000,
      estimatedOutputTokens: 1_000,
    });
    const auction = await startSession(
      [
        ...SESSION_PARTICIPANTS.map(() => succeeds(output)),
        succeeds(JSON.stringify(freeChatPayload("Awarded answer", true))),
      ],
      {
        ...CREATE_FREE_CHAT_REQUEST,
        policy: {
          sessionProtocol: "free_chat",
          maxTurns: 10,
          auctionPolicy: {
            ...DEFAULT_SESSION_AUCTION_POLICY,
            routingMode: "auction",
          },
        },
      },
    );
    const details = await settle(auction.service, auction.runId);

    expect(details.run.status).toBe("awaiting_input");
    const bidTurns = details.turns.slice(0, SESSION_PARTICIPANTS.length);
    expect(bidTurns.every(
      ({ kind, wavePurpose, status }) =>
        kind === "session_bid" && wavePurpose === "session_bidding" && status === "committed",
    )).toBe(true);
    const bids = details.artifacts.filter(({ type }) => type === "session_bid");
    expect(bids).toHaveLength(SESSION_PARTICIPANTS.length);
    expect(bids.every(({ transcriptSequence }) => transcriptSequence === undefined)).toBe(true);
    expect(auction.runtime.starts.slice(0, SESSION_PARTICIPANTS.length)
      .every(({ threadPolicy }) => threadPolicy === "fresh")).toBe(true);
    // Exactly one award, and the awarded execution runs on the Agent's own thread.
    expect(details.artifacts.filter(({ type }) => type === "session_award")).toHaveLength(1);
    expect(details.turns).toHaveLength(SESSION_PARTICIPANTS.length + 1);
    expect(details.turns.at(-1)).toMatchObject({
      kind: "session_turn",
      status: "committed",
      agentId: PARTICIPANT_ONE.id,
    });
    // PA14-11: the awarded execution starts fresh too — its prompt carries the
    // full transcript and the winning plan, so it needs no private history.
    expect(auction.runtime.starts.at(-1)?.threadPolicy).toBe("fresh");
  });

  it("retries invalid bids within the original opportunity and bid-attempt ceiling", async () => {
    const invalid = JSON.stringify({
      schemaVersion: 1,
      type: "session_bid",
      recommendation: "auction",
      plan: {
        summary: "Invalid confidence first.",
        mode: "sequential",
        assignments: [{
          agentId: PARTICIPANT_ONE.id,
          position: 1,
          instruction: "Answer.",
        }],
        risks: [],
        assumptions: [],
      },
      confidenceBps: 10_001,
      estimatedOutputTokens: 1_000,
    });
    const valid = invalid.replace('"confidenceBps":10001', '"confidenceBps":7000');
    const auction = await startSession(
      [
        ...SESSION_PARTICIPANTS.map(() => succeeds(invalid)),
        ...SESSION_PARTICIPANTS.map(() => succeeds(valid)),
        succeeds(JSON.stringify(freeChatPayload("Awarded answer", true))),
      ],
      {
        ...CREATE_FREE_CHAT_REQUEST,
        policy: {
          sessionProtocol: "free_chat",
          maxTurns: 10,
          maxAttemptsPerTurn: 3,
          auctionPolicy: {
            ...DEFAULT_SESSION_AUCTION_POLICY,
            routingMode: "auction",
            maxBidAttempts: 2,
          },
        },
      },
    );
    const details = await settle(auction.service, auction.runId);

    // Three bidders retried once each inside their single opportunity, then the
    // awarded execution added exactly one further turn.
    expect(details.turns).toHaveLength(SESSION_PARTICIPANTS.length + 1);
    expect(details.turns.map(({ attemptCount }) => attemptCount)).toEqual([2, 2, 2, 1]);
    expect(details.attempts).toHaveLength(SESSION_PARTICIPANTS.length * 2 + 1);
    expect(details.attempts.filter(({ status }) => status === "invalid_output")).toHaveLength(3);
    expect(auction.runtime.starts.slice(3, 6).every(
      ({ prompt }) => prompt.includes("confidenceBps:"),
    )).toBe(true);
  });

  it("commits a real in-memory ten-turn transcript in round-robin order", async () => {
    const { service, runtime, runId } = await startSession(messageSteps(10), longSessionRequest(10));
    const details = await settle(service, runId);
    expect(details.run.status).toBe("failed");
    expect(details.run.errorCode).toBe("MAX_TURNS_EXCEEDED");
    expect(details.turns).toHaveLength(10);
    expect(details.artifacts
      .filter((artifact) => artifact.type === "session_message")
      .map((artifact) => (artifact.type === "session_message" ? artifact.payload.content : "")))
      .toEqual(Array.from({ length: 10 }, (_unused, index) => `Contribution ${index + 1}`));
    expect(runtime.starts.map(({ agentId }) => agentId)).toEqual([
      PARTICIPANT_ONE.id,
      PARTICIPANT_TWO.id,
      PARTICIPANT_THREE.id,
      PARTICIPANT_ONE.id,
      PARTICIPANT_TWO.id,
      PARTICIPANT_THREE.id,
      PARTICIPANT_ONE.id,
      PARTICIPANT_TWO.id,
      PARTICIPANT_THREE.id,
      PARTICIPANT_ONE.id,
    ]);
  });

  it("retries invalid output on the same Agent and logical turn, then succeeds", async () => {
    const steps = [succeeds(PROSE_MESSAGE_OUTPUT), ...messageSteps(3)];
    const { service, runtime, runId } = await startSession(steps, longSessionRequest(3));
    const details = await settle(service, runId);
    expect(details.turns[0]?.attemptCount).toBe(2);
    expect(details.attempts.slice(0, 2).map(({ status }) => status)).toEqual([
      "invalid_output",
      "succeeded",
    ]);
    expect(runtime.starts.slice(0, 2).map(({ agentId }) => agentId)).toEqual([
      PARTICIPANT_ONE.id,
      PARTICIPANT_ONE.id,
    ]);
    expect(runtime.starts[1]?.prompt).toContain(
      "Your previous attempt did not produce a valid artifact",
    );
  });

  it("fails after two malformed outputs without committing", async () => {
    for (const output of [EMPTY_CONTENT_OUTPUT, PROSE_MESSAGE_OUTPUT]) {
      const { service, runId } = await startSession([succeeds(output), succeeds(output)]);
      const details = await settle(service, runId);
      expect(details.run).toMatchObject({ status: "failed", errorCode: "MAX_ATTEMPTS_EXCEEDED" });
      expect(details.attempts.map(({ status }) => status)).toEqual([
        "invalid_output",
        "invalid_output",
      ]);
      // The user prompt is durable; nothing the Agent produced was committed.
      expect(details.artifacts.filter(({ type }) => type === "session_message")).toEqual([]);
    }
  });

  it("retries a timeout on the same participant", async () => {
    const { service, runtime, runId } = await startSession([
      timesOut("Attempt exceeded its time limit"),
      ...messageSteps(3),
    ], longSessionRequest(3));
    const details = await settle(service, runId);
    expect(details.attempts[0]?.status).toBe("timed_out");
    expect(runtime.starts[0]?.agentId).toBe(runtime.starts[1]?.agentId);
  });

  it("fails after two timed-out attempts", async () => {
    const { service, runId } = await startSession([
      timesOut("First timeout"),
      timesOut("Second timeout"),
    ]);
    const details = await settle(service, runId);
    expect(details.run).toMatchObject({ status: "failed", errorCode: "MAX_ATTEMPTS_EXCEEDED" });
    expect(details.attempts.map(({ status }) => status)).toEqual(["timed_out", "timed_out"]);
  });

  it("stops a deferred session attempt and ignores its late result", async () => {
    const { service, runtime, runId } = await startSession([deferred()]);
    await runtime.waitForStarts(1);
    expect((await service.stopRun(runId)).status).toBe("awaiting_input");
    const pending = runtime.pendingAttemptIds()[0];
    expect(pending).toBeDefined();
    runtime.resolveAttempt(pending!, { kind: "succeeded", rawOutput: VALID_MESSAGE_OUTPUT });
    await flush();
    const details = await service.getRun(runId);
    expect(details?.run.status).toBe("awaiting_input");
    expect(details?.artifacts.filter(({ type }) => type === "session_message")).toEqual([]);
    expect(details?.attempts[0]?.status).toBe("cancelled");
  });

  it("fails free chat at maxTurns and awaits input after a unanimous done wave", async () => {
    const atLimit = await startSession([
      succeeds(JSON.stringify(freeChatPayload("One"))),
      succeeds(JSON.stringify(freeChatPayload("Two"))),
      succeeds(JSON.stringify(freeChatPayload("Three"))),
    ], {
      ...CREATE_FREE_CHAT_REQUEST,
      policy: { sessionProtocol: "free_chat", maxTurns: 3 },
    });
    const limitDetails = await settle(atLimit.service, atLimit.runId);
    expect(limitDetails.run).toMatchObject({ status: "failed", errorCode: "MAX_TURNS_EXCEEDED" });

    const unanimous = await startSession(
      UNANIMOUS_DONE_ROUND.map((payload) => succeeds(JSON.stringify(payload))),
      { ...CREATE_FREE_CHAT_REQUEST, policy: { sessionProtocol: "free_chat", maxTurns: 6 } },
    );
    const unanimousDetails = await settle(unanimous.service, unanimous.runId);
    expect(unanimousDetails.run.status).toBe("awaiting_input");
    expect(unanimousDetails.turns).toHaveLength(3);
    expect(unanimousDetails.run.finalArtifactId).toBeUndefined();
  });

  it("retries and fails malformed free-chat output", async () => {
    const malformed = "Here is my message: {\"schemaVersion\":1}";
    const { service, runId } = await startSession(
      [succeeds(malformed), succeeds(malformed)],
      CREATE_FREE_CHAT_REQUEST,
    );
    const details = await settle(service, runId);
    expect(details.run).toMatchObject({ status: "failed", errorCode: "MAX_ATTEMPTS_EXCEEDED" });
    expect(details.attempts.map(({ status }) => status)).toEqual([
      "invalid_output",
      "invalid_output",
    ]);
  });
});
