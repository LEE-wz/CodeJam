import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import type { Agent } from "../types.js";
import {
  CoordinationArtifactProtocolDispatchV1,
  SharedSessionArtifactProtocol,
  VerifiedHandoffArtifactProtocol,
} from "./artifact-protocol.js";
import { RoleScopedContextBuilder } from "./context-builder.js";
import { DurableCoordinationRepository } from "./repository.js";
import { CoordinationService } from "./service.js";
import { SharedSessionWorkflowV1 } from "./session-workflow.js";
import { VerifiedHandoffWorkflowV1 } from "./workflow.js";
import { AdvancingClock, DeterministicIdGenerator } from "./testing/controls.js";
import { FakeAgentDirectory, ScriptedCoordinationRuntime } from "./testing/fakes.js";
import {
  CREATE_FREE_CHAT_REQUEST,
  PARTICIPANT_ONE,
  PARTICIPANT_THREE,
  PARTICIPANT_TWO,
  SESSION_PARTICIPANTS,
} from "./testing/session-fixtures.js";
import { DEFAULT_COORDINATION_POLICY } from "./types.js";
import type { WorkflowView } from "./contracts.js";
import type {
  CoordinationArtifact,
  CoordinationRun,
  CoordinationTurn,
} from "./types.js";

/**
 * PA14-18 — the countdown engine is deleted; the ledger is not.
 *
 * The distinction this file pins is the whole task: no engine path accepts a
 * countdown session any more, but a session recorded before the deletion still
 * loads, reads back with every persisted field, and renders. Deletion applies
 * to the state machine, never to stored history.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 5 }),
      ),
  );
});

const NOW = "2026-08-29T00:00:00.000Z";
const RUN_ID = "run-stored-countdown";

const agentRow = (id: string, name: string): Agent => ({
  id,
  name,
  description: "",
  instructions: "",
  status: "ready",
  workspacePath: `/workspaces/${id}`,
  codexThreadId: null,
  lastError: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const createHarness = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "relay-countdown-removal-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.agents.push(
      agentRow(PARTICIPANT_ONE.id, PARTICIPANT_ONE.name),
      agentRow(PARTICIPANT_TWO.id, PARTICIPANT_TWO.name),
      agentRow(PARTICIPANT_THREE.id, PARTICIPANT_THREE.name),
    );
  });

  const clock = new AdvancingClock();
  const ids = new DeterministicIdGenerator();
  const repository = new DurableCoordinationRepository({ store, clock, ids });
  const service = new CoordinationService({
    agentDirectory: new FakeAgentDirectory(SESSION_PARTICIPANTS),
    repository,
    workflow: new VerifiedHandoffWorkflowV1(),
    sessionWorkflow: new SharedSessionWorkflowV1(),
    contextBuilder: new RoleScopedContextBuilder(),
    artifactProtocol: new CoordinationArtifactProtocolDispatchV1(
      new VerifiedHandoffArtifactProtocol({ clock, ids }),
      new SharedSessionArtifactProtocol({ clock, ids }),
    ),
    runtime: new ScriptedCoordinationRuntime([]),
    clock,
    ids,
    reconcileIntervalMs: 0,
  });
  return { store, repository, service };
};

/**
 * A session exactly as the pre-deletion engine persisted it: the protocol name,
 * its start value, and the shared countdown state, with one committed message.
 * Nothing here is constructed through the current engine, because the current
 * engine can no longer produce it -- that is the point.
 */
const storedCountdownRun = (
  status: CoordinationRun["status"] = "completed",
): CoordinationRun => ({
  id: RUN_ID,
  name: "Countdown session",
  objective: "Count down from 2 to 1 together.",
  requiredSections: [],
  participants: SESSION_PARTICIPANTS.map((agent) => ({
    role: "participant" as const,
    agentId: agent.id,
    agentNameSnapshot: agent.name,
  })),
  policy: {
    ...DEFAULT_COORDINATION_POLICY,
    workflow: "shared_session_v1",
    maxRevisions: 0,
    maxTurns: 2,
    sessionProtocol: "countdown",
    sessionStartValue: 2,
  },
  status,
  phase: "sessioning",
  revision: 0,
  nextTurnSequence: 2,
  activeTurnIds: [],
  sharedState: { nextExpectedNumber: 1 },
  version: 4,
  createdAt: NOW,
  updatedAt: NOW,
} as unknown as CoordinationRun);

const storedCountdownTurn = (): CoordinationTurn => ({
  id: "turn-stored-countdown-1",
  runId: RUN_ID,
  sequence: 1,
  role: "participant",
  agentId: PARTICIPANT_ONE.id,
  kind: "session_turn",
  status: "committed",
  attemptCount: 1,
  inputArtifactIds: [],
  outputArtifactId: "artifact-stored-countdown-1",
  lastValidationErrors: [],
  createdAt: NOW,
  completedAt: NOW,
});

