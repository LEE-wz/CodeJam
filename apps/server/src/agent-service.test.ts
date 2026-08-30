import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import type { CoordinationReservationSource } from "./coordination/contracts.js";
import type {
  CoordinationAttempt,
  CoordinationRun,
  CoordinationTurn,
} from "./coordination/types.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeHarness(
  runner: AgentRunner = new FakeRunner(),
  reservations?: CoordinationReservationSource,
): Promise<{ service: AgentService; store: JsonStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    reservations,
  );
  await service.initialize();
  return { service, store };
}

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  return (await makeHarness(runner)).service;
}

/**
 * Seeds a live coordination run holding `agentId`.
 *
 * Since P11-05, reservation is derived from a **running attempt** rather than
 * from enrolment, so the fixture also seeds the running turn and attempt that
 * the real orchestration commits (through `beginAttempt`) before it ever calls
 * `startExecution`. Pass `withRunningAttempt: false` to seed enrolment alone.
 */
async function reserveAgent(
  store: JsonStore,
  agentId: string,
  runId = "coordination-run-1",
  { withRunningAttempt = true }: { withRunningAttempt?: boolean } = {},
): Promise<void> {
  const timestamp = new Date().toISOString();
  const run: CoordinationRun = {
    id: runId,
    name: "Reserved run",
    objective: "Test reservation enforcement",
    requiredSections: [{ key: "result", title: "Result" }],
    participants: [
      { role: "planner", agentId, agentNameSnapshot: "Reserved" },
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
    status: "running",
    phase: "drafting",
    revision: 0,
    nextTurnSequence: 1,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    ...(withRunningAttempt ? { activeTurnId: "turn-1" } : {}),
  };
  const turn: CoordinationTurn = {
    id: "turn-1",
    runId,
    sequence: 1,
    role: "planner",
    agentId,
    kind: "initial_proposal",
    status: "running",
    attemptCount: 1,
    activeAttemptId: "attempt-1",
    inputArtifactIds: [],
    lastValidationErrors: [],
    createdAt: timestamp,
    startedAt: timestamp,
  };
  const attempt: CoordinationAttempt = {
    id: "attempt-1",
    runId,
    turnId: "turn-1",
    number: 1,
    agentId,
    leaseToken: "lease-0001",
    status: "running",
    createdAt: timestamp,
  };
  await store.mutate((database) => {
    database.coordinationRuns.push(run);
    if (withRunningAttempt) {
      database.coordinationTurns.push(turn);
      database.coordinationAttempts.push(attempt);
    }
  });
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("returns an execution handle immediately and persists coordination correlations", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => { finish = resolve; });
    const { service, store } = await makeHarness({
      run: () => pending,
      cancel: async () => true,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Relay Planner" });
    await reserveAgent(store, agent.id);

    const handle = await service.startExecution({
      agentId: agent.id,
      prompt: "Produce the proposal",
      source: "coordination",
      coordination: {
        runId: "coordination-run-1",
        turnId: "turn-1",
        attemptId: "attempt-1",
      },
    });
    expect(service.getRun(handle.agentRunId)).toMatchObject({
      source: "coordination",
      coordinationRunId: "coordination-run-1",
      coordinationTurnId: "turn-1",
      coordinationAttemptId: "attempt-1",
    });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "proposal", threadId: "relay-thread", usage: { outputTokens: 3 } });
    await expect(handle.completion).resolves.toEqual({ status: "completed", output: "proposal" });
    expect(service.getAgent(agent.id).codexThreadId).toBe("relay-thread");
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("cancels by Agent run ID and cannot cancel a later unrelated run", async () => {
    const completions: Array<(result: RunnerResult) => void> = [];
    let cancelCount = 0;
    const service = await makeService({
      run: () => new Promise<RunnerResult>((resolve) => { completions.push(resolve); }),
      cancel: async () => {
        cancelCount += 1;
        completions.shift()?.({ output: "late", threadId: null, usage: null });
        return true;
      },
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Scoped cancellation" });
    const first = await service.startExecution({
      agentId: agent.id,
      prompt: "first",
      source: "playground",
    });
    expect(await service.cancelRun(first.agentRunId)).toBe(true);
    await expect(first.completion).resolves.toEqual({ status: "cancelled" });

    const second = await service.startExecution({
      agentId: agent.id,
      prompt: "second",
      source: "playground",
    });
    expect(await service.cancelRun(first.agentRunId)).toBe(false);
    expect(cancelCount).toBe(1);
    await expect.poll(() => completions.length).toBe(1);
    completions.shift()?.({ output: "second result", threadId: "thread-2", usage: null });
    await expect(second.completion).resolves.toEqual({
      status: "completed",
      output: "second result",
    });
  });

  it("enforces active coordination reservations and releases them at terminal state", async () => {
    let reservedRunId: string | undefined = "coordination-run-1";
    const reservations: CoordinationReservationSource = {
      getReservingRunId: async () => reservedRunId,
    };
    const { service, store } = await makeHarness(new FakeRunner(), reservations);
    const agent = await service.createAgent({ name: "Reserved" });
    await reserveAgent(store, agent.id);

    await expect(service.sendMessage(agent.id, "competing turn")).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(service.updateAgent(agent.id, { name: "Changed" })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.stopAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.deleteAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });

    await expect(service.startExecution({
      agentId: agent.id,
      prompt: "wrong owner",
      source: "coordination",
      coordination: { runId: "other-run", turnId: "turn", attemptId: "attempt" },
    })).rejects.toMatchObject({ statusCode: 409 });

    await store.mutate((database) => {
      database.coordinationRuns[0]!.status = "completed";
    });
    reservedRunId = undefined;
    const { run } = await service.sendMessage(agent.id, "released turn");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("preserves failure state and allows an explicit restart to recover", async () => {
    const service = await makeService({
      run: async () => { throw new Error("provider unavailable"); },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Failure" });
    const handle = await service.startExecution({
      agentId: agent.id,
      prompt: "fail",
      source: "playground",
    });
    await expect(handle.completion).resolves.toEqual({
      status: "failed",
      error: "provider unavailable",
    });
    expect(service.getRun(handle.agentRunId)).toMatchObject({
      status: "failed",
      error: "provider unavailable",
    });
    expect(service.getAgent(agent.id).status).toBe("error");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
  });
});
