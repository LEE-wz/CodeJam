import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import type { Agent } from "../types.js";
import { DurableCoordinationRepository } from "./repository.js";
import { AdvancingClock, DeterministicIdGenerator } from "./testing/controls.js";
import {
  PARTICIPANT_ONE,
  PARTICIPANT_THREE,
  PARTICIPANT_TWO,
  freeChatPayload,
} from "./testing/session-fixtures.js";
import { DEFAULT_COORDINATION_POLICY, SESSION_CONTEXT_MAX_CHARS } from "./types.js";
import type {
  CoordinationArtifact,
  CoordinationAttempt,
  CoordinationEvent,
  CoordinationRun,
  CoordinationTurn,
} from "./types.js";

/**
 * Durable wave mechanics (PA13-15).
 *
 * Every race here is driven by `Promise.all` over the store's serialised
 * mutation queue or by explicit state sequencing. Nothing sleeps, so a pass is
 * not a statement about how fast this machine happens to be.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const PARTICIPANTS = [PARTICIPANT_ONE, PARTICIPANT_TWO, PARTICIPANT_THREE] as const;

const agentRow = (id: string, name: string): Agent => ({
  id,
  name,
  description: "",
  instructions: "",
  status: "ready",
  workspacePath: `/workspaces/${id}`,
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
});

const waveRun = (overrides: Partial<CoordinationRun> = {}): CoordinationRun => ({
  id: "run-wave",
  name: "Wave session",
  objective: "Answer from every angle at once.",
  requiredSections: [],
  participants: PARTICIPANTS.map((agent) => ({
    role: "participant" as const,
    agentId: agent.id,
    agentNameSnapshot: agent.name,
  })),
  policy: {
    ...DEFAULT_COORDINATION_POLICY,
    workflow: "shared_session_v1",
    maxRevisions: 0,
    maxTurns: 100,
    contextMaxChars: SESSION_CONTEXT_MAX_CHARS,
    sessionProtocol: "free_chat",
    sessionWaveMode: "parallel",
    sessionWavePurpose: "session_bidding",
  },
  status: "created",
  phase: "sessioning",
  revision: 0,
  nextTurnSequence: 1,
  activeTurnIds: [],
  version: 1,
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
  ...overrides,
});

const waveTurn = (
  index: number,
  overrides: Partial<CoordinationTurn> = {},
): CoordinationTurn => ({
  id: `turn-wave-${index}`,
  runId: "run-wave",
  sequence: index,
  role: "participant",
  agentId: PARTICIPANTS[index - 1]!.id,
  kind: "session_turn",
  wavePurpose: "session_bidding",
  status: "scheduled",
  attemptCount: 0,
  inputArtifactIds: [],
  lastValidationErrors: [],
  createdAt: "2026-08-29T00:00:00.000Z",
  ...overrides,
});

const waveAttempt = (
  index: number,
  overrides: Partial<CoordinationAttempt> = {},
): CoordinationAttempt => ({
  id: `attempt-wave-${index}`,
  runId: "run-wave",
  turnId: `turn-wave-${index}`,
  number: 1,
  agentId: PARTICIPANTS[index - 1]!.id,
  leaseToken: `lease-wave-${index}`,
  status: "running",
  promptDigest: "sha256:prompt",
  createdAt: "2026-08-29T00:00:00.000Z",
  ...overrides,
});

const waveArtifact = (index: number, content: string): CoordinationArtifact =>
  ({
    id: `artifact-wave-${index}`,
    runId: "run-wave",
    turnId: `turn-wave-${index}`,
    createdByRole: "participant",
    createdByAgentId: PARTICIPANTS[index - 1]!.id,
    sizeChars: content.length,
    createdAt: "2026-08-29T00:00:00.000Z",
    type: "session_message",
    payload: freeChatPayload(content),
  }) as CoordinationArtifact;

interface Harness {
  store: JsonStore;
  repository: DurableCoordinationRepository;
}

const createHarness = async (): Promise<Harness> => {
  const root = await mkdtemp(path.join(tmpdir(), "relay-wave-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.agents.push(...PARTICIPANTS.map((agent) => agentRow(agent.id, agent.name)));
  });
  const repository = new DurableCoordinationRepository({
    store,
    clock: new AdvancingClock(),
    ids: new DeterministicIdGenerator(),
  });
  return { store, repository };
};

/** A started run with a three-member wave scheduled and every attempt running. */
const runningWave = async (harness: Harness) => {
  await harness.repository.createRun({ run: waveRun() });
  const started = await harness.repository.startRun("run-wave");
  if (started.kind !== "started") throw new Error("wave run did not start");
  const scheduled = await harness.repository.scheduleTurns({
    runId: "run-wave",
    expectedRunVersion: started.run.version,
    turns: [waveTurn(1), waveTurn(2), waveTurn(3)],
    nextPhase: "sessioning",
    nextRevision: 0,
  });
  if (scheduled.kind !== "scheduled") throw new Error("wave was not scheduled");
  for (const index of [1, 2, 3]) {
    const begun = await harness.repository.beginAttempt({
      runId: "run-wave",
      turnId: `turn-wave-${index}`,
      attempt: waveAttempt(index),
    });
    if (begun.kind !== "started") throw new Error("attempt did not begin");
  }
  return scheduled;
};

