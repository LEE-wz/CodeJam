/**
 * P14-10: coordinator planning as a workflow decision, and the execution of a
 * committed plan.
 *
 * The first half exercises `decideNext` as the pure function it is: durable
 * state in, one frozen `WorkflowDecision` out. The second half drives the real
 * `CoordinationService` against the scripted runtime and the in-memory
 * repository, so ordering, waves, restart, and stop are observed as durable
 * consequences rather than asserted about in isolation.
 */
import { describe, expect, it } from "vitest";
import {
  CoordinationArtifactProtocolDispatchV1,
  SharedSessionArtifactProtocol,
  VerifiedHandoffArtifactProtocol,
} from "./artifact-protocol.js";
import type { WorkflowView } from "./contracts.js";
import { RoleScopedContextBuilder } from "./context-builder.js";
import { CoordinationService } from "./service.js";
import { SharedSessionWorkflowV1 } from "./session-workflow.js";
import { VerifiedHandoffWorkflowV1 } from "./workflow.js";
import { AdvancingClock, DeterministicIdGenerator } from "./testing/controls.js";
import {
  FakeAgentDirectory,
  ScriptedCoordinationRuntime,
  succeeds,
  type ScriptedRuntimeStep,
} from "./testing/fakes.js";
import { InMemoryCoordinationRepository } from "./testing/memory-repository.js";
import {
  CREATE_PLANNED_SESSION_REQUEST,
  PARTICIPANT_ONE,
  PARTICIPANT_THREE,
  PARTICIPANT_TWO,
  SESSION_PARTICIPANTS,
  freeChatPayload,
  fullRosterPlan,
  planAssignment,
  planPayload,
} from "./testing/session-fixtures.js";
import type {
  CoordinationArtifact,
  CoordinationParticipant,
  CoordinationRun,
  CoordinationRunDetails,
  CoordinationTurn,
  CreateSessionRunRequest,
  SessionPlanPayload,
} from "./types.js";
import { DEFAULT_COORDINATION_POLICY } from "./types.js";

const now = "2026-08-31T00:00:00.000Z";

const participants = (count = 3): CoordinationParticipant[] =>
  SESSION_PARTICIPANTS.slice(0, count).map((agent) => ({
    role: "participant",
    agentId: agent.id,
    agentNameSnapshot: agent.name,
  }));

