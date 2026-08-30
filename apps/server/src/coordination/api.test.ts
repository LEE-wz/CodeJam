import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentService } from "../agent-service.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type { Agent } from "../types.js";
import { VerifiedHandoffArtifactProtocol } from "./artifact-protocol.js";
import { RoleScopedContextBuilder } from "./context-builder.js";
import type {
  Clock,
  CoordinationAgentDirectory,
  CoordinationServiceContract,
  IdGenerator,
} from "./contracts.js";
import { DurableCoordinationRepository } from "./repository.js";
import { CoordinationService } from "./service.js";
import type { CoordinationLogContext } from "./service.js";
import { AdvancingClock } from "./testing/controls.js";
import {
  ScriptedCoordinationRuntime,
  failsExecution,
  succeeds,
  type ScriptedRuntimeStep,
} from "./testing/fakes.js";
import {
  APPROVING_REVIEW_OUTPUT,
  CRITIC_AGENT,
  FINALIZER_AGENT,
  INVALID_ARTIFACT_OUTPUT,
  PLANNER_AGENT,
  REJECTING_REVIEW_OUTPUT,
  VALID_FINAL_OUTPUT,
  VALID_PROPOSAL_OUTPUT,
} from "./testing/fixtures.js";
import { VerifiedHandoffWorkflowV1 } from "./workflow.js";

const AUTH_TOKEN = "a-strong-test-token";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

const temporaryDirectories: string[] = [];
const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      // A background loop may still be persisting when a test ends; retry
      // rather than failing an unrelated assertion on ENOTEMPTY.
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 5 }),
      ),
  );
});

/** UUID-shaped but deterministic, because the frozen routes require UUID params. */
class SequentialUuidGenerator implements IdGenerator {
  private counter = 0;

  runId(): string {
    return this.next();
  }
  turnId(): string {
    return this.next();
  }
  attemptId(): string {
    return this.next();
  }
  artifactId(): string {
    return this.next();
  }
  eventId(): string {
    return this.next();
  }
  leaseToken(): string {
    return this.next();
  }

  private next(): string {
    this.counter += 1;
    const tail = String(this.counter).padStart(12, "0");
    return `11111111-1111-4111-8111-${tail}`;
  }
}

const agentRow = (id: string, name: string, status: Agent["status"] = "ready"): Agent => ({
  id,
  name,
  description: "",
  instructions: "",
  status,
  workspacePath: `/workspaces/${id}`,
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
});

const agentServiceStub = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

interface Stack {
  app: FastifyInstance;
  store: JsonStore;
  service: CoordinationService;
  runtime: ScriptedCoordinationRuntime;
  logs: Array<{ context: CoordinationLogContext; message: string }>;
}

/**
 * The Phase 2 composition root, assembled exactly as `index.ts` assembles it:
 * the real workflow, artifact protocol, context builder, and durable
 * repository over a real `JsonStore`, with only the runtime scripted.
 */
const createStack = async (steps: ScriptedRuntimeStep[] = []): Promise<Stack> => {
  const root = await mkdtemp(path.join(tmpdir(), "relay-api-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.agents.push(
      agentRow(PLANNER_AGENT.id, PLANNER_AGENT.name),
      agentRow(CRITIC_AGENT.id, CRITIC_AGENT.name),
      agentRow(FINALIZER_AGENT.id, FINALIZER_AGENT.name),
    );
  });

  const clock: Clock = new AdvancingClock();
  const ids = new SequentialUuidGenerator();
  const agentDirectory: CoordinationAgentDirectory = {
    getAgentsByIds: async (agentIds) => {
      const wanted = new Set(agentIds);
      return store
        .snapshot()
        .agents.filter((agent) => wanted.has(agent.id))
        .map((agent) => ({ id: agent.id, name: agent.name, status: agent.status }));
    },
  };

  const logs: Array<{ context: CoordinationLogContext; message: string }> = [];
  const runtime = new ScriptedCoordinationRuntime(steps);
  const service = new CoordinationService({
    agentDirectory,
    repository: new DurableCoordinationRepository({ store, clock, ids }),
    workflow: new VerifiedHandoffWorkflowV1(),
    contextBuilder: new RoleScopedContextBuilder(),
    artifactProtocol: new VerifiedHandoffArtifactProtocol({ clock, ids }),
    runtime,
    clock,
    ids,
    logger: {
      info: (context, message) => logs.push({ context, message }),
      error: (context, message) => logs.push({ context, message }),
    },
  });

  const app = await createApp(
    loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: AUTH_TOKEN }),
    agentServiceStub,
    service,
  );
  openApps.push(app);
  return { app, store, service, runtime, logs };
};