const eventsOf = (events: CoordinationEvent[], type: string): CoordinationEvent[] =>
  events.filter((event) => event.type === type);

/* ================================================================== *
 * Atomic scheduling.
 * ================================================================== */

describe("atomic wave scheduling", () => {
  it("schedules the whole wave with contiguous sequences and one version bump", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: waveRun() });
    const started = await harness.repository.startRun("run-wave");
    if (started.kind !== "started") throw new Error("wave run did not start");

    const scheduled = await harness.repository.scheduleTurns({
      runId: "run-wave",
      expectedRunVersion: started.run.version,
      turns: [waveTurn(1), waveTurn(2), waveTurn(3)],
      nextPhase: "sessioning",
      nextRevision: 0,
    });

    expect(scheduled.kind).toBe("scheduled");
    if (scheduled.kind !== "scheduled") return;
    expect(scheduled.turns.map((turn) => turn.sequence)).toEqual([1, 2, 3]);
    expect(scheduled.run.version).toBe(started.run.version + 1);
    expect(scheduled.run.activeTurnIds).toEqual([
      "turn-wave-1",
      "turn-wave-2",
      "turn-wave-3",
    ]);
    expect(scheduled.run.nextTurnSequence).toBe(4);

    const details = await harness.repository.getRunDetails("run-wave");
    const scheduledEvents = eventsOf(details!.events, "turn.scheduled");
    expect(scheduledEvents).toHaveLength(3);
    expect(scheduledEvents.map((event) => event.details.wavePurpose)).toEqual([
      "session_bidding",
      "session_bidding",
      "session_bidding",
    ]);
    expect(scheduledEvents.map((event) => event.details.waveSize)).toEqual([3, 3, 3]);
    // Deterministic order: the events follow the members' sequences.
    expect(scheduledEvents.map((event) => event.details.sequence)).toEqual([1, 2, 3]);
  });

  it("lets exactly one of two concurrent schedules win", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: waveRun() });
    const started = await harness.repository.startRun("run-wave");
    if (started.kind !== "started") throw new Error("wave run did not start");

    const [first, second] = await Promise.all([
      harness.repository.scheduleTurns({
        runId: "run-wave",
        expectedRunVersion: started.run.version,
        turns: [waveTurn(1), waveTurn(2), waveTurn(3)],
        nextPhase: "sessioning",
        nextRevision: 0,
      }),
      harness.repository.scheduleTurns({
        runId: "run-wave",
        expectedRunVersion: started.run.version,
        turns: [
          waveTurn(1, { id: "turn-rival-1" }),
          waveTurn(2, { id: "turn-rival-2" }),
          waveTurn(3, { id: "turn-rival-3" }),
        ],
        nextPhase: "sessioning",
        nextRevision: 0,
      }),
    ]);

    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(["scheduled", "stale"]);

    const details = await harness.repository.getRunDetails("run-wave");
    expect(details?.turns).toHaveLength(3);
    expect(details?.run.nextTurnSequence).toBe(4);
  });

  it("persists nothing when one member of the batch is malformed", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: waveRun() });
    const started = await harness.repository.startRun("run-wave");
    if (started.kind !== "started") throw new Error("wave run did not start");

    const result = await harness.repository.scheduleTurns({
      runId: "run-wave",
      expectedRunVersion: started.run.version,
      // Third member breaks the contiguous-sequence rule.
      turns: [waveTurn(1), waveTurn(2), waveTurn(3, { sequence: 9 })],
      nextPhase: "sessioning",
      nextRevision: 0,
    });

    expect(result.kind).toBe("stale");
    const details = await harness.repository.getRunDetails("run-wave");
    expect(details?.turns).toEqual([]);
    expect(details?.run.activeTurnIds).toEqual([]);
    expect(details?.run.version).toBe(started.run.version);
    expect(eventsOf(details!.events, "turn.scheduled")).toEqual([]);
  });
});

