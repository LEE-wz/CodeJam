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
  attempts: [{
    id: "attempt-1",
    runId,
    turnId: "turn-1",
    number: 1,
    agentId: "planner",
    leaseToken: "lease-secret",
    status: "succeeded",
    usage: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 40 },
    createdAt: "2026-08-29T00:00:00.000Z",
    finishedAt: "2026-08-29T00:00:01.000Z",
  }],
  usageTotals: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 40 },
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
    expect(detailResponse.json()).toMatchObject({
      run: { id: runId },
      attempts: [{ usage: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 40 } }],
      usageTotals: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 40 },
      events: [],
    });
    expect(detailResponse.body).not.toContain("lease-secret");
    expect(detailResponse.body).not.toContain("leaseToken");
    expect(detailResponse.body).not.toContain("threadId");
    expect(detailResponse.body).not.toContain("prompt");
    expect(detailResponse.body).not.toContain("rawOutput");

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

  describe("PA14-14 and PA14-17 auction request surface", () => {
    const buildApp = async () => {
      const calls: Array<Record<string, unknown>> = [];
      const coordination = {
        initialize: async () => undefined,
        listRuns: async () => [run],
        getRun: async () => details,
        createRun: async () => run,
        startRun: async () => run,
        stopRun: async () => run,
        resumeRun: async (id: string, input: Record<string, unknown>) => {
          calls.push({ kind: "resume", id, ...input });
          return run;
        },
        endRun: async () => run,
        recordAwardFeedback: async (input: Record<string, unknown>) => {
          calls.push({ kind: "feedback", ...input });
          return run;
        },
      } as unknown as CoordinationServiceContract;
      const app = await createApp(
        loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
        agentService,
        coordination,
      );
      return { app, calls, headers: { authorization: "Bearer a-strong-test-token" } };
    };

    it("passes bounded routing through and rejects any budget escalation", async () => {
      const { app, calls, headers } = await buildApp();

      const accepted = await app.inject({
        method: "POST",
        url: `/api/coordination-runs/${runId}/messages`,
        headers,
        payload: {
          content: "Draft the rollback plan",
          routing: {
            routingMode: "auction",
            selectedAgentId: "planner",
            coordinationPreference: "team",
            riskLevel: "high",
          },
        },
      });
      expect(accepted.statusCode).toBe(202);
      expect(calls[0]).toMatchObject({
        kind: "resume",
        routing: { routingMode: "auction", selectedAgentId: "planner" },
      });

      // Every budget-shaped field is an unknown key on a strict object.
      for (const routing of [
        { maxBidOutputTokens: 9_999 },
        { auctionExecutionTokenBudget: 9_999 },
        { maxBidAttempts: 9 },
        { minimumValidBids: 1 },
        { maxParallelTurns: 10 },
        { participants: ["planner"] },
      ]) {
        const rejected = await app.inject({
          method: "POST",
          url: `/api/coordination-runs/${runId}/messages`,
          headers,
          payload: { content: "Escalate", routing },
        });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
      }
      await app.close();
    });

    it("refuses direct routing on a message marked high-risk", async () => {
      const { app, headers } = await buildApp();
      const response = await app.inject({
        method: "POST",
        url: `/api/coordination-runs/${runId}/messages`,
        headers,
        payload: {
          content: "Risky change",
          routing: { routingMode: "direct", riskLevel: "high" },
        },
      });
      expect(response.statusCode).toBe(400);
      await app.close();
    });

    it("accepts a bounded award rating and rejects an unknown decision", async () => {
      const { app, calls, headers } = await buildApp();

      const accepted = await app.inject({
        method: "POST",
        url: `/api/coordination-runs/${runId}/awards/award-1/feedback`,
        headers,
        payload: { decision: "accepted" },
      });
      expect(accepted.statusCode).toBe(202);
      expect(calls[0]).toMatchObject({
        kind: "feedback",
        awardArtifactId: "award-1",
        decision: "accepted",
      });

      const rejected = await app.inject({
        method: "POST",
        url: `/api/coordination-runs/${runId}/awards/award-1/feedback`,
        headers,
        payload: { decision: "excellent" },
      });
      expect(rejected.statusCode).toBe(400);
      await app.close();
    });
  });
});
