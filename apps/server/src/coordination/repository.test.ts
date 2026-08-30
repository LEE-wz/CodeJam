import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import type { Agent, AgentRun } from "../types.js";
import { DurableCoordinationRepository } from "./repository.js";
import { AdvancingClock, DeterministicIdGenerator } from "./testing/controls.js";
import {
  APPROVING_REVIEW_PAYLOAD,
  CRITIC_AGENT,
  FINALIZER_AGENT,
  PLANNER_AGENT,
  REJECTING_REVIEW_PAYLOAD,
  VALID_PROPOSAL_PAYLOAD,
} from "./testing/fixtures.js";
import { DEFAULT_COORDINATION_POLICY } from "./types.js";
import type {
  CoordinationArtifact,
  CoordinationAttempt,
  CoordinationRun,
  CoordinationTurn,
} from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// ------------------------------------------------------------------ builders

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

const runRecord = (overrides: Partial<CoordinationRun> = {}): CoordinationRun => ({
  id: "run-1",
  name: "Launch plan review",
  objective: "Produce a practical launch plan.",
  requiredSections: [{ key: "risks", title: "Risks" }],
  participants: [
    { role: "planner", agentId: PLANNER_AGENT.id, agentNameSnapshot: PLANNER_AGENT.name },
    { role: "critic", agentId: CRITIC_AGENT.id, agentNameSnapshot: CRITIC_AGENT.name },
    { role: "finalizer", agentId: FINALIZER_AGENT.id, agentNameSnapshot: FINALIZER_AGENT.name },
  ],
  policy: DEFAULT_COORDINATION_POLICY,
  status: "created",
  phase: "drafting",
  revision: 0,
  nextTurnSequence: 1,
  version: 1,
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
  ...overrides,
});

const turnRecord = (overrides: Partial<CoordinationTurn> = {}): CoordinationTurn => ({
  id: "turn-1",
  runId: "run-1",
  sequence: 1,
  role: "planner",
  agentId: PLANNER_AGENT.id,
  kind: "initial_proposal",
  status: "scheduled",
  attemptCount: 0,
  inputArtifactIds: [],
  lastValidationErrors: [],
  createdAt: "2026-08-29T00:00:00.000Z",
  ...overrides,
});

const attemptRecord = (overrides: Partial<CoordinationAttempt> = {}): CoordinationAttempt => ({
  id: "attempt-1",
  runId: "run-1",
  turnId: "turn-1",
  number: 1,
  agentId: PLANNER_AGENT.id,
  leaseToken: "lease-0001",
  status: "running",
  promptDigest: "sha256:prompt",
  createdAt: "2026-08-29T00:00:00.000Z",
  ...overrides,
});

const proposalArtifact = (overrides: Partial<CoordinationArtifact> = {}): CoordinationArtifact =>
  ({
    id: "artifact-1",
    runId: "run-1",
    turnId: "turn-1",
    createdByRole: "planner",
    createdByAgentId: PLANNER_AGENT.id,
    sizeChars: 512,
    createdAt: "2026-08-29T00:00:00.000Z",
    type: "proposal",
    payload: VALID_PROPOSAL_PAYLOAD,
    ...overrides,
  }) as CoordinationArtifact;

const agentRunRow = (id: string, agentId: string, status: AgentRun["status"]): AgentRun => ({
  id,
  agentId,
  status,
  prompt: "p",
  output: null,
  error: null,
  usage: null,
  startedAt: null,
  completedAt: null,
  createdAt: "2026-08-29T00:00:00.000Z",
});

// ------------------------------------------------------------------ harness

interface Harness {
  store: JsonStore;
  repository: DurableCoordinationRepository;
}

const createHarness = async (): Promise<Harness> => {
  const root = await mkdtemp(path.join(tmpdir(), "relay-repository-test-"));
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
  const repository = new DurableCoordinationRepository({
    store,
    clock: new AdvancingClock(),
    ids: new DeterministicIdGenerator(),
  });
  return { store, repository };
};

/** Drive a run to "an attempt is running", the state most races start from. */
const runWithRunningAttempt = async (harness: Harness) => {
  await harness.repository.createRun({ run: runRecord() });
  const started = await harness.repository.startRun("run-1");
  if (started.kind !== "started") {
    throw new Error(`expected the run to start, got ${started.kind}`);
  }
  const scheduled = await harness.repository.scheduleTurn({
    runId: "run-1",
    expectedRunVersion: started.run.version,
    turn: turnRecord(),
    nextPhase: "drafting",
    nextRevision: 0,
  });
  if (scheduled.kind !== "scheduled") {
    throw new Error(`expected the turn to schedule, got ${scheduled.kind}`);
  }
  const begun = await harness.repository.beginAttempt({
    runId: "run-1",
    turnId: "turn-1",
    attempt: attemptRecord(),
    truncated: true,
  });
  if (begun.kind !== "started") {
    throw new Error(`expected the attempt to start, got ${begun.kind}`);
  }
  return { started, scheduled, begun };
};

