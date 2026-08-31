import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { AgentService } from "../agent-service.js";
import { loadConfig } from "../config.js";
import type { CoordinationServiceContract } from "./contracts.js";
import type { CoordinationRun, CoordinationRunDetails } from "./types.js";

const runId = "11111111-1111-4111-8111-111111111111";
const run: CoordinationRun = {
  id: runId,
  name: "Launch review",
  objective: "Prepare a launch plan",
  requiredSections: [{ key: "users", title: "Users" }],
  participants: [
    { role: "planner", agentId: "planner", agentNameSnapshot: "Planner" },
    { role: "critic", agentId: "critic", agentNameSnapshot: "Critic" },
    { role: "finalizer", agentId: "finalizer", agentNameSnapshot: "Finalizer" },
  ],
  policy: {
    workflow: "verified_handoff_v1",
    maxRevisions: 2,
    maxTurns: 8,
    maxAttemptsPerTurn: 2,
    perAttemptTimeoutMs: 120_000,
    contextMaxChars: 12_000,
    outputMaxChars: 20_000,
  },
  status: "created",
  phase: "drafting",
  revision: 0,
  nextTurnSequence: 1,
  activeTurnIds: [],
  version: 1,
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

const details: CoordinationRunDetails = {
  run,
  turns: [],
  attempts: [],
  artifacts: [],
  events: [],
};

const agentService = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("Coordination HTTP routes", () => {
  it("validates, authenticates, and exposes the asynchronous run lifecycle", async () => {
    let created = false;
    let started = false;
    const coordination: CoordinationServiceContract = {
      initialize: async () => undefined,
      listRuns: async () => [run],
      getRun: async (id) => (id === runId ? details : undefined),
      createRun: async (input) => {
        created = true;
        expect(input.agents.plannerAgentId).toBe("planner");
        return run;
      },
      startRun: async (id) => {
        expect(id).toBe(runId);
        started = true;
        return { ...run, status: "running" };
      },
      stopRun: async () => ({ ...run, status: "stopped" }),
    };
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      agentService,
      coordination,
    );
    const headers = { authorization: "Bearer a-strong-test-token" };

    const denied = await app.inject({ method: "GET", url: "/api/coordination-runs" });
    expect(denied.statusCode).toBe(401);

    const malformed = await app.inject({
      method: "POST",
      url: "/api/coordination-runs",
      headers,
      payload: { name: "x" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/coordination-runs",
      headers,
      payload: {
        name: "Launch review",
        objective: "Prepare a launch plan",
        requiredSections: [{ key: "users", title: "Users" }],
        agents: {
          plannerAgentId: "planner",
          criticAgentId: "critic",
          finalizerAgentId: "finalizer",
        },
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    expect(createdResponse.json()).toMatchObject({ run: { id: runId } });
    expect(created).toBe(true);

    const startedResponse = await app.inject({
      method: "POST",
      url: "/api/coordination-runs/" + runId + "/start",
      headers,
    });
    expect(startedResponse.statusCode).toBe(202);
    expect(startedResponse.json()).toMatchObject({ accepted: true, run: { status: "running" } });
    expect(started).toBe(true);

    const detailResponse = await app.inject({
      method: "GET",
      url: "/api/coordination-runs/" + runId,
      headers,
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({ run: { id: runId }, events: [] });

    const removedEventsResponse = await app.inject({
      method: "GET",
      url: "/api/coordination-runs/" + runId + "/events",
      headers,
    });
    expect(removedEventsResponse.statusCode).toBe(404);
    await app.close();
  });

  it.each(["completed", "failed", "stopped"] as const)(
    "treats stop as idempotent for a %s run",
    async (status) => {
      const terminalRun: CoordinationRun = { ...run, status };
      const coordination: CoordinationServiceContract = {
        initialize: async () => undefined,
        listRuns: async () => [terminalRun],
        getRun: async () => ({ ...details, run: terminalRun }),
        createRun: async () => terminalRun,
        startRun: async () => terminalRun,
        stopRun: async () => terminalRun,
      };
      const app = await createApp(
        loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
        agentService,
        coordination,
      );

      const response = await app.inject({
        method: "POST",
        url: "/api/coordination-runs/" + runId + "/stop",
        headers: { authorization: "Bearer a-strong-test-token" },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ accepted: true, run: { status } });
      await app.close();
    },
  );

  it("accepts bounded parallel-session policy and rejects an over-limit worker cap", async () => {
    let received: unknown;
    const coordination: CoordinationServiceContract = {
      initialize: async () => undefined,
      listRuns: async () => [],
      getRun: async () => undefined,
      createRun: async (input) => {
        received = input;
        return run;
      },
      startRun: async () => run,
      stopRun: async () => run,
    };
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      agentService,
      coordination,
    );
    const headers = { authorization: "Bearer a-strong-test-token" };
    const body = {
      workflow: "shared_session_v1",
      name: "Parallel launch review",
      objective: "Give one launch risk each.",
      agents: ["planner", "critic", "finalizer"],
      policy: {
        sessionProtocol: "free_chat",
        maxTurns: 6,
        sessionParallel: true,
        maxParallelTurns: 2,
      },
    };

    expect((await app.inject({ method: "POST", url: "/api/coordination-runs", headers, payload: body })).statusCode)
      .toBe(201);
    expect(received).toMatchObject({ policy: { sessionParallel: true, maxParallelTurns: 2 } });
    const invalid = await app.inject({
      method: "POST",
      url: "/api/coordination-runs",
      headers,
      payload: { ...body, policy: { ...body.policy, maxParallelTurns: 11 } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    await app.close();
  });
});