const plannedRun = (overrides: Partial<CoordinationRun> = {}): CoordinationRun => ({
  id: "run-session",
  name: "Session",
  objective: "Work together",
  requiredSections: [],
  participants: participants(),
  policy: {
    ...DEFAULT_COORDINATION_POLICY,
    workflow: "shared_session_v1",
    sessionProtocol: "free_chat",
    sessionPlanning: "coordinator",
    maxTurns: 20,
  },
  status: "running",
  phase: "sessioning",
  revision: 0,
  nextTurnSequence: 1,
  activeTurnIds: [],
  version: 1,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

/**
 * Builds a durable view for one round: the user message, then any records that
 * followed it, in transcript order. Sequence 1 is always the user message, so
 * "belongs to this round" is expressible as "sequence greater than 1".
 */
const roundView = (options: {
  plan?: SessionPlanPayload | undefined;
  replies?: Array<{ agent: string; content: string }>;
  planCommitted?: boolean;
  run?: Partial<CoordinationRun>;
}): WorkflowView => {
  const runParticipants = participants();
  const artifacts: CoordinationArtifact[] = [
    {
      id: "artifact-user",
      runId: "run-session",
      type: "user_message",
      payload: { schemaVersion: 1, type: "user_message", content: "Count down from 3 to 1." },
      createdBy: { kind: "user" },
      transcriptSequence: 1,
      sizeChars: 24,
      createdAt: now,
    },
  ];
  const turns: CoordinationTurn[] = [];
  let sequence = 2;
  let turnSequence = 1;

  if (options.plan) {
    const committed = options.planCommitted ?? true;
    turns.push({
      id: "turn-plan",
      runId: "run-session",
      sequence: turnSequence,
      role: "participant",
      agentId: runParticipants[0]!.agentId,
      kind: "session_plan",
      status: committed ? "committed" : "scheduled",
      attemptCount: 1,
      inputArtifactIds: ["artifact-user"],
      ...(committed ? { outputArtifactId: "artifact-plan" } : {}),
      lastValidationErrors: [],
      createdAt: now,
    });
    turnSequence += 1;
    if (committed) {
      artifacts.push({
        id: "artifact-plan",
        runId: "run-session",
        turnId: "turn-plan",
        type: "session_plan",
        payload: options.plan,
        createdByRole: "participant",
        createdByAgentId: runParticipants[0]!.agentId,
        transcriptSequence: sequence,
        sizeChars: JSON.stringify(options.plan).length,
        createdAt: now,
      });
      sequence += 1;
    }
  }

  for (const [index, reply] of (options.replies ?? []).entries()) {
    const turnId = `turn-reply-${index + 1}`;
    turns.push({
      id: turnId,
      runId: "run-session",
      sequence: turnSequence,
      role: "participant",
      agentId: reply.agent,
      kind: "session_turn",
      status: "committed",
      attemptCount: 1,
      inputArtifactIds: [],
      outputArtifactId: `artifact-reply-${index + 1}`,
      lastValidationErrors: [],
      createdAt: now,
    });
    turnSequence += 1;
    artifacts.push({
      id: `artifact-reply-${index + 1}`,
      runId: "run-session",
      turnId,
      type: "session_message",
      payload: freeChatPayload(reply.content),
      createdByRole: "participant",
      createdByAgentId: reply.agent,
      transcriptSequence: sequence,
      sizeChars: reply.content.length,
      createdAt: now,
    });
    sequence += 1;
  }

  return {
    run: plannedRun({
      lastUserArtifactId: "artifact-user",
      nextTurnSequence: turnSequence,
      ...options.run,
    }),
    turns,
    artifacts,
  };
};

const workflow = new SharedSessionWorkflowV1();

describe("coordinator planning decisions (P14-03)", () => {
  it("schedules exactly one plan turn, assigned to the first participant", () => {
    const decision = workflow.decideNext(roundView({}));

    expect(decision).toMatchObject({
      kind: "schedule",
      turnKind: "session_plan",
      expectedArtifactType: "session_plan",
      role: "participant",
      // The recorded D3 decision: the first participant doubles as coordinator.
      agentId: PARTICIPANT_ONE.id,
      phase: "sessioning",
      revision: 0,
    });
  });

  it("gives the coordinator the transcript including the new user message", () => {
    const decision = workflow.decideNext(roundView({}));
    expect(decision).toMatchObject({ kind: "schedule" });
    if (decision.kind !== "schedule") throw new Error("expected a schedule decision");
    expect(decision.inputArtifactIds).toEqual(["artifact-user"]);
  });

  it("does not schedule a second plan while the first is still running", () => {
    // An uncommitted plan turn means the round already has an owner; the loop
    // is waiting on it rather than deciding again.
    const view = roundView({ plan: fullRosterPlan("sequential"), planCommitted: false });
    const decision = workflow.decideNext(view);
    expect(decision).toMatchObject({ kind: "schedule", turnKind: "session_plan" });
  });

  it("never schedules a second plan once one is committed for this user message", () => {
    const decision = workflow.decideNext(
      roundView({ plan: fullRosterPlan("sequential") }),
    );
    expect(decision).toMatchObject({ kind: "schedule", turnKind: "session_turn" });
  });

  it("re-derives the same plan turn after a rejected attempt, never a duplicate", () => {
    // A retry leaves the turn uncommitted and adds no artifact, so the derived
    // decision is byte-identical to the first one.
    const first = workflow.decideNext(roundView({}));
    const afterRejection = workflow.decideNext(
      roundView({ run: { version: 4 } }),
    );
    expect(afterRejection).toEqual(first);
  });

  it("schedules no plan turn under the round_robin policy", () => {
    const view = roundView({ run: { policy: { ...plannedRun().policy, sessionPlanning: "round_robin" } } });
    expect(workflow.decideNext(view)).toMatchObject({
      kind: "schedule",
      turnKind: "session_turn",
    });
  });

  it("schedules no plan turn for a stored session created before Phase 14", () => {
    const legacy = plannedRun().policy;
    delete (legacy as { sessionPlanning?: unknown }).sessionPlanning;
    const view = roundView({ run: { policy: legacy } });
    expect(workflow.decideNext(view)).toMatchObject({
      kind: "schedule",
      turnKind: "session_turn",
    });
  });
});

describe("plan execution decisions (P14-04)", () => {
  it("schedules sequential assignments one at a time, in position order", () => {
    const plan = planPayload("sequential", [
      planAssignment(PARTICIPANT_THREE, 1),
      planAssignment(PARTICIPANT_ONE, 2),
      planAssignment(PARTICIPANT_TWO, 3),
    ]);

    // Position, not roster order, decides who goes first.
    expect(workflow.decideNext(roundView({ plan }))).toMatchObject({
      kind: "schedule",
      turnKind: "session_turn",
      agentId: PARTICIPANT_THREE.id,
    });

    const afterFirst = workflow.decideNext(
      roundView({ plan, replies: [{ agent: PARTICIPANT_THREE.id, content: "3" }] }),
    );
    expect(afterFirst).toMatchObject({ kind: "schedule", agentId: PARTICIPANT_ONE.id });

    const afterSecond = workflow.decideNext(
      roundView({
        plan,
        replies: [
          { agent: PARTICIPANT_THREE.id, content: "3" },
          { agent: PARTICIPANT_ONE.id, content: "2" },
        ],
      }),
    );
    expect(afterSecond).toMatchObject({ kind: "schedule", agentId: PARTICIPANT_TWO.id });
  });

  it("hands every sequential contributor the committed plan alongside the transcript", () => {
    const decision = workflow.decideNext(roundView({ plan: fullRosterPlan("sequential") }));
    if (decision.kind !== "schedule") throw new Error("expected a schedule decision");
    expect(decision.inputArtifactIds).toContain("artifact-plan");
    expect(decision.inputArtifactIds).toContain("artifact-user");
  });

  it("schedules a parallel plan as one wave", () => {
    const decision = workflow.decideNext(roundView({ plan: fullRosterPlan("parallel") }));
    expect(decision.kind).toBe("schedule_wave");
    if (decision.kind !== "schedule_wave") throw new Error("expected a wave");
    expect(decision.turns.map(({ agentId }) => agentId)).toEqual([
      PARTICIPANT_ONE.id,
      PARTICIPANT_TWO.id,
      PARTICIPANT_THREE.id,
    ]);
    expect(decision.turns.every(({ turnKind }) => turnKind === "session_turn")).toBe(true);
  });

  it("awaits input once every assignment has committed", () => {
    const plan = fullRosterPlan("parallel");
    const decision = workflow.decideNext(
      roundView({
        plan,
        replies: [
          { agent: PARTICIPANT_ONE.id, content: "a" },
          { agent: PARTICIPANT_TWO.id, content: "b" },
          { agent: PARTICIPANT_THREE.id, content: "c" },
        ],
      }),
    );
    expect(decision).toEqual({ kind: "await_input" });
  });

  it("awaits input when a partial plan's assignees have all answered", () => {
    // Unassigned participants are not owed a turn: the plan defines the round.
    const plan = planPayload("parallel", [planAssignment(PARTICIPANT_TWO, 1)]);
    const decision = workflow.decideNext(
      roundView({ plan, replies: [{ agent: PARTICIPANT_TWO.id, content: "only me" }] }),
    );
    expect(decision).toEqual({ kind: "await_input" });
  });

  it("re-derives the same remaining work after a restart mid-round", () => {
    const plan = fullRosterPlan("sequential");
    const view = roundView({ plan, replies: [{ agent: PARTICIPANT_ONE.id, content: "first" }] });

    // A restart changes only the run's liveness, never its committed history.
    const beforeRestart = workflow.decideNext(view);
    const afterRestart = workflow.decideNext({
      ...view,
      run: { ...view.run, status: "running", activeTurnIds: [], version: view.run.version + 2 },
    });
    expect(afterRestart).toEqual(beforeRestart);
    expect(afterRestart).toMatchObject({ agentId: PARTICIPANT_TWO.id });
  });

  it("refuses a stored plan that names an Agent who is not a participant", () => {
    const plan = planPayload("sequential", [
      { agentId: "agent-removed", position: 1, instruction: "Go." },
    ]);
    expect(workflow.decideNext(roundView({ plan }))).toMatchObject({
      kind: "fail",
      code: "INVALID_STATE",
    });
  });

  it("still enforces the hard turn ceiling during a planned round", () => {
    const plan = fullRosterPlan("sequential");
    const view = roundView({
      plan,
      replies: [{ agent: PARTICIPANT_ONE.id, content: "one" }],
      run: { policy: { ...plannedRun().policy, maxTurns: 1 } },
    });
    expect(workflow.decideNext(view)).toMatchObject({
      kind: "fail",
      code: "MAX_TURNS_EXCEEDED",
    });
  });
});

/* ------------------------------------------------------------------ *
 * Durable execution through the real service.
 * ------------------------------------------------------------------ */

const settled = new Set(["awaiting_input", "completed", "failed", "stopped"]);

const harness = (steps: ScriptedRuntimeStep[], roster = SESSION_PARTICIPANTS) => {
  const clock = new AdvancingClock();
  const ids = new DeterministicIdGenerator();
  const repository = new InMemoryCoordinationRepository(clock);
  const runtime = new ScriptedCoordinationRuntime(steps);
  const service = new CoordinationService({
    agentDirectory: new FakeAgentDirectory(roster),
    repository,
    workflow: new VerifiedHandoffWorkflowV1(),
    sessionWorkflow: new SharedSessionWorkflowV1(),
    contextBuilder: new RoleScopedContextBuilder(),
    artifactProtocol: new CoordinationArtifactProtocolDispatchV1(
      new VerifiedHandoffArtifactProtocol({ clock, ids }),
      new SharedSessionArtifactProtocol({ clock, ids }),
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
  ticks = 5_000,
): Promise<CoordinationRunDetails> => {
  for (let tick = 0; tick < ticks; tick += 1) {
    const details = await service.getRun(runId);
    if (details && settled.has(details.run.status)) return details;
    await Promise.resolve();
  }
  throw new Error("planned session did not settle");
};

const flush = async (ticks = 400): Promise<void> => {
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
};

const startPlanned = async (
  steps: ScriptedRuntimeStep[],
  request: CreateSessionRunRequest = CREATE_PLANNED_SESSION_REQUEST,
  prompt = "Count down from 3 to 1, one number each, in order.",
) => {
  const context = harness(steps);
  const run = await context.service.createRun(request);
  await context.service.resumeRun(run.id, { content: prompt });
  return { ...context, runId: run.id };
};

const transcript = (details: CoordinationRunDetails) =>
  details.artifacts
    .filter((artifact) => artifact.type === "session_message")
    .map((artifact) => (artifact.type === "session_message" ? artifact.payload.content : ""));

describe("planned rounds through the real service", () => {
  it("produces ordered output from a sequential plan with no numeric rule in the engine", async () => {
    const plan = planPayload("sequential", [
      planAssignment(PARTICIPANT_ONE, 1, "Say the first number."),
      planAssignment(PARTICIPANT_TWO, 2, "Say the next number."),
      planAssignment(PARTICIPANT_THREE, 3, "Say the last number."),
    ]);
    const { service, runId } = await startPlanned([
      succeeds(JSON.stringify(plan)),
      succeeds(JSON.stringify(freeChatPayload("3"))),
      succeeds(JSON.stringify(freeChatPayload("2"))),
      succeeds(JSON.stringify(freeChatPayload("1", true))),
    ]);

    const details = await settle(service, runId);
    expect(details.run.status).toBe("awaiting_input");
    expect(transcript(details)).toEqual(["3", "2", "1"]);

    // One plan turn plus one turn per assignment, in that order.
    expect(details.turns.map(({ kind }) => kind)).toEqual([
      "session_plan",
      "session_turn",
      "session_turn",
      "session_turn",
    ]);
    expect(details.turns.every(({ status }) => status === "committed")).toBe(true);
    expect(details.turns.slice(1).map(({ agentId }) => agentId)).toEqual([
      PARTICIPANT_ONE.id,
      PARTICIPANT_TWO.id,
      PARTICIPANT_THREE.id,
    ]);
  });

  it("commits the plan as attributed evidence in the transcript order", async () => {
    const plan = fullRosterPlan("sequential");
    const { service, runId } = await startPlanned([
      succeeds(JSON.stringify(plan)),
      succeeds(JSON.stringify(freeChatPayload("a"))),
      succeeds(JSON.stringify(freeChatPayload("b"))),
      succeeds(JSON.stringify(freeChatPayload("c", true))),
    ]);
    const details = await settle(service, runId);

    const planArtifact = details.artifacts.find((artifact) => artifact.type === "session_plan");
    expect(planArtifact).toMatchObject({
      type: "session_plan",
      createdByRole: "participant",
      createdByAgentId: PARTICIPANT_ONE.id,
    });
    // The user message is 1 and the plan immediately follows it.
    expect(planArtifact?.transcriptSequence).toBe(2);
    const sequences = details.artifacts
      .map(({ transcriptSequence }) => transcriptSequence)
      .filter((value): value is number => typeof value === "number")
      .sort((left, right) => left - right);
    expect(sequences).toEqual([1, 2, 3, 4, 5]);
  });

  it("delivers each participant only its own assignment instruction", async () => {
    const plan = planPayload("sequential", [
      planAssignment(PARTICIPANT_ONE, 1, "Open with the headline risk."),
      planAssignment(PARTICIPANT_TWO, 2, "Add the mitigation."),
    ]);
    const { service, runtime, runId } = await startPlanned([
      succeeds(JSON.stringify(plan)),
      succeeds(JSON.stringify(freeChatPayload("Risk noted."))),
      succeeds(JSON.stringify(freeChatPayload("Mitigation noted.", true))),
    ]);
    await settle(service, runId);

    const [, firstPrompt, secondPrompt] = runtime.starts.map(({ prompt }) => prompt);
    expect(firstPrompt).toContain("Open with the headline risk.");
    expect(firstPrompt).toContain("position 1 of 2");
    expect(firstPrompt).not.toContain("Add the mitigation.");

    expect(secondPrompt).toContain("Add the mitigation.");
    expect(secondPrompt).toContain("position 2 of 2");
    expect(secondPrompt).not.toContain("Open with the headline risk.");
  });

  it("gives the coordinator the roster with ids and never an expected answer", async () => {
    const { service, runtime, runId } = await startPlanned([
      succeeds(JSON.stringify(fullRosterPlan("parallel"))),
      succeeds(JSON.stringify(freeChatPayload("a"))),
      succeeds(JSON.stringify(freeChatPayload("b"))),
      succeeds(JSON.stringify(freeChatPayload("c", true))),
    ]);
    await settle(service, runId);

    const planPrompt = runtime.starts[0]?.prompt ?? "";
    expect(planPrompt).toContain("Role: coordinator");
    expect(planPrompt).toContain("Participants:");
    for (const agent of SESSION_PARTICIPANTS) {
      expect(planPrompt).toContain(agent.id);
      expect(planPrompt).toContain(agent.name);
    }
    expect(planPrompt).toContain('"type":"session_plan"');
    // The countdown answer must never be stated by the engine.
    expect(planPrompt).not.toContain("3, 2, 1");
  });

  it("executes a parallel plan as one wave bounded by maxParallelTurns", async () => {
    const { service, runId } = await startPlanned(
      [
        succeeds(JSON.stringify(fullRosterPlan("parallel"))),
        succeeds(JSON.stringify(freeChatPayload("a", true))),
        succeeds(JSON.stringify(freeChatPayload("b", true))),
        succeeds(JSON.stringify(freeChatPayload("c", true))),
      ],
      {
        ...CREATE_PLANNED_SESSION_REQUEST,
        policy: {
          sessionProtocol: "free_chat",
          sessionPlanning: "coordinator",
          maxTurns: 20,
          maxParallelTurns: 2,
        },
      },
    );
    const details = await settle(service, runId);

    expect(details.run.status).toBe("awaiting_input");
    expect(details.turns.filter(({ kind }) => kind === "session_turn")).toHaveLength(3);
    expect(transcript(details).sort()).toEqual(["a", "b", "c"]);
  });

  it("retries a rejected plan on the same turn and commits exactly one", async () => {
    const { service, runtime, runId } = await startPlanned([
      // A structurally invalid plan: positions are not contiguous from 1.
      succeeds(
        JSON.stringify(
          planPayload("sequential", [
            planAssignment(PARTICIPANT_ONE, 1),
            planAssignment(PARTICIPANT_TWO, 5),
          ]),
        ),
      ),
      succeeds(
        JSON.stringify(
          planPayload("sequential", [
            planAssignment(PARTICIPANT_ONE, 1),
            planAssignment(PARTICIPANT_TWO, 2),
          ]),
        ),
      ),
      succeeds(JSON.stringify(freeChatPayload("first"))),
      succeeds(JSON.stringify(freeChatPayload("second", true))),
    ]);
    const details = await settle(service, runId);

    expect(details.run.status).toBe("awaiting_input");
    const planTurns = details.turns.filter(({ kind }) => kind === "session_plan");
    expect(planTurns).toHaveLength(1);
    expect(planTurns[0]).toMatchObject({ status: "committed", attemptCount: 2 });
    expect(details.artifacts.filter(({ type }) => type === "session_plan")).toHaveLength(1);

    // The rejected attempt is durable evidence, and the retry that followed it
    // carried the failed rule back to the same Agent through the ordinary
    // per-turn retry path. (The event ledger itself is asserted in the durable
    // repository and API suites; this in-memory double keeps no events.)
    const rejectedAttempt = details.attempts.find(
      ({ status }) => status === "invalid_output",
    );
    expect(rejectedAttempt).toMatchObject({
      errorCode: "INVALID_AGENT_OUTPUT",
      number: 1,
      agentId: PARTICIPANT_ONE.id,
    });
    const retryPrompt = runtime.starts[1]?.prompt ?? "";
    expect(retryPrompt).toContain("Assignment positions must be contiguous from 1");
    expect(retryPrompt).toContain("Your previous attempt did not produce a valid artifact");
  });

  it("settles the whole planned round on stop and returns to awaiting_input", async () => {
    const { service, runId } = await startPlanned([
      succeeds(JSON.stringify(fullRosterPlan("parallel"))),
      succeeds(JSON.stringify(freeChatPayload("a"))),
      succeeds(JSON.stringify(freeChatPayload("b"))),
      succeeds(JSON.stringify(freeChatPayload("c"))),
    ]);
    await flush(20);
    await service.stopRun(runId);
    const details = await settle(service, runId);

    // Stop cancels only the current wave; the session stays usable (P12-07).
    expect(details.run.status).toBe("awaiting_input");
    expect(details.run.activeTurnIds).toEqual([]);
    expect(
      details.turns.every(({ status }) =>
        ["committed", "cancelled", "failed"].includes(status),
      ),
    ).toBe(true);
    expect(details.attempts.every(({ status }) => status !== "running")).toBe(true);
  });

  it("plans each user message separately across two prompts in one session", async () => {
    const { service, runId } = await startPlanned([
      succeeds(JSON.stringify(planPayload("sequential", [planAssignment(PARTICIPANT_ONE, 1)]))),
      succeeds(JSON.stringify(freeChatPayload("first answer", true))),
      succeeds(JSON.stringify(planPayload("sequential", [planAssignment(PARTICIPANT_TWO, 1)]))),
      succeeds(JSON.stringify(freeChatPayload("second answer", true))),
    ]);
    await settle(service, runId);
    await service.resumeRun(runId, { content: "Now summarise it." });
    const details = await settle(service, runId);

    expect(details.turns.filter(({ kind }) => kind === "session_plan")).toHaveLength(2);
    expect(details.artifacts.filter(({ type }) => type === "session_plan")).toHaveLength(2);
    expect(transcript(details)).toEqual(["first answer", "second answer"]);
    // Every plan is authored by the first participant, both rounds.
    expect(
      details.artifacts
        .filter(({ type }) => type === "session_plan")
        .every((artifact) => artifact.createdByAgentId === PARTICIPANT_ONE.id),
    ).toBe(true);
  });

  it("runs a round_robin session with no plan turn at all", async () => {
    const { service, runId } = await startPlanned(
      [
        succeeds(JSON.stringify(freeChatPayload("a", true))),
        succeeds(JSON.stringify(freeChatPayload("b", true))),
        succeeds(JSON.stringify(freeChatPayload("c", true))),
      ],
      {
        ...CREATE_PLANNED_SESSION_REQUEST,
        policy: {
          sessionProtocol: "free_chat",
          sessionPlanning: "round_robin",
          sessionParallel: true,
          maxTurns: 20,
        },
      },
    );
    const details = await settle(service, runId);

    expect(details.turns.some(({ kind }) => kind === "session_plan")).toBe(false);
    expect(details.artifacts.some(({ type }) => type === "session_plan")).toBe(false);
    expect(details.run.status).toBe("awaiting_input");
  });
});