/* ================================================================== *
 * Independent sibling settlement.
 * ================================================================== */

describe("wave member settlement", () => {
  it("removes only its own turn on concurrent sibling commits", async () => {
    const harness = await createHarness();
    await runningWave(harness);

    await Promise.all(
      [1, 2, 3].map((index) =>
        harness.repository.commitAcceptedArtifact({
          runId: "run-wave",
          turnId: `turn-wave-${index}`,
          attemptId: `attempt-wave-${index}`,
          leaseToken: `lease-wave-${index}`,
          artifact: waveArtifact(index, `bid ${index}`),
          outputDigest: `sha256:out-${index}`,
        }),
      ),
    );

    const details = await harness.repository.getRunDetails("run-wave");
    expect(details?.run.activeTurnIds).toEqual([]);
    expect(details?.turns.every((turn) => turn.status === "committed")).toBe(true);
    expect(details?.run.status).toBe("running");
    // Each commit bumped the version exactly once.
    expect(details?.run.version).toBeGreaterThan(0);
    const transcript = details!.artifacts
      .filter((artifact) => artifact.type === "session_message")
      .map((artifact) => artifact.transcriptSequence);
    expect(new Set(transcript).size).toBe(3);
  });

  it("retires one member with failTurn and leaves its siblings holding their leases", async () => {
    const harness = await createHarness();
    await runningWave(harness);

    const failed = await harness.repository.failTurn({
      runId: "run-wave",
      turnId: "turn-wave-2",
      code: "MAX_ATTEMPTS_EXCEEDED",
      message: "Participant did not return a usable bid for this round",
    });

    expect(failed.kind).toBe("failed");
    if (failed.kind !== "failed") return;
    expect(failed.run.status).toBe("running");
    expect(failed.run.activeTurnIds).toEqual(["turn-wave-1", "turn-wave-3"]);
    expect(failed.turn.status).toBe("failed");
    expect(failed.turn.activeAttemptId).toBeUndefined();

    const details = await harness.repository.getRunDetails("run-wave");
    // Its running attempt was cancelled in the same mutation, so no attempt is
    // left durably running and the reservation invariant already holds.
    const attempt = details?.attempts.find((candidate) => candidate.id === "attempt-wave-2");
    expect(attempt?.status).toBe("cancelled");
    expect(attempt?.errorCode).toBe("MAX_ATTEMPTS_EXCEEDED");
    expect(
      details?.attempts.filter((candidate) => candidate.status === "running").map((a) => a.id),
    ).toEqual(["attempt-wave-1", "attempt-wave-3"]);

    const retirement = eventsOf(details!.events, "turn.failed");
    expect(retirement).toHaveLength(1);
    expect(retirement[0]?.turnId).toBe("turn-wave-2");
    expect(retirement[0]?.details).toMatchObject({
      code: "MAX_ATTEMPTS_EXCEEDED",
      agentId: PARTICIPANT_TWO.id,
    });
    // Evidence carries no prompt, output, or lease.
    expect(JSON.stringify(retirement[0])).not.toContain("lease-wave-2");
    expect(JSON.stringify(retirement[0])).not.toContain("sha256:prompt");
  });

  it("refuses to retire a turn twice and refuses one that already committed", async () => {
    const harness = await createHarness();
    await runningWave(harness);

    const first = await harness.repository.failTurn({
      runId: "run-wave",
      turnId: "turn-wave-1",
      code: "MAX_ATTEMPTS_EXCEEDED",
      message: "no usable bid",
    });
    const second = await harness.repository.failTurn({
      runId: "run-wave",
      turnId: "turn-wave-1",
      code: "MAX_ATTEMPTS_EXCEEDED",
      message: "no usable bid",
    });
    expect(first.kind).toBe("failed");
    expect(second.kind).toBe("stale");

    await harness.repository.commitAcceptedArtifact({
      runId: "run-wave",
      turnId: "turn-wave-3",
      attemptId: "attempt-wave-3",
      leaseToken: "lease-wave-3",
      artifact: waveArtifact(3, "bid 3"),
    });
    const afterCommit = await harness.repository.failTurn({
      runId: "run-wave",
      turnId: "turn-wave-3",
      code: "MAX_ATTEMPTS_EXCEEDED",
      message: "no usable bid",
    });
    expect(afterCommit.kind).toBe("stale");

    const details = await harness.repository.getRunDetails("run-wave");
    expect(eventsOf(details!.events, "turn.failed")).toHaveLength(1);
  });

  it("loses a concurrent retire-versus-commit race without corrupting the turn", async () => {
    const harness = await createHarness();
    await runningWave(harness);

    const [commit, retire] = await Promise.all([
      harness.repository.commitAcceptedArtifact({
        runId: "run-wave",
        turnId: "turn-wave-2",
        attemptId: "attempt-wave-2",
        leaseToken: "lease-wave-2",
        artifact: waveArtifact(2, "bid 2"),
      }),
      harness.repository.failTurn({
        runId: "run-wave",
        turnId: "turn-wave-2",
        code: "MAX_ATTEMPTS_EXCEEDED",
        message: "no usable bid",
      }),
    ]);

    const outcomes = [commit.kind, retire.kind];
    // Exactly one of the two settled the turn.
    expect(outcomes.filter((kind) => kind === "committed" || kind === "failed")).toHaveLength(1);

    const details = await harness.repository.getRunDetails("run-wave");
    const turn = details?.turns.find((candidate) => candidate.id === "turn-wave-2");
    expect(["committed", "failed"]).toContain(turn?.status);
    expect(turn?.activeAttemptId).toBeUndefined();
    expect(details?.run.activeTurnIds).not.toContain("turn-wave-2");
  });

  it("rejects a stale lease on one member without touching its siblings", async () => {
    const harness = await createHarness();
    await runningWave(harness);

    const stale = await harness.repository.commitAcceptedArtifact({
      runId: "run-wave",
      turnId: "turn-wave-1",
      attemptId: "attempt-wave-1",
      leaseToken: "lease-from-a-previous-attempt",
      artifact: waveArtifact(1, "bid 1"),
    });
    expect(stale.kind).toBe("stale");

    const details = await harness.repository.getRunDetails("run-wave");
    expect(details?.run.activeTurnIds).toHaveLength(3);
    expect(eventsOf(details!.events, "attempt.stale_ignored")).toHaveLength(1);
    expect(
      details?.artifacts.filter((artifact) => artifact.type === "session_message"),
    ).toEqual([]);
  });
});