const eventTypes = async (harness: Harness, runId = "run-1"): Promise<string[]> => {
  const details = await harness.repository.getRunDetails(runId);
  return (details?.events ?? []).map((event) => event.type);
};

// -------------------------------------------------------------- P2-08 reads

describe("read model", () => {
  it("lists runs newest-first and caps the result", async () => {
    const harness = await createHarness();
    for (let index = 0; index < 55; index += 1) {
      await harness.repository.createRun({
        run: runRecord({
          id: `run-${index}`,
          createdAt: `2026-08-29T00:00:${String(index).padStart(2, "0")}.000Z`,
        }),
      });
    }

    const runs = await harness.repository.listRuns();
    expect(runs).toHaveLength(50);
    expect(runs[0]?.id).toBe("run-54");
    expect(runs.at(-1)?.id).toBe("run-5");
  });

  it("breaks equal creation timestamps by insertion order, not array scan order", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord({ id: "run-a" }) });
    await harness.repository.createRun({ run: runRecord({ id: "run-b" }) });
    expect((await harness.repository.listRuns()).map((run) => run.id)).toEqual([
      "run-b",
      "run-a",
    ]);
  });

  it("sorts detail collections deterministically regardless of insertion order", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord() });
    await harness.store.mutate((database) => {
      // Deliberately shuffled: sorting must come from sequence, not position.
      database.coordinationTurns.push(
        turnRecord({ id: "turn-3", sequence: 3 }),
        turnRecord({ id: "turn-1", sequence: 1 }),
        turnRecord({ id: "turn-2", sequence: 2 }),
      );
      database.coordinationAttempts.push(
        attemptRecord({ id: "attempt-3", turnId: "turn-2", number: 1 }),
        attemptRecord({ id: "attempt-2", turnId: "turn-1", number: 2 }),
        attemptRecord({ id: "attempt-1", turnId: "turn-1", number: 1 }),
      );
      database.coordinationArtifacts.push(
        proposalArtifact({ id: "artifact-2", turnId: "turn-2" }),
        proposalArtifact({ id: "artifact-1", turnId: "turn-1" }),
      );
    });

    const details = await harness.repository.getRunDetails("run-1");
    expect(details?.turns.map((turn) => turn.id)).toEqual(["turn-1", "turn-2", "turn-3"]);
    expect(details?.attempts.map((attempt) => attempt.id)).toEqual([
      "attempt-1",
      "attempt-2",
      "attempt-3",
    ]);
    expect(details?.artifacts.map((artifact) => artifact.id)).toEqual([
      "artifact-1",
      "artifact-2",
    ]);
    expect(details?.events.map((event) => event.sequence)).toEqual([1]);
  });

  it("excludes records belonging to another run", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord({ id: "run-1" }) });
    await harness.repository.createRun({ run: runRecord({ id: "run-2" }) });
    await harness.store.mutate((database) => {
      database.coordinationTurns.push(turnRecord({ id: "turn-other", runId: "run-2" }));
    });

    const details = await harness.repository.getRunDetails("run-1");
    expect(details?.turns).toEqual([]);
    expect(details?.events.every((event) => event.runId === "run-1")).toBe(true);
  });

  it("returns undefined for an unknown run", async () => {
    const harness = await createHarness();
    expect(await harness.repository.getRunDetails("missing")).toBeUndefined();
  });

  it("returns deep copies, so a caller must reload to see later state", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord() });

    const first = await harness.repository.getRunDetails("run-1");
    first!.run.status = "completed";
    first!.events.length = 0;

    const second = await harness.repository.getRunDetails("run-1");
    expect(second?.run.status).toBe("created");
    expect(second?.events).toHaveLength(1);
  });
});

// ----------------------------------------------------- P2-09 basic commands

