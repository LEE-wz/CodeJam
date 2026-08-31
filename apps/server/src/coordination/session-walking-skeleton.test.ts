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
  COUNTDOWN_TRANSCRIPT,
  CREATE_COUNTDOWN_REQUEST,
  CREATE_FREE_CHAT_REQUEST,
  PARTICIPANT_ONE,
  PARTICIPANT_THREE,
  PARTICIPANT_TWO,
  PROSE_COUNTDOWN_OUTPUT,
  SESSION_PARTICIPANTS,
  UNANIMOUS_DONE_ROUND,
  VALID_COUNTDOWN_OUTPUT,
  WRONG_NUMBER_OUTPUT,
  countdownPayload,
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
  request: CreateSessionRunRequest = CREATE_COUNTDOWN_REQUEST,
) => {
  const context = sessionHarness(steps);
  const run = await context.service.createRun(request);
  if (request.policy?.sessionProtocol === "free_chat") {
    await context.service.resumeRun(run.id, { content: "Work on the shared objective" });
  } else {
    await context.service.startRun(run.id);
  }
  return { ...context, runId: run.id };
};

const countdownSteps = (payloads = COUNTDOWN_TRANSCRIPT): ScriptedRuntimeStep[] =>
  payloads.map((payload) => succeeds(JSON.stringify(payload)));