const CREATE_BODY = {
  name: "Launch plan review",
  objective: "Produce a practical launch plan for a student marketplace.",
  requiredSections: [
    { key: "users", title: "Target Users" },
    { key: "workflow", title: "Core Workflow" },
    { key: "risks", title: "Risks and Mitigations" },
  ],
  agents: {
    plannerAgentId: PLANNER_AGENT.id,
    criticAgentId: CRITIC_AGENT.id,
    finalizerAgentId: FINALIZER_AGENT.id,
  },
};

const TERMINAL = new Set(["completed", "failed", "stopped"]);

/**
 * Drives the background loop to a terminal state by yielding to the event loop.
 * The durable store performs real file I/O, so this yields to the macrotask
 * queue as well as the microtask queue. There is no sleep and no fixed delay.
 */
const settleHttp = async (
  app: FastifyInstance,
  runId: string,
  ticks = 4_000,
): Promise<Record<string, unknown>> => {
  for (let tick = 0; tick < ticks; tick += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/coordination-runs/${runId}`,
      headers,
    });
    const body = response.json() as { run: { status: string } };
    if (TERMINAL.has(body.run.status)) {
      return body as unknown as Record<string, unknown>;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("coordination run did not reach a terminal state");
};

const createRun = async (app: FastifyInstance, overrides: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: "/api/coordination-runs",
    headers,
    payload: { ...CREATE_BODY, ...overrides },
  });

// --------------------------------------------------------- P2-16 API surface

describe("coordination API authentication", () => {
  it("requires authentication on every coordination route", async () => {
    const { app } = await createStack();
    const routes = [
      { method: "GET" as const, url: "/api/coordination-runs" },
      { method: "POST" as const, url: "/api/coordination-runs" },
      { method: "GET" as const, url: "/api/coordination-runs/11111111-1111-4111-8111-000000000001" },
      {
        method: "POST" as const,
        url: "/api/coordination-runs/11111111-1111-4111-8111-000000000001/start",
      },
      {
        method: "POST" as const,
        url: "/api/coordination-runs/11111111-1111-4111-8111-000000000001/stop",
      },
    ];

    for (const route of routes) {
      const response = await app.inject(route);
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });
});

describe("create validation", () => {
  it("creates a run and persists it durably", async () => {
    const { app, store } = await createStack();
    const response = await createRun(app);

    expect(response.statusCode).toBe(201);
    const body = response.json() as { run: { id: string; status: string } };
    expect(body.run.status).toBe("created");
    expect(store.snapshot().coordinationRuns.map((run) => run.id)).toEqual([body.run.id]);
  });

  it("rejects duplicate Agents across roles with the frozen DUPLICATE_AGENT code", async () => {
    const { app } = await createStack();
    const response = await createRun(app, {
      agents: {
        plannerAgentId: PLANNER_AGENT.id,
        criticAgentId: PLANNER_AGENT.id,
        finalizerAgentId: FINALIZER_AGENT.id,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "DUPLICATE_AGENT" } });
  });

  it("rejects duplicate required section keys", async () => {
    const { app } = await createStack();
    const response = await createRun(app, {
      requiredSections: [
        { key: "risks", title: "Risks" },
        { key: "RISKS", title: "Risks again" },
      ],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });

  it.each([
    ["maxRevisions above its range", { maxRevisions: 9 }],
    ["maxTurns below its range", { maxTurns: 1 }],
    ["perAttemptTimeoutMs above its range", { perAttemptTimeoutMs: 999_999 }],
    ["a non-integer limit", { maxTurns: 4.5 }],
  ])("rejects %s", async (_label, policy) => {
    const { app } = await createStack();
    const response = await createRun(app, { policy });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });

  it("accepts a policy inside its range", async () => {
    const { app } = await createStack();
    const response = await createRun(app, { policy: { maxRevisions: 1, maxTurns: 6 } });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ run: { policy: { maxRevisions: 1, maxTurns: 6 } } });
  });

  it("rejects unknown body fields and reports the failing field", async () => {
    const { app } = await createStack();
    const response = await createRun(app, { unexpected: true });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { fieldErrors?: Record<string, string[]> } };
    expect(body.error.fieldErrors).toBeDefined();
  });

  it("reports a missing Agent as 404", async () => {
    const { app } = await createStack();
    const response = await createRun(app, {
      agents: {
        plannerAgentId: PLANNER_AGENT.id,
        criticAgentId: CRITIC_AGENT.id,
        finalizerAgentId: "agent-does-not-exist",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("rejects a body over the configured limit without reaching the service", async () => {
    const { app, store } = await createStack();
    const response = await app.inject({
      method: "POST",
      url: "/api/coordination-runs",
      headers,
      payload: { ...CREATE_BODY, objective: "x".repeat(1_200_000) },
    });

    expect(response.statusCode).toBe(413);
    expect(store.snapshot().coordinationRuns).toEqual([]);
  });
});

describe("detail, start, and stop statuses", () => {
  it("rejects a non-UUID identifier", async () => {
    const { app } = await createStack();
    const response = await app.inject({
      method: "GET",
      url: "/api/coordination-runs/not-a-uuid",
      headers,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });

  it("returns 404 for a well-formed but unknown identifier", async () => {
    const { app } = await createStack();
    const response = await app.inject({
      method: "GET",
      url: "/api/coordination-runs/22222222-2222-4222-8222-222222222222",
      headers,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("returns 404 when starting or stopping an unknown run", async () => {
    const { app } = await createStack();
    const unknown = "22222222-2222-4222-8222-222222222222";

    for (const action of ["start", "stop"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/coordination-runs/${unknown}/${action}`,
        headers,
      });
      expect(response.statusCode, action).toBe(404);
    }
  });

  it("returns 409 when a participant Agent is not ready", async () => {
    const { app, store } = await createStack();
    const created = (await createRun(app)).json() as { run: { id: string } };
    await store.mutate((database) => {
      const critic = database.agents.find((agent) => agent.id === CRITIC_AGENT.id);
      if (critic) critic.status = "stopped";
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${created.run.id}/start`,
      headers,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "AGENT_NOT_READY" } });
  });

  it("returns 409 when a participant Agent is reserved by another run", async () => {
    const { app, store } = await createStack([succeeds(VALID_PROPOSAL_OUTPUT)]);
    const first = (await createRun(app)).json() as { run: { id: string } };
    const second = (await createRun(app)).json() as { run: { id: string } };
    await store.mutate((database) => {
      // Free the Agents from the ordinary-run check so only the coordination
      // reservation can be the reason for the conflict.
      database.runs.length = 0;
    });

    const started = await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${first.run.id}/start`,
      headers,
    });
    expect(started.statusCode).toBe(202);

    const conflict = await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${second.run.id}/start`,
      headers,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "AGENT_RESERVED" } });

    // Settle the first run so the reservation is released and no background
    // work outlives the test.
    await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${first.run.id}/stop`,
      headers,
    });
    await settleHttp(app, first.run.id);
  });

  it("lists runs newest-first", async () => {
    const { app } = await createStack();
    const first = (await createRun(app, { name: "First" })).json() as { run: { id: string } };
    const second = (await createRun(app, { name: "Second" })).json() as { run: { id: string } };

    const response = await app.inject({ method: "GET", url: "/api/coordination-runs", headers });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { runs: Array<{ id: string }> };
    expect(body.runs.map((run) => run.id)).toEqual([second.run.id, first.run.id]);
  });

  it("returns a safe 500 envelope without leaking internals", async () => {
    const exploding: CoordinationServiceContract = {
      initialize: async () => undefined,
      listRuns: async () => {
        throw new Error("connection string postgres://user:hunter2@db/internal");
      },
      getRun: async () => undefined,
      createRun: async () => {
        throw new Error("unreachable");
      },
      startRun: async () => {
        throw new Error("unreachable");
      },
      stopRun: async () => {
        throw new Error("unreachable");
      },
    };
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: AUTH_TOKEN }),
      agentServiceStub,
      exploding,
    );
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/coordination-runs", headers });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Unexpected internal failure" },
    });
    expect(response.body).not.toContain("postgres");
    expect(response.body).not.toContain("hunter2");
  });
});