describe("createRun", () => {
  it("persists the run exactly once and appends run.created", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord() });

    const details = await harness.repository.getRunDetails("run-1");
    expect(harness.store.snapshot().coordinationRuns).toHaveLength(1);
    expect(details?.events.map((event) => event.type)).toEqual(["run.created"]);
    expect(details?.events[0]?.details).toMatchObject({
      name: "Launch plan review",
      requiredSectionKeys: ["risks"],
      workflow: "verified_handoff_v1",
    });
  });

  it("is idempotent on the run identifier", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord() });
    await harness.repository.createRun({ run: runRecord({ name: "Second attempt" }) });

    expect(harness.store.snapshot().coordinationRuns).toHaveLength(1);
    expect(harness.store.snapshot().coordinationRuns[0]?.name).toBe("Launch plan review");
    expect(await eventTypes(harness)).toEqual(["run.created"]);
  });

  it("survives a reload, because the mutation was persisted", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord() });

    const reloaded = new JsonStore((harness.store as unknown as { filePath: string }).filePath);
    await reloaded.initialize();
    expect(reloaded.snapshot().coordinationRuns.map((run) => run.id)).toEqual(["run-1"]);
    expect(reloaded.snapshot().coordinationEvents).toHaveLength(1);
  });
});

describe("startRun readiness and reservations", () => {
  it("starts a created run and records run.started", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord() });

    const result = await harness.repository.startRun("run-1");
    expect(result.kind).toBe("started");
    if (result.kind !== "started") return;
    expect(result.run.status).toBe("running");
    expect(result.run.version).toBe(2);
    expect(result.run.startedAt).toBeDefined();
    expect(await eventTypes(harness)).toEqual(["run.created", "run.started"]);
  });

  it("reports not_found for an unknown run", async () => {
    const harness = await createHarness();
    expect(await harness.repository.startRun("missing")).toEqual({ kind: "not_found" });
  });

  it("refuses a run that is not in the created state", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord() });
    await harness.repository.startRun("run-1");

    expect(await harness.repository.startRun("run-1")).toMatchObject({
      kind: "conflict",
      code: "INVALID_STATE",
    });
  });

  it("refuses when a participant Agent is not ready", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord() });
    await harness.store.mutate((database) => {
      const critic = database.agents.find((agent) => agent.id === CRITIC_AGENT.id);
      if (critic) critic.status = "error";
    });

    expect(await harness.repository.startRun("run-1")).toMatchObject({
      kind: "conflict",
      code: "AGENT_NOT_READY",
    });
  });

  it("refuses when a participant Agent no longer exists", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord() });
    await harness.store.mutate((database) => {
      database.agents = database.agents.filter((agent) => agent.id !== FINALIZER_AGENT.id);
    });

    expect(await harness.repository.startRun("run-1")).toMatchObject({
      kind: "conflict",
      code: "AGENT_NOT_READY",
    });
  });

  it("refuses when a participant has an ordinary Agent Run in flight", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord() });
    await harness.store.mutate((database) => {
      database.runs.push(agentRunRow("agent-run-1", PLANNER_AGENT.id, "running"));
    });

    expect(await harness.repository.startRun("run-1")).toMatchObject({
      kind: "conflict",
      code: "AGENT_RESERVED",
    });
  });

  it("ignores a settled ordinary Agent Run", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord() });
    await harness.store.mutate((database) => {
      database.runs.push(agentRunRow("agent-run-1", PLANNER_AGENT.id, "completed"));
    });

    expect((await harness.repository.startRun("run-1")).kind).toBe("started");
  });

  it("refuses overlapping participants but allows disjoint ones", async () => {
    const harness = await createHarness();
    await harness.store.mutate((database) => {
      database.agents.push(
        agentRow("agent-planner-2", "Planner 2"),
        agentRow("agent-critic-2", "Critic 2"),
        agentRow("agent-finalizer-2", "Finaliser 2"),
      );
    });

    await harness.repository.createRun({ run: runRecord({ id: "run-1" }) });
    // Shares the Critic with run-1.
    await harness.repository.createRun({
      run: runRecord({
        id: "run-overlap",
        participants: [
          { role: "planner", agentId: "agent-planner-2", agentNameSnapshot: "Planner 2" },
          { role: "critic", agentId: CRITIC_AGENT.id, agentNameSnapshot: CRITIC_AGENT.name },
          { role: "finalizer", agentId: "agent-finalizer-2", agentNameSnapshot: "Finaliser 2" },
        ],
      }),
    });
    // Shares nothing with run-1.
    await harness.repository.createRun({
      run: runRecord({
        id: "run-disjoint",
        participants: [
          { role: "planner", agentId: "agent-planner-2", agentNameSnapshot: "Planner 2" },
          { role: "critic", agentId: "agent-critic-2", agentNameSnapshot: "Critic 2" },
          { role: "finalizer", agentId: "agent-finalizer-2", agentNameSnapshot: "Finaliser 2" },
        ],
      }),
    });

    expect((await harness.repository.startRun("run-1")).kind).toBe("started");
    expect(await harness.repository.startRun("run-overlap")).toMatchObject({
      kind: "conflict",
      code: "AGENT_RESERVED",
    });
    expect((await harness.repository.startRun("run-disjoint")).kind).toBe("started");
  });

  it("yields one success and one conflict for two concurrent starts of the same run", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord() });

    const results = await Promise.all([
      harness.repository.startRun("run-1"),
      harness.repository.startRun("run-1"),
    ]);

    expect(results.filter((result) => result.kind === "started")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "conflict")).toHaveLength(1);
    expect(await eventTypes(harness)).toEqual(["run.created", "run.started"]);
  });

  it("yields one success and one conflict for two concurrent starts sharing an Agent", async () => {
    const harness = await createHarness();
    await harness.store.mutate((database) => {
      database.agents.push(
        agentRow("agent-planner-2", "Planner 2"),
        agentRow("agent-finalizer-2", "Finaliser 2"),
      );
    });
    await harness.repository.createRun({ run: runRecord({ id: "run-1" }) });
    await harness.repository.createRun({
      run: runRecord({
        id: "run-2",
        participants: [
          { role: "planner", agentId: "agent-planner-2", agentNameSnapshot: "Planner 2" },
          { role: "critic", agentId: CRITIC_AGENT.id, agentNameSnapshot: CRITIC_AGENT.name },
          { role: "finalizer", agentId: "agent-finalizer-2", agentNameSnapshot: "Finaliser 2" },
        ],
      }),
    });

    const results = await Promise.all([
      harness.repository.startRun("run-1"),
      harness.repository.startRun("run-2"),
    ]);

    expect(results.filter((result) => result.kind === "started")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "conflict")).toMatchObject([
      { code: "AGENT_RESERVED" },
    ]);
  });

  it("exposes derived reservations and releases them when the run goes terminal", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord() });
    expect(await harness.repository.listReservedAgentIds()).toEqual([]);

    await harness.repository.startRun("run-1");
    expect((await harness.repository.listReservedAgentIds()).sort()).toEqual(
      [PLANNER_AGENT.id, CRITIC_AGENT.id, FINALIZER_AGENT.id].sort(),
    );
    expect(await harness.repository.isAgentReserved(CRITIC_AGENT.id)).toBe(true);

    await harness.repository.finishStopped("run-1");
    expect(await harness.repository.listReservedAgentIds()).toEqual([]);
    expect(await harness.repository.isAgentReserved(CRITIC_AGENT.id)).toBe(false);
  });
});