const storedCountdownArtifact = (): CoordinationArtifact => ({
  id: "artifact-stored-countdown-1",
  runId: RUN_ID,
  turnId: "turn-stored-countdown-1",
  createdByRole: "participant",
  createdByAgentId: PARTICIPANT_ONE.id,
  type: "session_message",
  payload: { schemaVersion: 1, type: "session_message", content: "2" },
  transcriptSequence: 1,
  sizeChars: 1,
  createdAt: NOW,
});

const seedStoredCountdown = async (
  store: JsonStore,
  status: CoordinationRun["status"] = "completed",
): Promise<void> => {
  await store.mutate((database) => {
    database.coordinationRuns.push(storedCountdownRun(status));
    database.coordinationTurns.push(storedCountdownTurn());
    database.coordinationArtifacts.push(storedCountdownArtifact());
  });
};

describe("PA14-18 the countdown engine is gone", () => {
  it("refuses to create a countdown session", async () => {
    // This exact policy was valid before the deletion: start at 3, three turns.
    const { service } = await createHarness();
    await expect(
      service.createRun({
        ...CREATE_FREE_CHAT_REQUEST,
        policy: { sessionProtocol: "countdown", sessionStartValue: 3, maxTurns: 3 },
      } as never),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });
  });

  it("refuses a countdown start value as an unknown policy field", async () => {
    // Also previously valid: an unnamed protocol meant countdown, and a start
    // value was how a caller sized it.
    const { service } = await createHarness();
    await expect(
      service.createRun({
        ...CREATE_FREE_CHAT_REQUEST,
        policy: { sessionStartValue: 4, maxTurns: 4 },
      } as never),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });
  });

  it("creates a free-chat session when no protocol is named", async () => {
    // Countdown used to be the default. With the engine gone the only protocol
    // is free chat, so an unspecified protocol can only mean free chat.
    const { service } = await createHarness();
    const run = await service.createRun({
      ...CREATE_FREE_CHAT_REQUEST,
      policy: { maxTurns: 5 },
    });

    expect(run.policy.sessionProtocol).toBe("free_chat");
    expect(run.policy).not.toHaveProperty("sessionStartValue");
    expect(run).not.toHaveProperty("sharedState");
  });

  it("never schedules a stored countdown run that is somehow still live", () => {
    // Refusing it is the safe outcome: no engine path exists to advance it, so
    // it must be reported as invalid rather than driven by the free-chat rules.
    const live = storedCountdownRun("running");
    const view: WorkflowView = {
      run: live,
      turns: [storedCountdownTurn()],
      artifacts: [storedCountdownArtifact()],
    };

    expect(new SharedSessionWorkflowV1().decideNext(view)).toMatchObject({
      kind: "fail",
      code: "INVALID_STATE",
    });
  });
});

describe("PA14-18 stored countdown history still reads", () => {
  it("returns a pre-deletion countdown run with every persisted field intact", async () => {
    const { store, repository } = await createHarness();
    await seedStoredCountdown(store);

    const details = await repository.getRunDetails(RUN_ID);

    expect(details?.run.policy.sessionProtocol).toBe("countdown");
    // The engine no longer declares these fields, but the ledger still carries
    // them and the read path must not strip what it did not write.
    expect(details?.run.policy).toMatchObject({ sessionStartValue: 2 });
    expect(details?.run).toMatchObject({ sharedState: { nextExpectedNumber: 1 } });
    expect(details?.run.status).toBe("completed");
  });

  it("renders the stored countdown transcript unchanged", async () => {
    const { store, repository } = await createHarness();
    await seedStoredCountdown(store);

    const details = await repository.getRunDetails(RUN_ID);

    expect(details?.turns).toHaveLength(1);
    expect(details?.turns[0]).toMatchObject({ kind: "session_turn", status: "committed" });
    const message = details?.artifacts.find(({ type }) => type === "session_message");
    expect(message?.type === "session_message" ? message.payload.content : undefined).toBe("2");
    expect(message?.transcriptSequence).toBe(1);
  });

  it("lists a stored countdown run alongside current sessions", async () => {
    const { store, repository } = await createHarness();
    await seedStoredCountdown(store);

    const runs = await repository.listRuns();

    expect(runs.map(({ id }) => id)).toContain(RUN_ID);
    expect(runs.find(({ id }) => id === RUN_ID)?.policy.sessionProtocol).toBe("countdown");
  });
});