describe("production error envelope", () => {
  /**
   * `@fastify/static` refuses a missing root, and the web bundle is built after
   * the tests run. Provide a minimal stand-in when it is absent, and remove only
   * what this test created.
   */
  const webDist = fileURLToPath(new URL("../../../web/dist", import.meta.url));

  const ensureWebBundle = async (): Promise<() => Promise<void>> => {
    try {
      await access(webDist);
      return async () => undefined;
    } catch {
      await mkdir(webDist, { recursive: true });
      await writeFile(path.join(webDist, "index.html"), "<!doctype html>\n", "utf8");
      return async () => {
        await rm(webDist, { recursive: true, force: true });
      };
    }
  };

  it("keeps the frozen error envelope in production, where a not-found handler exists", async () => {
    const cleanup = await ensureWebBundle();
    try {
      const missing: CoordinationServiceContract = {
        initialize: async () => undefined,
        listRuns: async () => [],
        getRun: async () => undefined,
        createRun: async () => {
          throw new Error("unused");
        },
        startRun: async () => {
          throw new Error("unused");
        },
        stopRun: async () => {
          throw new Error("unused");
        },
      };
      const app = await createApp(
        loadConfig({
          NODE_ENV: "production",
          HOST: "127.0.0.1",
          APP_AUTH_TOKEN: AUTH_TOKEN,
        }),
        agentServiceStub,
        missing,
      );
      openApps.push(app);

      // Fastify's not-found context captures whichever error handler is
      // installed when `setNotFoundHandler` runs. Registering it before
      // `setErrorHandler` made this fall back to Fastify's default serializer.
      const response = await app.inject({
        method: "GET",
        url: "/api/coordination-runs/22222222-2222-4222-8222-222222222222",
        headers,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: { code: "NOT_FOUND", message: "Coordination run not found" },
      });

      const removedEventsRoute = await app.inject({
        method: "GET",
        url: "/api/coordination-runs/22222222-2222-4222-8222-222222222222/events",
        headers,
      });
      expect(removedEventsRoute.statusCode).toBe(404);
      expect(removedEventsRoute.json()).toEqual({
        error: { code: "NOT_FOUND", message: "Coordination route not found" },
      });
    } finally {
      await cleanup();
    }
  });
});