describe("scheduleTurn and beginAttempt", () => {
  it("consumes the sequence, applies the revision, and bumps the version", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord() });
    const started = await harness.repository.startRun("run-1");
    if (started.kind !== "started") throw new Error("run did not start");

    const result = await harness.repository.scheduleTurn({
      runId: "run-1",
      expectedRunVersion: started.run.version,
      turn: turnRecord(),
      nextPhase: "drafting",
      nextRevision: 0,
    });

    expect(result.kind).toBe("scheduled");
    if (result.kind !== "scheduled") return;
    expect(result.run.activeTurnId).toBe("turn-1");
    expect(result.run.nextTurnSequence).toBe(2);
    expect(result.run.version).toBe(started.run.version + 1);
    expect(await eventTypes(harness)).toEqual(["run.created", "run.started", "turn.scheduled"]);
  });

  it("is stale when the run version has moved on", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord() });
    const started = await harness.repository.startRun("run-1");
    if (started.kind !== "started") throw new Error("run did not start");

    const result = await harness.repository.scheduleTurn({
      runId: "run-1",
      expectedRunVersion: started.run.version - 1,
      turn: turnRecord(),
      nextPhase: "drafting",
      nextRevision: 0,
    });

    expect(result.kind).toBe("stale");
    expect(harness.store.snapshot().coordinationTurns).toHaveLength(0);
  });

  it("refuses a second turn while one is already active", async () => {
    const harness = await createHarness();
    const { scheduled } = await runWithRunningAttempt(harness);
    if (scheduled.kind !== "scheduled") throw new Error("turn did not schedule");

    const second = await harness.repository.scheduleTurn({
      runId: "run-1",
      expectedRunVersion: scheduled.run.version,
      turn: turnRecord({ id: "turn-2", sequence: 2 }),
      nextPhase: "drafting",
      nextRevision: 0,
    });

    expect(second.kind).toBe("stale");
  });

  it("records the truncated context flag on attempt.started", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);

    const details = await harness.repository.getRunDetails("run-1");
    const started = details?.events.find((event) => event.type === "attempt.started");
    expect(started?.details).toMatchObject({
      truncated: true,
      attemptNumber: 1,
      promptDigest: "sha256:prompt",
      timeoutMs: DEFAULT_COORDINATION_POLICY.perAttemptTimeoutMs,
    });
    expect(details?.turns[0]?.status).toBe("running");
    expect(details?.turns[0]?.attemptCount).toBe(1);
  });

  it("refuses to begin an attempt on a turn that is not scheduled", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);

    const second = await harness.repository.beginAttempt({
      runId: "run-1",
      turnId: "turn-1",
      attempt: attemptRecord({ id: "attempt-2", number: 2, leaseToken: "lease-0002" }),
    });
    expect(second).toEqual({ kind: "stale" });
  });
});