describe("session create validation and context probe", () => {
  it("validates and normalizes countdown and free-chat policy defaults", async () => {
    const countdown = sessionHarness([]);
    const countdownRun = await countdown.service.createRun({
      ...CREATE_COUNTDOWN_REQUEST,
      name: "  Countdown  ",
      policy: undefined,
    });
    expect(countdownRun).toMatchObject({
      name: "Countdown",
      phase: "sessioning",
      revision: 0,
      sharedState: { nextExpectedNumber: 10 },
      policy: { sessionProtocol: "countdown", sessionStartValue: 10, maxTurns: 10 },
    });

    const freeChat = sessionHarness([]);
    const freeChatRun = await freeChat.service.createRun({
      ...CREATE_FREE_CHAT_REQUEST,
      policy: { sessionProtocol: "free_chat" },
    });
    expect(freeChatRun.sharedState).toBeUndefined();
    expect(freeChatRun.policy).toMatchObject({
      sessionProtocol: "free_chat",
      maxTurns: SESSION_LIMITS.defaultSessionTurns,
    });
    expect(freeChatRun.policy.sessionStartValue).toBeUndefined();
  });

  it.each([
    { policy: { sessionStartValue: 1 }, label: "start below range" },
    { policy: { sessionStartValue: 13 }, label: "start above range" },
    { policy: { sessionStartValue: 2.5 }, label: "non-integer start" },
    { policy: { sessionStartValue: 5, maxTurns: 4 }, label: "turns below start" },
    {
      policy: { sessionStartValue: 10, maxTurns: SESSION_LIMITS.maxSessionTurns + 1 },
      label: "turns above range",
    },
    { policy: { perAttemptTimeoutMs: 9_999 }, label: "timeout below range" },
    { policy: { perAttemptTimeoutMs: 180_001 }, label: "timeout above range" },
  ])("rejects countdown $label", async ({ policy }) => {
    await expect(sessionHarness([]).service.createRun({
      ...CREATE_COUNTDOWN_REQUEST,
      policy,
    })).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });
  });

  it("rejects free-chat start values and turn limits outside the session range", async () => {
    for (const policy of [
      { sessionProtocol: "free_chat" as const, sessionStartValue: 3 },
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
      { ...CREATE_COUNTDOWN_REQUEST, name: " " },
      { ...CREATE_COUNTDOWN_REQUEST, name: "n".repeat(81) },
      { ...CREATE_COUNTDOWN_REQUEST, objective: " " },
      { ...CREATE_COUNTDOWN_REQUEST, objective: "o".repeat(4_001) },
      { ...CREATE_COUNTDOWN_REQUEST, requiredSections: [] },
      { ...CREATE_COUNTDOWN_REQUEST, policy: { maxRevisions: 1 } },
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
    await context.service.createRun(CREATE_COUNTDOWN_REQUEST);
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
      SESSION_PARTICIPANTS.map(() => succeeds(output)),
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

    expect(details.run).toMatchObject({
      status: "failed",
      errorCode: "INVALID_STATE",
      errorMessage: "Settled bids require the PA14 award decision",
    });
    expect(details.turns).toHaveLength(SESSION_PARTICIPANTS.length);
    expect(details.turns.every(
      ({ kind, wavePurpose, status }) =>
        kind === "session_bid" && wavePurpose === "session_bidding" && status === "committed",
    )).toBe(true);
    const bids = details.artifacts.filter(({ type }) => type === "session_bid");
    expect(bids).toHaveLength(SESSION_PARTICIPANTS.length);
    expect(bids.every(({ transcriptSequence }) => transcriptSequence === undefined)).toBe(true);
    expect(auction.runtime.starts).toHaveLength(SESSION_PARTICIPANTS.length);
    expect(auction.runtime.starts.every(({ threadPolicy }) => threadPolicy === "fresh")).toBe(true);
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

    expect(details.turns).toHaveLength(SESSION_PARTICIPANTS.length);
    expect(details.turns.map(({ attemptCount }) => attemptCount)).toEqual([2, 2, 2]);
    expect(details.attempts).toHaveLength(SESSION_PARTICIPANTS.length * 2);
    expect(details.attempts.filter(({ status }) => status === "invalid_output")).toHaveLength(3);
    expect(auction.runtime.starts.slice(3).every(
      ({ prompt }) => prompt.includes("confidenceBps:"),
    )).toBe(true);
  });

  it("completes a real in-memory 10-to-1 countdown in round-robin order", async () => {
    const { service, runtime, runId } = await startSession(countdownSteps());
    const details = await settle(service, runId);
    expect(details.run.status).toBe("completed");
    expect(details.run.phase).toBe("done");
    expect(details.run.sharedState?.nextExpectedNumber).toBe(0);
    expect(details.turns).toHaveLength(10);
    expect(details.artifacts.map((artifact) => artifact.type === "session_message" && artifact.payload.content))
      .toEqual(["10", "9", "8", "7", "6", "5", "4", "3", "2", "1"]);
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
    expect(details.run.finalArtifactId).toBe(details.artifacts.at(-1)?.id);
  });

  it("retries a wrong number on the same Agent and logical turn, then succeeds", async () => {
    const steps = [
      succeeds(WRONG_NUMBER_OUTPUT),
      succeeds(VALID_COUNTDOWN_OUTPUT),
      ...countdownSteps(COUNTDOWN_TRANSCRIPT.slice(1)),
    ];
    const { service, runtime, runId } = await startSession(steps);
    const details = await settle(service, runId);
    expect(details.run.status).toBe("completed");
    expect(details.turns[0]?.attemptCount).toBe(2);
    expect(details.attempts.slice(0, 2).map(({ status }) => status)).toEqual([
      "invalid_output",
      "succeeded",
    ]);
    expect(runtime.starts.slice(0, 2).map(({ agentId }) => agentId)).toEqual([
      PARTICIPANT_ONE.id,
      PARTICIPANT_ONE.id,
    ]);
    expect(runtime.starts[1]?.prompt).toContain("Expected the next number 10, received 6");
  });

  it("fails after two wrong or malformed outputs without committing", async () => {
    for (const output of [WRONG_NUMBER_OUTPUT, PROSE_COUNTDOWN_OUTPUT]) {
      const { service, runId } = await startSession([succeeds(output), succeeds(output)]);
      const details = await settle(service, runId);
      expect(details.run).toMatchObject({ status: "failed", errorCode: "MAX_ATTEMPTS_EXCEEDED" });
      expect(details.attempts.map(({ status }) => status)).toEqual([
        "invalid_output",
        "invalid_output",
      ]);
      expect(details.artifacts).toEqual([]);
    }
  });

  it("retries a timeout on the same participant", async () => {
    const { service, runtime, runId } = await startSession([
      timesOut("Attempt exceeded its time limit"),
      succeeds(VALID_COUNTDOWN_OUTPUT),
      ...countdownSteps(COUNTDOWN_TRANSCRIPT.slice(1)),
    ]);
    const details = await settle(service, runId);
    expect(details.run.status).toBe("completed");
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
    runtime.resolveAttempt(pending!, { kind: "succeeded", rawOutput: VALID_COUNTDOWN_OUTPUT });
    await flush();
    const details = await service.getRun(runId);
    expect(details?.run.status).toBe("awaiting_input");
    expect(details?.artifacts).toEqual([]);
    expect(details?.attempts[0]?.status).toBe("cancelled");
  });

  it("fails a countdown that reaches its turn ceiling before one", async () => {
    const context = sessionHarness(countdownSteps([countdownPayload(4), countdownPayload(3), countdownPayload(2)]));
    const timestamp = context.clock.nowIso();
    const run: CoordinationRun = {
      id: context.ids.runId(),
      name: "Ceiling",
      objective: "Count down together.",
      requiredSections: [],
      participants: SESSION_PARTICIPANTS.map((agent) => ({
        role: "participant",
        agentId: agent.id,
        agentNameSnapshot: agent.name,
      })),
      policy: {
        ...DEFAULT_COORDINATION_POLICY,
        workflow: "shared_session_v1",
        sessionProtocol: "countdown",
        sessionStartValue: 4,
        maxTurns: 3,
        maxRevisions: 0,
      },
      status: "created",
      phase: "sessioning",
      revision: 0,
      nextTurnSequence: 1,
      activeTurnIds: [],
      sharedState: { nextExpectedNumber: 4 },
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await context.repository.createRun({ run });
    await context.service.startRun(run.id);
    const details = await settle(context.service, run.id);
    expect(details.run).toMatchObject({ status: "failed", errorCode: "MAX_TURNS_EXCEEDED" });
    expect(details.artifacts).toHaveLength(3);
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