// -------------------------------------- P2-17 / P2-22 end-to-end evidence

describe("evidence timeline through the real stack", () => {
  it("runs the normal path to completion with an ordered timeline", async () => {
    const { app, logs } = await createStack([
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(APPROVING_REVIEW_OUTPUT),
      succeeds(VALID_FINAL_OUTPUT),
    ]);
    const created = (await createRun(app)).json() as { run: { id: string } };
    const started = await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${created.run.id}/start`,
      headers,
    });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ accepted: true });

    const details = (await settleHttp(app, created.run.id)) as unknown as {
      run: { status: string; phase: string; finalArtifactId?: string };
      turns: Array<{ sequence: number; role: string; status: string }>;
      attempts: Array<{ status: string; outputDigest?: string; leaseToken?: string }>;
      artifacts: Array<{ type: string }>;
      events: Array<{ sequence: number; type: string; message: string }>;
    };

    expect(details.run.status).toBe("completed");
    expect(details.run.phase).toBe("done");
    expect(details.run.finalArtifactId).toBeDefined();
    expect(details.turns.map((turn) => `${turn.sequence}:${turn.role}:${turn.status}`)).toEqual([
      "1:planner:committed",
      "2:critic:committed",
      "3:finalizer:committed",
    ]);
    expect(details.attempts.every((attempt) => attempt.status === "succeeded")).toBe(true);
    expect(details.attempts.every((attempt) => !("leaseToken" in attempt))).toBe(true);
    // The confirmed decision 1.3: every committed attempt records its digest.
    expect(details.attempts.every((attempt) => attempt.outputDigest?.startsWith("sha256:"))).toBe(
      true,
    );
    expect(details.artifacts.map((artifact) => artifact.type)).toEqual([
      "proposal",
      "review",
      "final",
    ]);
    expect(details.events.map((event) => event.type)).toEqual([
      "run.created",
      "run.started",
      "turn.scheduled",
      "attempt.started",
      "turn.committed",
      "turn.scheduled",
      "attempt.started",
      "turn.committed",
      "review.approved",
      "turn.scheduled",
      "attempt.started",
      "turn.committed",
      "run.completed",
    ]);
    expect(details.events.map((event) => event.sequence)).toEqual(
      details.events.map((_event, index) => index + 1),
    );

    // P2-18: structured logs carry identifiers only.
    expect(logs.length).toBeGreaterThan(0);
    const serialisedLogs = JSON.stringify(logs);
    expect(serialisedLogs).not.toContain("[YOUR TASK]");
    expect(serialisedLogs).not.toContain("Target Users");
    expect(logs.some((entry) => entry.context.promptDigest !== undefined)).toBe(true);
  });

  it("records the reject, revise, and approve path", async () => {
    const { app } = await createStack([
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(REJECTING_REVIEW_OUTPUT),
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(APPROVING_REVIEW_OUTPUT),
      succeeds(VALID_FINAL_OUTPUT),
    ]);
    const created = (await createRun(app)).json() as { run: { id: string } };
    await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${created.run.id}/start`,
      headers,
    });

    const details = (await settleHttp(app, created.run.id)) as unknown as {
      run: { status: string; revision: number };
      events: Array<{ type: string }>;
    };

    expect(details.run.status).toBe("completed");
    expect(details.run.revision).toBe(1);
    const types = details.events.map((event) => event.type);
    expect(types).toContain("review.rejected");
    expect(types).toContain("review.approved");
    expect(types.filter((type) => type === "turn.committed")).toHaveLength(5);
  });

  it("records an invalid output, its retry, and the eventual commit", async () => {
    const { app } = await createStack([
      succeeds(INVALID_ARTIFACT_OUTPUT),
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(APPROVING_REVIEW_OUTPUT),
      succeeds(VALID_FINAL_OUTPUT),
    ]);
    const created = (await createRun(app)).json() as { run: { id: string } };
    await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${created.run.id}/start`,
      headers,
    });

    const details = (await settleHttp(app, created.run.id)) as unknown as {
      run: { status: string };
      attempts: Array<{ number: number; status: string }>;
      events: Array<{ type: string; details: Record<string, unknown> }>;
    };

    expect(details.run.status).toBe("completed");
    expect(details.attempts.slice(0, 2).map((attempt) => attempt.status)).toEqual([
      "invalid_output",
      "succeeded",
    ]);
    const invalid = details.events.find((event) => event.type === "attempt.invalid_output");
    expect(invalid?.details).toMatchObject({ code: "INVALID_AGENT_OUTPUT" });
  });

  it("records a failed run when the Agent keeps failing", async () => {
    const { app } = await createStack([
      failsExecution("runner exited with code 1"),
      failsExecution("runner exited with code 1"),
    ]);
    const created = (await createRun(app)).json() as { run: { id: string } };
    await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${created.run.id}/start`,
      headers,
    });

    const details = (await settleHttp(app, created.run.id)) as unknown as {
      run: { status: string; errorCode: string };
      events: Array<{ type: string }>;
    };

    expect(details.run.status).toBe("failed");
    expect(details.run.errorCode).toBe("MAX_ATTEMPTS_EXCEEDED");
    expect(details.events.map((event) => event.type)).toContain("run.failed");
    expect(details.events.filter((event) => event.type === "attempt.failed")).toHaveLength(2);
  });

  it("stops a running run and leaves a stopped timeline", async () => {
    const { app, runtime } = await createStack([succeeds(VALID_PROPOSAL_OUTPUT)]);
    const created = (await createRun(app)).json() as { run: { id: string } };
    await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${created.run.id}/start`,
      headers,
    });
    await runtime.waitForStarts(1);

    const stopped = await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${created.run.id}/stop`,
      headers,
    });
    expect(stopped.statusCode).toBe(202);
    expect(stopped.json()).toMatchObject({ accepted: true, run: { status: "stopped" } });

    const details = (await settleHttp(app, created.run.id)) as unknown as {
      run: { status: string; errorCode: string };
      events: Array<{ type: string }>;
    };
    expect(details.run.status).toBe("stopped");
    expect(details.run.errorCode).toBe("STOPPED_BY_USER");
    expect(details.events.map((event) => event.type)).toContain("run.stop_requested");
    expect(details.events.map((event) => event.type)).toContain("run.stopped");

    // Stop stays idempotent on a terminal run.
    const again = await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${created.run.id}/stop`,
      headers,
    });
    expect(again.statusCode).toBe(202);
  });

  it("settles a run interrupted by a restart and releases its Agents", async () => {
    const { app, store, runtime } = await createStack([succeeds(VALID_PROPOSAL_OUTPUT)]);
    const created = (await createRun(app)).json() as { run: { id: string } };
    await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${created.run.id}/start`,
      headers,
    });
    await runtime.waitForStarts(1);

    // A restart: a fresh service initialises over the same durable database.
    const clock: Clock = new AdvancingClock();
    const restarted = new DurableCoordinationRepository({
      store,
      clock,
      ids: new SequentialUuidGenerator(),
    });
    expect(await restarted.interruptActiveRuns()).toEqual([created.run.id]);

    const details = await restarted.getRunDetails(created.run.id);
    expect(details?.run).toMatchObject({ status: "failed", errorCode: "SERVER_RESTARTED" });
    expect(details?.events.map((event) => event.type)).toContain("run.interrupted");
    expect(await restarted.listReservedAgentIds()).toEqual([]);
  });
});