// -------------------------------------------- P2-10 to P2-13 lease and races

describe("attachAgentRun", () => {
  it("attaches only to the attempt holding the lease and stamps the Agent Run", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);
    await harness.store.mutate((database) => {
      database.runs.push(agentRunRow("agent-run-1", PLANNER_AGENT.id, "running"));
    });

    expect(
      await harness.repository.attachAgentRun({
        attemptId: "attempt-1",
        leaseToken: "lease-0001",
        agentRunId: "agent-run-1",
      }),
    ).toBe("attached");

    const database = harness.store.snapshot();
    expect(database.coordinationAttempts[0]?.agentRunId).toBe("agent-run-1");
    expect(database.runs[0]).toMatchObject({
      source: "coordination",
      coordinationRunId: "run-1",
      coordinationTurnId: "turn-1",
      coordinationAttemptId: "attempt-1",
    });
  });

  it("is stale for the wrong lease token", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);

    expect(
      await harness.repository.attachAgentRun({
        attemptId: "attempt-1",
        leaseToken: "lease-wrong",
        agentRunId: "agent-run-1",
      }),
    ).toBe("stale");
    expect(harness.store.snapshot().coordinationAttempts[0]?.agentRunId).toBeUndefined();
  });
});

describe("commitAcceptedArtifact", () => {
  it("commits atomically with the correct lease and records the output digest", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);

    const result = await harness.repository.commitAcceptedArtifact({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      leaseToken: "lease-0001",
      artifact: proposalArtifact(),
      outputDigest: "sha256:output",
    });

    expect(result.kind).toBe("committed");
    const details = await harness.repository.getRunDetails("run-1");
    expect(details?.run.latestProposalArtifactId).toBe("artifact-1");
    expect(details?.run.activeTurnId).toBeUndefined();
    expect(details?.turns[0]).toMatchObject({
      status: "committed",
      outputArtifactId: "artifact-1",
    });
    expect(details?.turns[0]?.activeAttemptId).toBeUndefined();
    expect(details?.attempts[0]).toMatchObject({
      status: "succeeded",
      outputDigest: "sha256:output",
    });
    expect(details?.artifacts).toHaveLength(1);
    expect(await eventTypes(harness)).toEqual([
      "run.created",
      "run.started",
      "turn.scheduled",
      "attempt.started",
      "turn.committed",
    ]);
  });

  it("emits the matching review decision event", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);
    await harness.repository.commitAcceptedArtifact({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      leaseToken: "lease-0001",
      artifact: proposalArtifact({
        id: "artifact-review",
        type: "review",
        payload: REJECTING_REVIEW_PAYLOAD,
        createdByRole: "critic",
      }),
    });

    const details = await harness.repository.getRunDetails("run-1");
    expect(details?.run.latestReviewArtifactId).toBe("artifact-review");
    const rejected = details?.events.find((event) => event.type === "review.rejected");
    expect(rejected?.details).toMatchObject({
      decision: "reject",
      issueCount: 1,
      issueCodes: ["RISK_DETAIL_MISSING"],
    });
  });

  it("distinguishes an approving review", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);
    await harness.repository.commitAcceptedArtifact({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      leaseToken: "lease-0001",
      artifact: proposalArtifact({
        id: "artifact-review",
        type: "review",
        payload: APPROVING_REVIEW_PAYLOAD,
        createdByRole: "critic",
      }),
    });

    expect(await eventTypes(harness)).toContain("review.approved");
  });

  it("refuses a wrong lease token and leaves only stale evidence", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);

    const result = await harness.repository.commitAcceptedArtifact({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      leaseToken: "lease-forged",
      artifact: proposalArtifact(),
    });

    expect(result).toEqual({ kind: "stale" });
    const details = await harness.repository.getRunDetails("run-1");
    expect(details?.artifacts).toHaveLength(0);
    expect(details?.run.latestProposalArtifactId).toBeUndefined();
    expect(details?.run.activeTurnId).toBe("turn-1");
    expect(details?.attempts[0]?.status).toBe("running");
    expect(await eventTypes(harness)).toContain("attempt.stale_ignored");
  });

  it("refuses a previous attempt once a retry has started", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);

    await harness.repository.finishAttempt({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      leaseToken: "lease-0001",
      status: "invalid_output",
      errorCode: "INVALID_AGENT_OUTPUT",
      errorMessage: "schema mismatch",
      validationErrors: ["sections: missing 'risks'"],
    });
    await harness.repository.beginAttempt({
      runId: "run-1",
      turnId: "turn-1",
      attempt: attemptRecord({ id: "attempt-2", number: 2, leaseToken: "lease-0002" }),
    });

    // The superseded attempt returns late, holding a lease that no longer wins.
    const late = await harness.repository.commitAcceptedArtifact({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      leaseToken: "lease-0001",
      artifact: proposalArtifact(),
    });

    expect(late).toEqual({ kind: "stale" });
    const details = await harness.repository.getRunDetails("run-1");
    expect(details?.artifacts).toHaveLength(0);
    expect(details?.turns[0]?.activeAttemptId).toBe("attempt-2");
    expect(details?.attempts.map((attempt) => attempt.status)).toEqual([
      "invalid_output",
      "running",
    ]);
  });

  it("ignores a timed-out attempt that completes after a successful retry", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);

    await harness.repository.finishAttempt({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      leaseToken: "lease-0001",
      status: "timed_out",
      errorCode: "ATTEMPT_TIMED_OUT",
      errorMessage: "attempt exceeded its timeout",
    });
    await harness.repository.beginAttempt({
      runId: "run-1",
      turnId: "turn-1",
      attempt: attemptRecord({ id: "attempt-2", number: 2, leaseToken: "lease-0002" }),
    });
    await harness.repository.commitAcceptedArtifact({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-2",
      leaseToken: "lease-0002",
      artifact: proposalArtifact(),
      outputDigest: "sha256:retry",
    });

    const late = await harness.repository.commitAcceptedArtifact({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      leaseToken: "lease-0001",
      artifact: proposalArtifact({ id: "artifact-late" }),
    });

    expect(late).toEqual({ kind: "stale" });
    const details = await harness.repository.getRunDetails("run-1");
    expect(details?.artifacts.map((artifact) => artifact.id)).toEqual(["artifact-1"]);
    expect(details?.attempts[0]?.outputDigest).toBeUndefined();
  });

  it("prevents a commit that races a stop", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);

    // The runtime has succeeded, but the user stops the run before the commit.
    await harness.repository.requestStop("run-1");
    await harness.repository.finishStopped("run-1");

    const late = await harness.repository.commitAcceptedArtifact({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      leaseToken: "lease-0001",
      artifact: proposalArtifact(),
    });

    expect(late).toEqual({ kind: "stale" });
    const details = await harness.repository.getRunDetails("run-1");
    expect(details?.run.status).toBe("stopped");
    expect(details?.artifacts).toHaveLength(0);
    expect(await eventTypes(harness)).toEqual([
      "run.created",
      "run.started",
      "turn.scheduled",
      "attempt.started",
      "run.stop_requested",
      "attempt.cancelled",
      "run.stopped",
      "attempt.stale_ignored",
    ]);
  });

  it("does not duplicate the artifact or its event on a duplicate completion", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);

    const commit = () =>
      harness.repository.commitAcceptedArtifact({
        runId: "run-1",
        turnId: "turn-1",
        attemptId: "attempt-1",
        leaseToken: "lease-0001",
        artifact: proposalArtifact(),
        outputDigest: "sha256:output",
      });

    const [first, second] = await Promise.all([commit(), commit()]);
    expect([first.kind, second.kind].sort()).toEqual(["committed", "stale"]);

    const details = await harness.repository.getRunDetails("run-1");
    expect(details?.artifacts).toHaveLength(1);
    expect(details?.events.filter((event) => event.type === "turn.committed")).toHaveLength(1);
  });

  it("reports not_found when the attempt does not exist", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);

    expect(
      await harness.repository.commitAcceptedArtifact({
        runId: "run-1",
        turnId: "turn-1",
        attemptId: "attempt-missing",
        leaseToken: "lease-0001",
        artifact: proposalArtifact(),
      }),
    ).toEqual({ kind: "not_found" });
  });
});