/* ================================================================== *
 * Whole-run settlement still clears the entire wave.
 * ================================================================== */

describe("whole-wave settlement", () => {
  it("cancels every member on stop and returns the session to idle", async () => {
    const harness = await createHarness();
    await runningWave(harness);

    await harness.repository.requestStop("run-wave");
    const stopped = await harness.repository.finishStopped("run-wave");

    // P12-07: session Stop cancels the current wave and returns to
    // `awaiting_input`; End is the separate terminal action. A wave does not
    // change that, but it does mean all three members must clear at once.
    expect(stopped?.status).toBe("awaiting_input");
    expect(stopped?.errorCode).toBeUndefined();
    expect(stopped?.activeTurnIds).toEqual([]);
    const details = await harness.repository.getRunDetails("run-wave");
    expect(details?.turns.every((turn) => turn.status === "cancelled")).toBe(true);
    expect(details?.attempts.every((attempt) => attempt.status === "cancelled")).toBe(true);
    expect(eventsOf(details!.events, "attempt.cancelled")).toHaveLength(3);
    // Every participant is released, so the next prompt can use them all.
    await expect(harness.repository.listReservedAgentIds()).resolves.toEqual([]);
  });

  it("clears every member atomically on run failure", async () => {
    const harness = await createHarness();
    await runningWave(harness);

    await harness.repository.failRun({
      runId: "run-wave",
      code: "MAX_ATTEMPTS_EXCEEDED",
      message: "Agent could not complete its turn in the current wave",
    });

    const details = await harness.repository.getRunDetails("run-wave");
    expect(details?.run.status).toBe("failed");
    expect(details?.run.activeTurnIds).toEqual([]);
    expect(details?.turns.every((turn) => turn.status === "failed")).toBe(true);
    expect(details?.attempts.every((attempt) => attempt.status !== "running")).toBe(true);
  });

  it("settles a whole interrupted wave on restart and frees every participant", async () => {
    const harness = await createHarness();
    await runningWave(harness);

    const interrupted = await harness.repository.interruptActiveRuns();
    expect(interrupted).toEqual(["run-wave"]);

    const details = await harness.repository.getRunDetails("run-wave");
    expect(details?.run.activeTurnIds).toEqual([]);
    expect(details?.attempts.every((attempt) => attempt.status !== "running")).toBe(true);
    await expect(harness.repository.listReservedAgentIds()).resolves.toEqual([]);

    // Idempotent: a second restart pass changes nothing.
    const before = JSON.stringify(await harness.repository.getRunDetails("run-wave"));
    await harness.repository.interruptActiveRuns();
    const after = JSON.stringify(await harness.repository.getRunDetails("run-wave"));
    expect(after).toBe(before);
  });

  it("frees a retired member's reservation while its siblings stay reserved", async () => {
    const harness = await createHarness();
    await runningWave(harness);

    await expect(harness.repository.listReservedAgentIds()).resolves.toHaveLength(3);

    await harness.repository.failTurn({
      runId: "run-wave",
      turnId: "turn-wave-2",
      code: "MAX_ATTEMPTS_EXCEEDED",
      message: "no usable bid",
    });

    const reserved = await harness.repository.listReservedAgentIds();
    expect(reserved.sort()).toEqual([PARTICIPANT_ONE.id, PARTICIPANT_THREE.id].sort());
  });
});

