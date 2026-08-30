import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore, parseDatabaseDocument } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });
});

/**
 * A realistic v1 database: two Agents in different states, an ordinary
 * conversation, and both a finished and a cancelled Agent Run. Every value here
 * must survive migration byte-for-byte.
 */
const realisticV1Database = () => ({
  version: 1,
  agents: [
    {
      id: "3f1c0d9a-1f3b-4c2e-9a77-1b0f6a2d5e01",
      name: "Planner",
      description: "Drafts the proposal",
      instructions: "You draft structured proposals.",
      status: "ready",
      workspacePath: "/workspaces/3f1c0d9a-1f3b-4c2e-9a77-1b0f6a2d5e01",
      codexThreadId: "thread_01H9Z",
      lastError: null,
      createdAt: "2026-08-20T09:15:22.118Z",
      updatedAt: "2026-08-27T14:02:03.900Z",
    },
    {
      id: "8b2e4c60-77a1-4d55-b0f2-9c3e1a7d4402",
      name: "Critic",
      description: "",
      instructions: "You review proposals.",
      status: "error",
      workspacePath: "/workspaces/8b2e4c60-77a1-4d55-b0f2-9c3e1a7d4402",
      codexThreadId: null,
      lastError: "runner exited with code 1",
      createdAt: "2026-08-21T11:00:00.000Z",
      updatedAt: "2026-08-26T08:44:59.001Z",
    },
  ],
  messages: [
    {
      id: "b7d9f0a2-0c11-4a3d-8e5f-2a1b3c4d5e60",
      agentId: "3f1c0d9a-1f3b-4c2e-9a77-1b0f6a2d5e01",
      runId: "d1e2f3a4-b5c6-4711-9283-a4b5c6d7e8f9",
      role: "user",
      content: "Draft a rollout plan.",
      createdAt: "2026-08-27T13:59:10.004Z",
    },
    {
      id: "c8e0a1b3-1d22-4b4e-9f60-3b2c4d5e6f71",
      agentId: "3f1c0d9a-1f3b-4c2e-9a77-1b0f6a2d5e01",
      runId: "d1e2f3a4-b5c6-4711-9283-a4b5c6d7e8f9",
      role: "assistant",
      content: "Here is the rollout plan.",
      createdAt: "2026-08-27T14:02:03.880Z",
    },
  ],
  runs: [
    {
      id: "d1e2f3a4-b5c6-4711-9283-a4b5c6d7e8f9",
      agentId: "3f1c0d9a-1f3b-4c2e-9a77-1b0f6a2d5e01",
      status: "completed",
      prompt: "Draft a rollout plan.",
      output: "Here is the rollout plan.",
      error: null,
      usage: { inputTokens: 812, cachedInputTokens: 256, outputTokens: 340 },
      startedAt: "2026-08-27T13:59:10.100Z",
      completedAt: "2026-08-27T14:02:03.870Z",
      createdAt: "2026-08-27T13:59:10.004Z",
    },
    {
      id: "e2f3a4b5-c6d7-4822-a394-b5c6d7e8f900",
      agentId: "8b2e4c60-77a1-4d55-b0f2-9c3e1a7d4402",
      status: "cancelled",
      prompt: "Review the rollout plan.",
      output: null,
      error: "Server restarted",
      usage: null,
      startedAt: "2026-08-26T08:44:00.000Z",
      completedAt: "2026-08-26T08:44:59.000Z",
      createdAt: "2026-08-26T08:43:59.900Z",
    },
  ],
});

const readDatabaseFile = async (filePath: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;

const newTemporaryDatabasePath = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
  temporaryDirectories.push(root);
  return path.join(root, "db.json");
};

const COORDINATION_COLLECTIONS = [
  "coordinationRuns",
  "coordinationTurns",
  "coordinationAttempts",
  "coordinationArtifacts",
  "coordinationEvents",
] as const;