describe("finishAttempt", () => {
  it("settles the attempt, keeps the turn schedulable, and records the reason", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);

    expect(
      await harness.repository.finishAttempt({
        runId: "run-1",
        turnId: "turn-1",
        attemptId: "attempt-1",
        leaseToken: "lease-0001",
        status: "invalid_output",
        errorCode: "INVALID_AGENT_OUTPUT",
        errorMessage: "schema mismatch",
        validationErrors: ["sections: missing 'risks'"],
      }),
    ).toBe("finished");

    const details = await harness.repository.getRunDetails("run-1");
    expect(details?.attempts[0]).toMatchObject({
      status: "invalid_output",
      errorCode: "INVALID_AGENT_OUTPUT",
    });
    expect(details?.turns[0]?.status).toBe("scheduled");
    expect(details?.turns[0]?.activeAttemptId).toBeUndefined();
    expect(details?.turns[0]?.lastValidationErrors).toEqual(["sections: missing 'risks'"]);
    const event = details?.events.find((item) => item.type === "attempt.invalid_output");
    expect(event?.details).toMatchObject({ errorCount: 1, code: "INVALID_AGENT_OUTPUT" });
  });

  it("closes the turn when the attempt is cancelled", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);

    await harness.repository.finishAttempt({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      leaseToken: "lease-0001",
      status: "cancelled",
      errorCode: "STOPPED_BY_USER",
      errorMessage: "stop requested",
    });

    const details = await harness.repository.getRunDetails("run-1");
    expect(details?.turns[0]?.status).toBe("cancelled");
    expect(details?.run.activeTurnId).toBeUndefined();
    expect(await eventTypes(harness)).toContain("attempt.cancelled");
  });

  it("emits attempt.timed_out with the policy timeout", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);

    await harness.repository.finishAttempt({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      leaseToken: "lease-0001",
      status: "timed_out",
      errorCode: "ATTEMPT_TIMED_OUT",
      errorMessage: "attempt exceeded its timeout",
    });

    const details = await harness.repository.getRunDetails("run-1");
    const event = details?.events.find((item) => item.type === "attempt.timed_out");
    expect(event?.details).toMatchObject({
      timeoutMs: DEFAULT_COORDINATION_POLICY.perAttemptTimeoutMs,
    });
  });

  it("is stale for a wrong lease and records only stale evidence", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);

    expect(
      await harness.repository.finishAttempt({
        runId: "run-1",
        turnId: "turn-1",
        attemptId: "attempt-1",
        leaseToken: "lease-forged",
        status: "failed",
        errorCode: "AGENT_EXECUTION_FAILED",
        errorMessage: "boom",
      }),
    ).toBe("stale");

    const details = await harness.repository.getRunDetails("run-1");
    expect(details?.attempts[0]?.status).toBe("running");
    expect(await eventTypes(harness)).toContain("attempt.stale_ignored");
  });
});