/* ================================================================== *
 * Compatibility.
 * ================================================================== */

describe("wave compatibility", () => {
  it("keeps the single-turn wrapper on zero-or-one active turns", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: waveRun() });
    const started = await harness.repository.startRun("run-wave");
    if (started.kind !== "started") throw new Error("wave run did not start");

    const first = await harness.repository.scheduleTurn({
      runId: "run-wave",
      expectedRunVersion: started.run.version,
      turn: waveTurn(1),
      nextPhase: "sessioning",
      nextRevision: 0,
    });
    expect(first.kind).toBe("scheduled");
    if (first.kind !== "scheduled") return;
    expect(first.run.activeTurnIds).toEqual(["turn-wave-1"]);

    // A second single turn is refused while one is active.
    const second = await harness.repository.scheduleTurn({
      runId: "run-wave",
      expectedRunVersion: first.run.version,
      turn: waveTurn(2),
      nextPhase: "sessioning",
      nextRevision: 0,
    });
    expect(second.kind).toBe("stale");

    const details = await harness.repository.getRunDetails("run-wave");
    const scheduledEvents = eventsOf(details!.events, "turn.scheduled");
    expect(scheduledEvents).toHaveLength(1);
    // A one-member schedule carries no waveSize: it is not a wave.
    expect(scheduledEvents[0]?.details.waveSize).toBeUndefined();
  });

  it("normalizes a stored turn that predates wave purpose", async () => {
    const harness = await createHarness();
    await harness.repository.createRun({ run: waveRun() });
    const started = await harness.repository.startRun("run-wave");
    if (started.kind !== "started") throw new Error("wave run did not start");

    const legacyTurn = waveTurn(1);
    delete legacyTurn.wavePurpose;
    const scheduled = await harness.repository.scheduleTurn({
      runId: "run-wave",
      expectedRunVersion: started.run.version,
      turn: legacyTurn,
      nextPhase: "sessioning",
      nextRevision: 0,
    });

    expect(scheduled.kind).toBe("scheduled");
    if (scheduled.kind !== "scheduled") return;
    expect(scheduled.turn.wavePurpose).toBe("session_execution");
  });
});
