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
  SESSION_CONTEXT_MAX_CHARS,
  SESSION_LIMITS,
} from "./types.js";
import { AdvancingClock, DeterministicIdGenerator } from "./testing/controls.js";
import {
  FakeAgentDirectory,
  ScriptedCoordinationRuntime,
  deferred,
  failsToStart,
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
  sessionParticipantRoster,
} from "./testing/session-fixtures.js";

const settled = new Set(["awaiting_input", "completed", "failed", "stopped"]);

const sessionHarness = (
  steps: ScriptedRuntimeStep[],
  contextBuilder: ContextBuilder = new RoleScopedContextBuilder(),
  participants = SESSION_PARTICIPANTS,
) => {
  const clock = new AdvancingClock();
  const ids = new DeterministicIdGenerator();
  const repository = new InMemoryCoordinationRepository(clock);
  const runtime = new ScriptedCoordinationRuntime(steps);
  const verifiedProtocol = new VerifiedHandoffArtifactProtocol({ clock, ids });
  const sessionProtocol = new SharedSessionArtifactProtocol({ clock, ids });
  const service = new CoordinationService({
    agentDirectory: new FakeAgentDirectory(participants),
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
  participants = SESSION_PARTICIPANTS,
) => {
  const context = sessionHarness(steps, new RoleScopedContextBuilder(), participants);
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
    expect(freeChatRun.policy).toMatchObject({ sessionParallel: false, maxParallelTurns: 3 });
  });

  it("defaults the parallel worker ceiling to the smaller of the roster and four", async () => {
    const roster = sessionParticipantRoster(6);
    const run = await sessionHarness([], new RoleScopedContextBuilder(), roster).service.createRun({
      ...CREATE_FREE_CHAT_REQUEST,
      agents: roster.map(({ id }) => id),
      policy: { sessionProtocol: "free_chat" },
    });
    expect(run.policy.maxParallelTurns).toBe(4);

    await expect(sessionHarness([]).service.createRun({
      ...CREATE_FREE_CHAT_REQUEST,
      policy: { sessionProtocol: "free_chat", maxParallelTurns: 11 },
    })).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });
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

  it("executes one free-chat wave with a bounded worker pool and settles every sibling", async () => {
    const roster = sessionParticipantRoster(6);
    const context = sessionHarness(
      Array.from({ length: 6 }, () => deferred()),
      new RoleScopedContextBuilder(),
      roster,
    );
    const run = await context.service.createRun({
      ...CREATE_FREE_CHAT_REQUEST,
      agents: roster.map(({ id }) => id),
      policy: {
        sessionProtocol: "free_chat",
        maxTurns: 12,
        sessionParallel: true,
        maxParallelTurns: 2,
      },
    });
    await context.service.resumeRun(run.id, { content: "Give one launch recommendation each." });

    const resolvePending = (): void => {
      for (const attemptId of context.runtime.pendingAttemptIds()) {
        context.runtime.resolveAttempt(attemptId, {
          kind: "succeeded",
          rawOutput: JSON.stringify(freeChatPayload(`Message from ${attemptId}`)),
        });
      }
    };
    await context.runtime.waitForStarts(2);
    expect(context.runtime.peakConcurrency).toBe(2);
    resolvePending();
    await context.runtime.waitForStarts(4);
    resolvePending();
    await context.runtime.waitForStarts(6);
    resolvePending();

    const details = await settle(context.service, run.id);
    expect(details.run).toMatchObject({ status: "awaiting_input", activeTurnIds: [] });
    expect(details.turns.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(details.turns.map(({ agentId }) => agentId)).size).toBe(6);
    expect(details.artifacts.filter(({ type }) => type === "session_message")).toHaveLength(6);
    expect(context.runtime.peakConcurrency).toBe(2);
    expect(context.runtime.activeAttemptCount()).toBe(0);
  });

  it("cancels every running sibling when a parallel wave is stopped", async () => {
    const context = sessionHarness([deferred(), deferred(), deferred()]);
    const run = await context.service.createRun({
      ...CREATE_FREE_CHAT_REQUEST,
      policy: {
        sessionProtocol: "free_chat",
        maxTurns: 6,
        sessionParallel: true,
        maxParallelTurns: 3,
      },
    });
    await context.service.resumeRun(run.id, { content: "Assess the launch plan." });
    await context.runtime.waitForStarts(3);

    const stopped = await context.service.stopRun(run.id);
    expect(stopped).toMatchObject({ status: "awaiting_input", activeTurnIds: [] });
    expect(context.runtime.cancelledAttemptIds).toHaveLength(3);
    expect(new Set(context.runtime.cancelledAttemptIds).size).toBe(3);

    const details = await context.service.getRun(run.id);
    expect(details?.turns.map(({ status }) => status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(details?.attempts.map(({ status }) => status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
  });

  it("waits for a successful sibling before failing a wave with exhausted retries", async () => {
    const roster = sessionParticipantRoster(2);
    const { service, runtime, runId } = await startSession([
      timesOut("First participant timed out"),
      succeeds(JSON.stringify(freeChatPayload("Second participant committed"))),
      timesOut("First participant timed out again"),
    ], {
      ...CREATE_FREE_CHAT_REQUEST,
      agents: roster.map(({ id }) => id),
      policy: {
        sessionProtocol: "free_chat",
        maxTurns: 6,
        sessionParallel: true,
        maxParallelTurns: 2,
      },
    }, roster);
    const details = await settle(service, runId);
    expect(details.run).toMatchObject({ status: "failed", errorCode: "MAX_ATTEMPTS_EXCEEDED" });
    expect(details.attempts.map(({ status }) => status)).toEqual([
      "timed_out",
      "succeeded",
      "timed_out",
    ]);
    expect(details.artifacts.filter(({ type }) => type === "session_message")).toHaveLength(1);
    expect(runtime.starts).toHaveLength(3);
  });

  it("retries a busy Agent without preventing its wave siblings from settling", async () => {
    const { service, runtime, runId } = await startSession([
      failsToStart("This Agent is already running"),
      succeeds(JSON.stringify(freeChatPayload("Second participant"))),
      succeeds(JSON.stringify(freeChatPayload("Third participant"))),
      succeeds(JSON.stringify(freeChatPayload("Retried first participant"))),
    ], {
      ...CREATE_FREE_CHAT_REQUEST,
      policy: {
        sessionProtocol: "free_chat",
        maxTurns: 6,
        sessionParallel: true,
        maxParallelTurns: 3,
      },
    });
    await runtime.waitForStarts(4);
    const details = await settle(service, runId);
    expect(details.run).toMatchObject({ status: "awaiting_input", activeTurnIds: [] });
    expect(details.attempts.map(({ status }) => status)).toEqual([
      "failed",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(runtime.starts).toHaveLength(4);
    expect(details.artifacts.filter(({ type }) => type === "session_message")).toHaveLength(3);
  });
});