describe("terminal commands", () => {
  it("completes a running run and refuses to be overwritten afterwards", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);
    await harness.repository.commitAcceptedArtifact({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      leaseToken: "lease-0001",
      artifact: proposalArtifact(),
    });

    const completed = await harness.repository.completeRun({
      runId: "run-1",
      finalArtifactId: "artifact-1",
    });
    expect(completed).toMatchObject({ status: "completed", phase: "done" });

    const laterFail = await harness.repository.failRun({
      runId: "run-1",
      code: "INTERNAL_ERROR",
      message: "should not apply",
    });
    expect(laterFail?.status).toBe("completed");
    expect(laterFail?.errorCode).toBeUndefined();

    const laterStop = await harness.repository.finishStopped("run-1");
    expect(laterStop?.status).toBe("completed");
    expect(await eventTypes(harness)).not.toContain("run.failed");
  });

  it("fails a run and settles its active turn and attempt", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);

    const failed = await harness.repository.failRun({
      runId: "run-1",
      code: "MAX_TURNS_EXCEEDED",
      message: "turn ceiling reached",
    });

    expect(failed).toMatchObject({ status: "failed", errorCode: "MAX_TURNS_EXCEEDED" });
    const details = await harness.repository.getRunDetails("run-1");
    expect(details?.run.activeTurnId).toBeUndefined();
    expect(details?.turns[0]?.status).toBe("failed");
    expect(details?.attempts[0]).toMatchObject({
      status: "cancelled",
      errorCode: "MAX_TURNS_EXCEEDED",
    });
    expect(await eventTypes(harness)).toEqual([
      "run.created",
      "run.started",
      "turn.scheduled",
      "attempt.started",
      "attempt.cancelled",
      "run.failed",
    ]);
  });

  it("makes stop idempotent without duplicating evidence", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);

    await harness.repository.requestStop("run-1");
    await harness.repository.requestStop("run-1");
    await harness.repository.finishStopped("run-1");
    await harness.repository.finishStopped("run-1");

    const types = await eventTypes(harness);
    expect(types.filter((type) => type === "run.stop_requested")).toHaveLength(1);
    expect(types.filter((type) => type === "run.stopped")).toHaveLength(1);
  });

  it("does not complete a run that is no longer running", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);
    await harness.repository.finishStopped("run-1");

    const result = await harness.repository.completeRun({
      runId: "run-1",
      finalArtifactId: "artifact-1",
    });
    expect(result?.status).toBe("stopped");
    expect(result?.finalArtifactId).toBeUndefined();
  });

  it("returns undefined for terminal commands on an unknown run", async () => {
    const harness = await createHarness();
    expect(await harness.repository.requestStop("missing")).toBeUndefined();
    expect(await harness.repository.finishStopped("missing")).toBeUndefined();
    expect(
      await harness.repository.completeRun({ runId: "missing", finalArtifactId: "a" }),
    ).toBeUndefined();
    expect(
      await harness.repository.failRun({ runId: "missing", code: "INTERNAL_ERROR", message: "x" }),
    ).toBeUndefined();
  });
});