describe("database v2 migration", () => {
  it("creates a new empty database at version 2", async () => {
    const filePath = await newTemporaryDatabasePath();
    const store = new JsonStore(filePath);
    await store.initialize();

    expect(store.snapshot()).toEqual({
      version: 2,
      agents: [],
      messages: [],
      runs: [],
      coordinationRuns: [],
      coordinationTurns: [],
      coordinationAttempts: [],
      coordinationArtifacts: [],
      coordinationEvents: [],
    });
    expect(await readDatabaseFile(filePath)).toEqual(store.snapshot());
  });

  it("migrates a realistic v1 database without losing or rewriting any value", async () => {
    const filePath = await newTemporaryDatabasePath();
    const original = realisticV1Database();
    await writeFile(filePath, JSON.stringify(original, null, 2) + "\n", "utf8");

    const store = new JsonStore(filePath);
    await store.initialize();

    const migrated = store.snapshot();
    expect(migrated.version).toBe(2);
    // Every pre-existing record, field, and timestamp survives byte-for-byte.
    expect(migrated.agents).toEqual(original.agents);
    expect(migrated.messages).toEqual(original.messages);
    expect(migrated.runs).toEqual(original.runs);
    for (const collection of COORDINATION_COLLECTIONS) {
      expect(migrated[collection]).toEqual([]);
    }

    // The migration is persisted atomically, so a second load is a plain v2 load.
    const onDisk = await readDatabaseFile(filePath);
    expect(onDisk).toEqual(migrated);

    const reloaded = new JsonStore(filePath);
    await reloaded.initialize();
    expect(reloaded.snapshot()).toEqual(migrated);
  });

  it("preserves unknown fields on a v1 document rather than discarding them", async () => {
    const filePath = await newTemporaryDatabasePath();
    const base = realisticV1Database();
    const taggedAgent = { ...base.agents[0], experimentalTag: "keep-me" };
    const original = {
      ...base,
      agents: [taggedAgent, ...base.agents.slice(1)],
      settings: { theme: "dark" },
    };
    await writeFile(filePath, JSON.stringify(original, null, 2) + "\n", "utf8");

    const store = new JsonStore(filePath);
    await store.initialize();

    const onDisk = await readDatabaseFile(filePath);
    expect(onDisk.settings).toEqual({ theme: "dark" });
    expect((onDisk.agents as Record<string, unknown>[])[0]).toEqual(taggedAgent);
  });

  it("round-trips a v2 database including coordination collections and run correlation", async () => {
    const filePath = await newTemporaryDatabasePath();
    const store = new JsonStore(filePath);
    await store.initialize();

    await store.mutate((database) => {
      database.runs.push({
        id: "f3a4b5c6-d7e8-4933-b405-c6d7e8f90011",
        agentId: "3f1c0d9a-1f3b-4c2e-9a77-1b0f6a2d5e01",
        status: "queued",
        prompt: "coordination prompt",
        output: null,
        error: null,
        usage: null,
        startedAt: null,
        completedAt: null,
        createdAt: "2026-08-30T10:00:00.000Z",
        source: "coordination",
        coordinationRunId: "run-1",
        coordinationTurnId: "turn-1",
        coordinationAttemptId: "attempt-1",
      });
      database.coordinationEvents.push({
        id: "event-1",
        runId: "run-1",
        sequence: 1,
        type: "run.created",
        actor: { type: "user" },
        message: "Run created.",
        details: { name: "Rollout" },
        createdAt: "2026-08-30T10:00:00.000Z",
      });
    });

    const reloaded = new JsonStore(filePath);
    await reloaded.initialize();
    expect(reloaded.snapshot()).toEqual(store.snapshot());
    expect(reloaded.snapshot().runs[0]?.coordinationAttemptId).toBe("attempt-1");
    expect(reloaded.snapshot().coordinationEvents).toHaveLength(1);
  });

  it("rejects a future version and leaves the file untouched", async () => {
    const filePath = await newTemporaryDatabasePath();
    const future = JSON.stringify({ version: 3, agents: [], messages: [], runs: [] }, null, 2);
    await writeFile(filePath, future, "utf8");
    const before = await stat(filePath);

    const store = new JsonStore(filePath);
    await expect(store.initialize()).rejects.toThrow(/Unsupported database version 3/);

    expect(await readFile(filePath, "utf8")).toBe(future);
    expect((await stat(filePath)).mtimeMs).toBe(before.mtimeMs);
  });

  it("rejects a malformed database and leaves the file untouched", async () => {
    const filePath = await newTemporaryDatabasePath();
    const malformed = JSON.stringify({ version: 2, agents: [], messages: [] }, null, 2);
    await writeFile(filePath, malformed, "utf8");

    const store = new JsonStore(filePath);
    await expect(store.initialize()).rejects.toThrow(/missing required array "runs"/);
    expect(await readFile(filePath, "utf8")).toBe(malformed);
  });

  it("rejects unparseable JSON before any write", async () => {
    const filePath = await newTemporaryDatabasePath();
    await writeFile(filePath, "{ not json", "utf8");

    const store = new JsonStore(filePath);
    await expect(store.initialize()).rejects.toThrow(/not valid JSON/);
    expect(await readFile(filePath, "utf8")).toBe("{ not json");
  });
});

describe("parseDatabaseDocument", () => {
  it("reports migration only for v1 documents", () => {
    const v1 = parseDatabaseDocument(JSON.stringify(realisticV1Database()));
    expect(v1.migratedFromVersion).toBe(1);

    const v2 = parseDatabaseDocument(JSON.stringify(v1.database));
    expect(v2.migratedFromVersion).toBeNull();
    expect(v2.database).toEqual(v1.database);
  });

  it("rejects a non-object document", () => {
    expect(() => parseDatabaseDocument("[]")).toThrow(/must contain a JSON object/);
  });

  it("rejects a v1 document whose base collections are not arrays", () => {
    expect(() =>
      parseDatabaseDocument(JSON.stringify({ version: 1, agents: {}, messages: [], runs: [] })),
    ).toThrow(/Database v1 is missing required array "agents"/);
  });
});
