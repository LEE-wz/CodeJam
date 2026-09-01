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
import {
  CoordinationArtifactProtocolDispatchV1,
  SharedSessionArtifactProtocol,
  VerifiedHandoffArtifactProtocol,
} from "./artifact-protocol.js";
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
import { SharedSessionWorkflowV1 } from "./session-workflow.js";
import { AdvancingClock } from "./testing/controls.js";
import {
  ScriptedCoordinationRuntime,
  deferred,
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
import {
  CREATE_FREE_CHAT_REQUEST,
  PARTICIPANT_ONE,
  PROSE_MESSAGE_OUTPUT,
  PARTICIPANT_THREE,
  PARTICIPANT_TWO,
  SESSION_PARTICIPANTS,
  freeChatPayload,
} from "./testing/session-fixtures.js";
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
      agentRow(PARTICIPANT_ONE.id, PARTICIPANT_ONE.name),
      agentRow(PARTICIPANT_TWO.id, PARTICIPANT_TWO.name),
      agentRow(PARTICIPANT_THREE.id, PARTICIPANT_THREE.name),
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
  const verifiedArtifactProtocol = new VerifiedHandoffArtifactProtocol({ clock, ids });
  const sessionArtifactProtocol = new SharedSessionArtifactProtocol({ clock, ids });
  const service = new CoordinationService({
    agentDirectory,
    repository: new DurableCoordinationRepository({ store, clock, ids }),
    workflow: new VerifiedHandoffWorkflowV1(),
    sessionWorkflow: new SharedSessionWorkflowV1(),
    contextBuilder: new RoleScopedContextBuilder(),
    artifactProtocol: new CoordinationArtifactProtocolDispatchV1(
      verifiedArtifactProtocol,
      sessionArtifactProtocol,
    ),
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

const doneRound = (count: number) =>
  Array.from({ length: count }, (_unused, index) =>
    succeeds(JSON.stringify(freeChatPayload(`Contribution ${index + 1}`, true))));

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

const SETTLED = new Set(["awaiting_input", "completed", "failed", "stopped"]);

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
    if (SETTLED.has(body.run.status)) {
      return body as unknown as Record<string, unknown>;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("coordination run did not reach an idle or terminal state");
};

const createRun = async (app: FastifyInstance, overrides: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: "/api/coordination-runs",
    headers,
    payload: { ...CREATE_BODY, ...overrides },
  });

const SESSION_BODY = {
  ...CREATE_FREE_CHAT_REQUEST,
  // Room for one full round of three participants plus headroom, so a wave
  // settles by unanimous consent rather than by hitting the turn ceiling.
  policy: { sessionProtocol: "free_chat", maxTurns: 6 },
};

const createSessionRun = async (
  app: FastifyInstance,
  overrides: Record<string, unknown> = {},
) =>
  app.inject({
    method: "POST",
    url: "/api/coordination-runs",
    headers,
    payload: { ...SESSION_BODY, ...overrides },
  });

/**
 * Starts a session wave. Free chat answers a user prompt rather than a bare
 * start, so every session test drives it the way the product does.
 */
const sendSessionPrompt = async (app: FastifyInstance, runId: string, content = "Begin.") =>
  app.inject({
    method: "POST",
    url: `/api/coordination-runs/${runId}/messages`,
    headers,
    payload: { content, clientMessageId: `prompt-${runId}` },
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
      {
        method: "POST" as const,
        url: "/api/coordination-runs/11111111-1111-4111-8111-000000000001/messages",
      },
      {
        method: "POST" as const,
        url: "/api/coordination-runs/11111111-1111-4111-8111-000000000001/end",
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

// -------------------------------- P7 durable session API and evidence gate

describe("durable shared-session API", () => {
  it("normalizes an opted-in auction policy while legacy sessions remain unmarked", async () => {
    const { app } = await createStack();
    const legacy = await app.inject({
      method: "POST",
      url: "/api/coordination-runs",
      headers,
      payload: CREATE_FREE_CHAT_REQUEST,
    });
    const auction = await app.inject({
      method: "POST",
      url: "/api/coordination-runs",
      headers,
      payload: {
        ...CREATE_FREE_CHAT_REQUEST,
        policy: { sessionProtocol: "free_chat", auctionPolicy: {} },
      },
    });

    expect(legacy.statusCode).toBe(201);
    expect(auction.statusCode).toBe(201);
    expect(legacy.json()).not.toHaveProperty("run.policy.auctionPolicy");
    expect(auction.json()).toMatchObject({
      run: {
        policy: {
          auctionPolicy: {
            routingMode: "auto",
            directConfidenceThresholdBps: 8_000,
            directOutputTokenBudget: 4_000,
            minimumValidBids: 2,
            maxBidOutputTokens: 2_048,
            maxBidAttempts: 2,
            auctionExecutionTokenBudget: 4_000,
            auctionOnDirectFailure: false,
            fallback: "round_robin",
            scoringVersion: "confidence_cost_v1",
          },
        },
      },
    });
  });

  it.each([
    ["auction routing on an unknown protocol", { sessionProtocol: "other", auctionPolicy: {} }],
    [
      "the Phase 13 wave seam with auction routing",
      { sessionProtocol: "free_chat", sessionWaveMode: "parallel", auctionPolicy: {} },
    ],
    [
      "a default fallback without a default Agent",
      { sessionProtocol: "free_chat", auctionPolicy: { fallback: "default_agent" } },
    ],
    [
      "a foreign default Agent",
      {
        sessionProtocol: "free_chat",
        auctionPolicy: { defaultAgentId: "not-a-participant" },
      },
    ],
    [
      "too many minimum valid bids",
      { sessionProtocol: "free_chat", auctionPolicy: { minimumValidBids: 4 } },
    ],
    [
      "a bid output budget below its bound",
      { sessionProtocol: "free_chat", auctionPolicy: { maxBidOutputTokens: 127 } },
    ],
    [
      "an execution output budget above its bound",
      { sessionProtocol: "free_chat", auctionPolicy: { auctionExecutionTokenBudget: 16_001 } },
    ],
    [
      "an unknown scoring version",
      { sessionProtocol: "free_chat", auctionPolicy: { scoringVersion: "future" } },
    ],
    [
      "an unknown auction field",
      { sessionProtocol: "free_chat", auctionPolicy: { hiddenBudget: 99 } },
    ],
  ])("rejects %s", async (_label, policy) => {
    const { app } = await createStack();
    const response = await app.inject({
      method: "POST",
      url: "/api/coordination-runs",
      headers,
      payload: { ...CREATE_FREE_CHAT_REQUEST, policy },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });

  it("accepts auction policy bounds and a participant-backed default fallback", async () => {
    const { app } = await createStack();
    const response = await app.inject({
      method: "POST",
      url: "/api/coordination-runs",
      headers,
      payload: {
        ...CREATE_FREE_CHAT_REQUEST,
        policy: {
          sessionProtocol: "free_chat",
          auctionPolicy: {
            routingMode: "direct",
            defaultAgentId: PARTICIPANT_TWO.id,
            directConfidenceThresholdBps: 0,
            directOutputTokenBudget: 1,
            minimumValidBids: SESSION_PARTICIPANTS.length,
            maxBidOutputTokens: 4_096,
            maxBidAttempts: 3,
            auctionExecutionTokenBudget: 16_000,
            auctionOnDirectFailure: true,
            fallback: "default_agent",
            scoringVersion: "confidence_cost_v1",
          },
        },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      run: {
        policy: {
          auctionPolicy: {
            routingMode: "direct",
            defaultAgentId: PARTICIPANT_TWO.id,
            directConfidenceThresholdBps: 0,
            directOutputTokenBudget: 1,
            minimumValidBids: SESSION_PARTICIPANTS.length,
            maxBidOutputTokens: 4_096,
            maxBidAttempts: 3,
            auctionExecutionTokenBudget: 16_000,
            auctionOnDirectFailure: true,
            fallback: "default_agent",
          },
        },
      },
    });
  });

  it("creates a session, answers a prompt, and exposes durable evidence", async () => {
    const { app } = await createStack(doneRound(3));
    const created = await createSessionRun(app);
    expect(created.statusCode).toBe(201);
    const runId = (created.json() as { run: { id: string } }).run.id;

    expect((await sendSessionPrompt(app, runId)).statusCode).toBe(202);

    const details = (await settleHttp(app, runId)) as unknown as {
      run: { status: string; phase: string; finalArtifactId?: string };
      turns: Array<{ sequence: number; role: string; kind: string; status: string }>;
      attempts: Array<{ status: string; leaseToken?: string }>;
      artifacts: Array<{ id: string; type: string; payload: { content: string } }>;
      events: Array<{ sequence: number; type: string; details: Record<string, unknown> }>;
    };

    // A unanimous done round returns the session to idle rather than ending it:
    // the user owns the end of a session (P12).
    expect(details.run).toMatchObject({ status: "awaiting_input", phase: "sessioning" });
    expect(details.run).not.toHaveProperty("sharedState");
    expect(details.turns.map((turn) => `${turn.sequence}:${turn.role}:${turn.kind}:${turn.status}`))
      .toEqual([
        "1:participant:session_turn:committed",
        "2:participant:session_turn:committed",
        "3:participant:session_turn:committed",
      ]);
    expect(details.artifacts.map(({ type }) => type)).toEqual([
      "user_message",
      "session_message",
      "session_message",
      "session_message",
    ]);
    expect(details.attempts.every((attempt) => !("leaseToken" in attempt))).toBe(true);
    expect(details.events.map((event) => event.sequence)).toEqual(
      details.events.map((_event, index) => index + 1),
    );
    expect(details.events.at(-1)?.type).toBe("run.awaiting_input");
  });

  it.each([
    ["fewer than two participants", { agents: [PARTICIPANT_ONE.id] }],
    ["duplicate participants", { agents: [PARTICIPANT_ONE.id, PARTICIPANT_ONE.id] }],
    ["a verified-only requiredSections field", { requiredSections: [] }],
    ["a verified-only maxRevisions field", { policy: { maxRevisions: 1 } }],
    ["an unknown session protocol", { policy: { sessionProtocol: "other" } }],
    // PA14-18: the countdown protocol and its start value are gone from the
    // create surface, and the strict schema refuses both.
    ["the deleted countdown protocol", { policy: { sessionProtocol: "countdown", maxTurns: 3 } }],
    ["a countdown start value", { policy: { sessionProtocol: "free_chat", sessionStartValue: 3, maxTurns: 3 } }],
    ["a free-chat ceiling below range", { policy: { sessionProtocol: "free_chat", maxTurns: 2 } }],
  ])("rejects %s with a 400", async (_label, overrides) => {
    const { app } = await createStack();
    const response = await createSessionRun(app, overrides);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });

  it("returns 404 for an unknown session participant before creating the run", async () => {
    const { app, store } = await createStack();
    const response = await createSessionRun(app, {
      agents: [PARTICIPANT_ONE.id, PARTICIPANT_TWO.id, "missing-session-agent"],
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(store.snapshot().coordinationRuns).toEqual([]);
  });

  it("keeps session start readiness and derived reservations atomic", async () => {
    const { app, runtime, store } = await createStack([deferred()]);
    const first = (await createSessionRun(app)).json() as { run: { id: string } };
    const second = (await createSessionRun(app, { name: "Second countdown" })).json() as {
      run: { id: string };
    };

    await store.mutate((database) => {
      const participant = database.agents.find((agent) => agent.id === PARTICIPANT_ONE.id);
      if (participant) participant.status = "stopped";
    });
    const notReady = await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${first.run.id}/start`,
      headers,
    });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json()).toMatchObject({ error: { code: "AGENT_NOT_READY" } });

    await store.mutate((database) => {
      const participant = database.agents.find((agent) => agent.id === PARTICIPANT_ONE.id);
      if (participant) participant.status = "ready";
    });
    expect((await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${first.run.id}/start`,
      headers,
    })).statusCode).toBe(202);
    await runtime.waitForStarts(1);

    const reserved = await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${second.run.id}/start`,
      headers,
    });
    expect(reserved.statusCode).toBe(409);
    expect(reserved.json()).toMatchObject({ error: { code: "AGENT_RESERVED" } });

    const attemptId = runtime.pendingAttemptIds()[0];
    expect(attemptId).toBeDefined();
    await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${first.run.id}/stop`,
      headers,
    });
    if (attemptId) {
      runtime.resolveAttempt(attemptId, {
        kind: "succeeded",
        rawOutput: JSON.stringify(freeChatPayload("A late contribution.")),
      });
    }
    await settleHttp(app, first.run.id);

    // Stop ends only the wave. End the now-idle session to release its durable
    // enrolment before the overlapping session starts.
    expect((await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${first.run.id}/end`,
      headers,
    })).statusCode).toBe(202);
    const released = await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${second.run.id}/start`,
      headers,
    });
    expect(released.statusCode).toBe(202);
    await settleHttp(app, second.run.id);
  });
});

describe("durable shared-session evidence timelines", () => {
  it("records an invalid-output retry in the durable evidence timeline", async () => {
    const { app } = await createStack([
      succeeds(PROSE_MESSAGE_OUTPUT),
      ...doneRound(3),
    ]);
    const created = await createSessionRun(app);
    const runId = (created.json() as { run: { id: string } }).run.id;
    await sendSessionPrompt(app, runId);

    const details = (await settleHttp(app, runId)) as unknown as {
      run: { status: string };
      attempts: Array<{ number: number; status: string }>;
      events: Array<{ type: string }>;
    };
    expect(details.run).toMatchObject({ status: "awaiting_input" });
    expect(details.attempts.slice(0, 2).map(({ number, status }) => `${number}:${status}`)).toEqual([
      "1:invalid_output",
      "2:succeeded",
    ]);
    expect(details.events.map((event) => event.type)).toContain("attempt.invalid_output");
  });

  it("fails free chat at its hard cap and awaits input after a unanimous done wave", async () => {
    const cases = [
      {
        steps: [
          succeeds(JSON.stringify(freeChatPayload("First idea."))),
          succeeds(JSON.stringify(freeChatPayload("Second idea."))),
          succeeds(JSON.stringify(freeChatPayload("Third idea."))),
        ],
        body: { ...CREATE_FREE_CHAT_REQUEST, policy: { sessionProtocol: "free_chat", maxTurns: 3 } },
      },
      {
        steps: [
          succeeds(JSON.stringify(freeChatPayload("I am done.", true))),
          succeeds(JSON.stringify(freeChatPayload("I agree.", true))),
          succeeds(JSON.stringify(freeChatPayload("Complete.", true))),
        ],
        body: { ...CREATE_FREE_CHAT_REQUEST, policy: { sessionProtocol: "free_chat", maxTurns: 6 } },
      },
    ];

    for (const scenario of cases) {
      const { app } = await createStack(scenario.steps);
      const created = await app.inject({
        method: "POST",
        url: "/api/coordination-runs",
        headers,
        payload: scenario.body,
      });
      expect(created.statusCode).toBe(201);
      const runId = (created.json() as { run: { id: string } }).run.id;
      await app.inject({
        method: "POST",
        url: `/api/coordination-runs/${runId}/messages`,
        headers,
        payload: { content: "Give me a concise answer", clientMessageId: `message-${runId}` },
      });
      const details = (await settleHttp(app, runId)) as unknown as {
        run: { status: string; sharedState?: unknown; finalArtifactId?: string };
        artifacts: Array<{ id: string; type: string }>;
        events: Array<{ sequence: number; type: string; details: Record<string, unknown> }>;
      };
      const hardCap = scenario.body.policy.maxTurns === 3;
      expect(details.run).toMatchObject({ status: hardCap ? "failed" : "awaiting_input" });
      expect(details.run).not.toHaveProperty("sharedState");
      expect(details.run.finalArtifactId).toBeUndefined();
      expect(details.events.map((event) => event.sequence)).toEqual(
        details.events.map((_event, index) => index + 1),
      );
      expect(details.events.at(-1)?.type).toBe(hardCap ? "run.failed" : "run.awaiting_input");
    }
  });

  it("records a stopped session timeline and refuses its late result", async () => {
    const { app, runtime } = await createStack([deferred()]);
    const created = await createSessionRun(app);
    const runId = (created.json() as { run: { id: string } }).run.id;
    await sendSessionPrompt(app, runId);
    await runtime.waitForStarts(1);

    const attemptId = runtime.pendingAttemptIds()[0];
    const stopped = await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${runId}/stop`,
      headers,
    });
    expect(stopped.statusCode).toBe(202);
    if (attemptId) {
      runtime.resolveAttempt(attemptId, {
        kind: "succeeded",
        rawOutput: JSON.stringify(freeChatPayload("A late contribution.")),
      });
    }

    const details = (await settleHttp(app, runId)) as unknown as {
      run: { status: string; errorCode?: string; sharedState?: { nextExpectedNumber: number } };
      artifacts: unknown[];
      events: Array<{ sequence: number; type: string }>;
    };
    expect(details.run).toMatchObject({ status: "awaiting_input" });
    expect(details.run).not.toHaveProperty("sharedState");
    // The user prompt is durable; the cancelled wave committed nothing.
    expect(details.artifacts.filter(({ type }) => type === "session_message")).toEqual([]);
    expect(details.events.map((event) => event.type)).toEqual([
      "run.created",
      "run.started",
      "user.message_appended",
      "turn.scheduled",
      "attempt.started",
      "run.stop_requested",
      "attempt.cancelled",
      "run.awaiting_input",
    ]);
    expect(details.events.map((event) => event.sequence)).toEqual(
      details.events.map((_event, index) => index + 1),
    );
  });

  it("keeps restarted session evidence idle, resumable, and gapless", async () => {
    const { app, runtime, store } = await createStack([deferred()]);
    const created = await createSessionRun(app);
    const runId = (created.json() as { run: { id: string } }).run.id;
    await sendSessionPrompt(app, runId);
    await runtime.waitForStarts(1);

    const restarted = new DurableCoordinationRepository({
      store,
      clock: new AdvancingClock(),
      ids: new SequentialUuidGenerator(),
    });
    expect(await restarted.interruptActiveRuns()).toEqual([runId]);
    const interrupted = await restarted.getRunDetails(runId);
    expect(interrupted?.run).toMatchObject({ status: "awaiting_input" });
    expect(interrupted?.events.map((event) => event.sequence)).toEqual(
      interrupted?.events.map((_event, index) => index + 1),
    );
    expect(interrupted?.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["run.interrupted", "attempt.cancelled", "run.awaiting_input"]),
    );

    const lateAttempt = runtime.pendingAttemptIds()[0];
    if (lateAttempt) {
      runtime.resolveAttempt(lateAttempt, {
        kind: "succeeded",
        rawOutput: JSON.stringify(freeChatPayload("A late contribution.")),
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect((await restarted.getRunDetails(runId))?.run.status).toBe("awaiting_input");
  });
});

describe("durable multi-prompt session API", () => {
  it("holds three prompt waves in one totally ordered durable transcript", async () => {
    const steps = Array.from({ length: 3 }, (_wave, wave) =>
      SESSION_PARTICIPANTS.map((participant, participantIndex) =>
        succeeds(JSON.stringify(freeChatPayload(
          `Wave ${wave + 1} answer from ${participant.name}`,
          true,
        ))),
      ),
    ).flat();
    const { app, store } = await createStack(steps);
    const created = await createSessionRun(app, {
      name: "Three prompt session",
      policy: { sessionProtocol: "free_chat", maxTurns: 20 },
    });
    const runId = (created.json() as { run: { id: string; version: number } }).run.id;
    const versions: number[] = [];

    for (let wave = 1; wave <= 3; wave += 1) {
      const sent = await app.inject({
        method: "POST",
        url: `/api/coordination-runs/${runId}/messages`,
        headers,
        payload: { content: `User prompt ${wave}`, clientMessageId: `prompt-${wave}` },
      });
      expect(sent.statusCode).toBe(202);
      versions.push((sent.json() as { run: { version: number } }).run.version);
      const idle = (await settleHttp(app, runId)) as unknown as {
        run: { status: string; version: number };
      };
      expect(idle.run.status).toBe("awaiting_input");
      versions.push(idle.run.version);
    }

    const detail = (await app.inject({
      method: "GET",
      url: `/api/coordination-runs/${runId}`,
      headers,
    })).json() as {
      run: { id: string; status: string; participants: unknown[] };
      artifacts: Array<{ type: string; transcriptSequence?: number; payload: { content: string } }>;
      events: Array<{ sequence: number }>;
    };
    expect(detail.run).toMatchObject({ id: runId, status: "awaiting_input" });
    expect(detail.run.participants).toHaveLength(SESSION_PARTICIPANTS.length);
    expect(detail.artifacts).toHaveLength(12);
    expect(detail.artifacts.map(({ transcriptSequence }) => transcriptSequence)).toEqual(
      Array.from({ length: 12 }, (_unused, index) => index + 1),
    );
    expect(detail.artifacts.filter(({ type }) => type === "user_message").map(({ payload }) => payload.content))
      .toEqual(["User prompt 1", "User prompt 2", "User prompt 3"]);
    expect(detail.events.map(({ sequence }) => sequence)).toEqual(
      detail.events.map((_event, index) => index + 1),
    );
    expect(versions.every((version, index) => index === 0 || version > versions[index - 1]!)).toBe(true);

    const beforeRestart = structuredClone(detail.run);
    const restarted = new DurableCoordinationRepository({
      store,
      clock: new AdvancingClock(),
      ids: new SequentialUuidGenerator(),
    });
    expect(await restarted.interruptActiveRuns()).toEqual([]);
    expect((await restarted.getRunDetails(runId))?.run).toEqual(beforeRestart);
    expect(await restarted.listReservedAgentIds()).toEqual([]);
  });

  it("defuses duplicate sends and conflicts while a wave is running", async () => {
    const { app, runtime } = await createStack([deferred()]);
    const created = await createSessionRun(app, {
      policy: { sessionProtocol: "free_chat", maxTurns: 20 },
    });
    const runId = (created.json() as { run: { id: string } }).run.id;
    const first = await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${runId}/messages`,
      headers,
      payload: { content: "First prompt", clientMessageId: "same-client-id" },
    });
    expect(first.statusCode).toBe(202);
    await runtime.waitForStarts(1);

    const conflict = await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${runId}/messages`,
      headers,
      payload: { content: "Racing prompt", clientMessageId: "racing-client-id" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "INVALID_STATE" } });

    await app.inject({ method: "POST", url: `/api/coordination-runs/${runId}/stop`, headers });
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${runId}/messages`,
      headers,
      payload: { content: "First prompt", clientMessageId: "same-client-id" },
    });
    expect(duplicate.statusCode).toBe(202);
    const detail = (await app.inject({
      method: "GET",
      url: `/api/coordination-runs/${runId}`,
      headers,
    })).json() as { run: { status: string }; artifacts: Array<{ type: string }> };
    expect(detail.run.status).toBe("awaiting_input");
    expect(detail.artifacts.filter(({ type }) => type === "user_message")).toHaveLength(1);
  });

  it("separates stop from end and keeps an ended session immutable", async () => {
    const { app, runtime } = await createStack([deferred()]);
    const created = await createSessionRun(app, {
      policy: { sessionProtocol: "free_chat", maxTurns: 20 },
    });
    const runId = (created.json() as { run: { id: string } }).run.id;
    await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${runId}/messages`,
      headers,
      payload: { content: "Start work" },
    });
    await runtime.waitForStarts(1);
    expect((await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${runId}/end`,
      headers,
    })).statusCode).toBe(409);

    const stopped = await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${runId}/stop`,
      headers,
    });
    expect(stopped.json()).toMatchObject({ run: { status: "awaiting_input" } });
    const ended = await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${runId}/end`,
      headers,
    });
    expect(ended.json()).toMatchObject({ run: { status: "completed", endedByUser: true } });
    expect((await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${runId}/messages`,
      headers,
      payload: { content: "Too late" },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${runId}/end`,
      headers,
    })).statusCode).toBe(409);
  });

  it("stops a pending wave, starts a new prompt immediately, and fences the late result", async () => {
    const { app, runtime } = await createStack([
      deferred(),
      ...SESSION_PARTICIPANTS.map((participant) =>
        succeeds(JSON.stringify(freeChatPayload(`${participant.name} answered the new prompt`, true))),
      ),
    ]);
    const created = await createSessionRun(app, {
      policy: { sessionProtocol: "free_chat", maxTurns: 20 },
    });
    const runId = (created.json() as { run: { id: string } }).run.id;
    await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${runId}/messages`,
      headers,
      payload: { content: "Prompt that will be stopped" },
    });
    await runtime.waitForStarts(1);
    const lateAttemptId = runtime.pendingAttemptIds()[0];
    expect(lateAttemptId).toBeDefined();
    expect((await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${runId}/stop`,
      headers,
    })).json()).toMatchObject({ run: { status: "awaiting_input" } });

    expect((await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${runId}/messages`,
      headers,
      payload: { content: "New prompt after stop" },
    })).statusCode).toBe(202);
    const idle = (await settleHttp(app, runId)) as unknown as {
      run: { status: string };
      artifacts: Array<{ type: string; payload: { content: string } }>;
      attempts: Array<{ status: string }>;
    };
    expect(idle.run.status).toBe("awaiting_input");
    expect(idle.artifacts.map(({ payload }) => payload.content)).toEqual([
      "Prompt that will be stopped",
      "New prompt after stop",
      ...SESSION_PARTICIPANTS.map((participant) => `${participant.name} answered the new prompt`),
    ]);
    expect(idle.attempts.some(({ status }) => status === "cancelled")).toBe(true);

    runtime.resolveAttempt(lateAttemptId!, {
      kind: "succeeded",
      rawOutput: JSON.stringify(freeChatPayload("LATE RESULT MUST BE FENCED", true)),
    });
    await new Promise((resolve) => setImmediate(resolve));
    const afterLate = (await app.inject({
      method: "GET",
      url: `/api/coordination-runs/${runId}`,
      headers,
    })).json() as { run: { status: string }; artifacts: Array<{ payload: { content: string } }> };
    expect(afterLate.run.status).toBe("awaiting_input");
    expect(afterLate.artifacts.map(({ payload }) => payload.content)).not.toContain(
      "LATE RESULT MUST BE FENCED",
    );
  });

  it("returns inclusive detail deltas at zero, mid-ledger, and past the end", async () => {
    const { app } = await createStack(
      SESSION_PARTICIPANTS.map((participant) =>
        succeeds(JSON.stringify(freeChatPayload(`${participant.name} done`, true))),
      ),
    );
    const created = await createSessionRun(app, {
      policy: { sessionProtocol: "free_chat", maxTurns: 20 },
    });
    const runId = (created.json() as { run: { id: string } }).run.id;
    await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${runId}/messages`,
      headers,
      payload: { content: "Build the delta ledger" },
    });
    const full = (await settleHttp(app, runId)) as unknown as {
      events: Array<{ sequence: number }>;
    };
    const last = full.events.at(-1)!.sequence;
    const atZero = (await app.inject({
      method: "GET",
      url: `/api/coordination-runs/${runId}?sinceSequence=0`,
      headers,
    })).json() as { events: Array<{ sequence: number }>; cursor: number };
    expect(atZero.events).toHaveLength(full.events.length);
    expect(atZero.cursor).toBe(last + 1);

    const middle = full.events[Math.floor(full.events.length / 2)]!.sequence;
    const atMiddle = (await app.inject({
      method: "GET",
      url: `/api/coordination-runs/${runId}?sinceSequence=${middle}`,
      headers,
    })).json() as { events: Array<{ sequence: number }>; cursor: number };
    expect(atMiddle.events[0]?.sequence).toBe(middle);
    expect(atMiddle.cursor).toBe(last + 1);

    const past = last + 20;
    const afterEnd = (await app.inject({
      method: "GET",
      url: `/api/coordination-runs/${runId}?sinceSequence=${past}`,
      headers,
    })).json() as { events: unknown[]; turns: unknown[]; attempts: unknown[]; artifacts: unknown[]; cursor: number };
    expect(afterEnd).toMatchObject({ events: [], turns: [], attempts: [], artifacts: [], cursor: past });
    expect((await app.inject({
      method: "GET",
      url: `/api/coordination-runs/${runId}?sinceSequence=bad`,
      headers,
    })).statusCode).toBe(400);
  });

  it("validates message bodies and reports unknown sessions", async () => {
    const { app } = await createStack([]);
    const unknown = "22222222-2222-4222-8222-222222222222";
    expect((await app.inject({
      method: "POST",
      url: `/api/coordination-runs/${unknown}/messages`,
      headers,
      payload: { content: "Hello" },
    })).statusCode).toBe(404);
    const created = await createSessionRun(app, {
      policy: { sessionProtocol: "free_chat", maxTurns: 20 },
    });
    const runId = (created.json() as { run: { id: string } }).run.id;
    for (const payload of [
      { content: "" },
      { content: "x".repeat(4_001) },
      { content: "valid", extra: true },
      { content: "valid", clientMessageId: "" },
    ]) {
      expect((await app.inject({
        method: "POST",
        url: `/api/coordination-runs/${runId}/messages`,
        headers,
        payload,
      })).statusCode).toBe(400);
    }
  });
});