// ------------------------------------------------ P2-20 restart settlement

describe("interruptActiveRuns", () => {
  it("settles active runs, records interruption, and releases reservations", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);

    const interrupted = await harness.repository.interruptActiveRuns();
    expect(interrupted).toEqual(["run-1"]);

    const details = await harness.repository.getRunDetails("run-1");
    expect(details?.run).toMatchObject({ status: "failed", errorCode: "SERVER_RESTARTED" });
    expect(details?.run.activeTurnId).toBeUndefined();
    expect(details?.turns[0]?.status).toBe("failed");
    expect(details?.attempts[0]).toMatchObject({
      status: "cancelled",
      errorCode: "SERVER_RESTARTED",
    });
    expect(await eventTypes(harness)).toEqual([
      "run.created",
      "run.started",
      "turn.scheduled",
      "attempt.started",
      "run.interrupted",
      "attempt.cancelled",
      "run.failed",
    ]);
    expect(await harness.repository.listReservedAgentIds()).toEqual([]);
  });

  it("settles a stop-requested run too", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);
    await harness.repository.requestStop("run-1");

    expect(await harness.repository.interruptActiveRuns()).toEqual(["run-1"]);
    expect((await harness.repository.getRunDetails("run-1"))?.run.status).toBe("failed");
  });

  it("leaves created and terminal runs alone and is safe to repeat", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: runRecord({ id: "run-created" }) });
    await runWithRunningAttempt(harness);
    await harness.repository.interruptActiveRuns();

    expect(await harness.repository.interruptActiveRuns()).toEqual([]);
    expect((await harness.repository.getRunDetails("run-created"))?.run.status).toBe("created");
  });
});

// ----------------------------------- P2-14 / P2-22 evidence ledger integrity

describe("event ledger integrity", () => {
  it("numbers events per run with no gaps or duplicates", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);
    await harness.repository.createRun({ run: runRecord({ id: "run-2" }) });
    await harness.repository.commitAcceptedArtifact({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      leaseToken: "lease-0001",
      artifact: proposalArtifact(),
    });

    const first = await harness.repository.getRunDetails("run-1");
    const second = await harness.repository.getRunDetails("run-2");
    expect(first?.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    // A second run restarts its own sequence: numbering is per run.
    expect(second?.events.map((event) => event.sequence)).toEqual([1]);
    expect(new Set(first?.events.map((event) => event.id)).size).toBe(first?.events.length);
  });

  it("never records a lease token, prompt, or raw output in an event", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);
    await harness.repository.finishAttempt({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      leaseToken: "lease-0001",
      status: "failed",
      errorCode: "AGENT_EXECUTION_FAILED",
      errorMessage: "runner failed, Authorization: Bearer abc123def456ghi",
    });

    const details = await harness.repository.getRunDetails("run-1");
    const serialised = JSON.stringify(details?.events);
    expect(serialised).not.toContain("lease-0001");
    expect(serialised).not.toContain("abc123def456ghi");
    expect(serialised).not.toContain(VALID_PROPOSAL_PAYLOAD.summary);
  });

  it("keeps every state change and its event in a single persisted mutation", async () => {
    const harness = await createHarness();
    await runWithRunningAttempt(harness);
    await harness.repository.commitAcceptedArtifact({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      leaseToken: "lease-0001",
      artifact: proposalArtifact(),
      outputDigest: "sha256:output",
    });

    // Reloading from disk must show the artifact and its event together.
    const reloaded = new JsonStore((harness.store as unknown as { filePath: string }).filePath);
    await reloaded.initialize();
    const database = reloaded.snapshot();
    expect(database.coordinationArtifacts).toHaveLength(1);
    expect(database.coordinationEvents.some((event) => event.type === "turn.committed")).toBe(
      true,
    );
    expect(database.coordinationTurns[0]?.status).toBe("committed");
    expect(database.coordinationAttempts[0]?.outputDigest).toBe("sha256:output");
  });
});
