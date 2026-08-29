import { describe, expect, it } from "vitest";
import { VerifiedHandoffArtifactProtocol } from "./artifact-protocol.js";
import { RoleScopedContextBuilder } from "./context-builder.js";
import { CoordinationService } from "./service.js";
import { VerifiedHandoffWorkflowV1 } from "./workflow.js";
import type { CoordinationRunDetails, CoordinationRunId } from "./types.js";
import { AdvancingClock, DeterministicIdGenerator } from "./testing/controls.js";
import { InMemoryCoordinationRepository } from "./testing/memory-repository.js";
import {
  FakeAgentDirectory,
  ScriptedCoordinationRuntime,
  succeeds,
  type ScriptedRuntimeStep,
} from "./testing/fakes.js";
import {
  APPROVING_REVIEW_OUTPUT,
  CREATE_RUN_REQUEST,
  CRITIC_AGENT,
  FINALIZER_AGENT,
  PLANNER_AGENT,
  REJECTING_REVIEW_OUTPUT,
  VALID_FINAL_OUTPUT,
  VALID_FINAL_PAYLOAD,
  VALID_PROPOSAL_OUTPUT,
  VALID_PROPOSAL_PAYLOAD,
} from "./testing/fixtures.js";

/**
 * The Phase 1 walking skeleton: the real workflow, artifact protocol, and
 * context builder, driven by the shared in-memory repository and scripted
 * runtime. No disk, HTTP, timers, or model calls take part.
 */
export const harness = (steps: ScriptedRuntimeStep[]) => {
  const clock = new AdvancingClock();
  const ids = new DeterministicIdGenerator();
  const repository = new InMemoryCoordinationRepository(clock);
  const runtime = new ScriptedCoordinationRuntime(steps);
  const service = new CoordinationService({
    agentDirectory: new FakeAgentDirectory(),
    repository,
    workflow: new VerifiedHandoffWorkflowV1(),
    contextBuilder: new RoleScopedContextBuilder(),
    artifactProtocol: new VerifiedHandoffArtifactProtocol({ clock, ids }),
    runtime,
    clock,
    ids,
  });
  return { service, repository, runtime, clock, ids };
};

const TERMINAL = new Set(["completed", "failed", "stopped"]);

/**
 * Drives the background loop to a terminal state by yielding to the microtask
 * queue. Every scripted dependency settles on the microtask queue, so this needs
 * no timer and no arbitrary sleep.
 */
export const settle = async (
  service: CoordinationService,
  runId: CoordinationRunId,
  ticks = 2_000,
): Promise<CoordinationRunDetails> => {
  for (let tick = 0; tick < ticks; tick += 1) {
    const details = await service.getRun(runId);
    if (details && TERMINAL.has(details.run.status)) {
      return details;
    }
    await Promise.resolve();
  }
  throw new Error("coordination run did not reach a terminal state");
};

export const HAPPY_PATH: ScriptedRuntimeStep[] = [
  succeeds(VALID_PROPOSAL_OUTPUT),
  succeeds(APPROVING_REVIEW_OUTPUT),
  succeeds(VALID_FINAL_OUTPUT),
];

export const startRun = async (steps: ScriptedRuntimeStep[]) => {
  const context = harness(steps);
  const run = await context.service.createRun(CREATE_RUN_REQUEST);
  await context.service.startRun(run.id);
  return { ...context, runId: run.id };
};

describe("walking skeleton: schedule, attempt, validate, commit", () => {
  it("completes Planner to Critic to Finaliser with the real components", async () => {
    const { service, runtime, runId } = await startRun(HAPPY_PATH);
    const details = await settle(service, runId);

    expect(details.run.status).toBe("completed");
    expect(details.run.phase).toBe("done");
    expect(details.run.errorCode).toBeUndefined();
    expect(details.run.activeTurnId).toBeUndefined();

    expect(details.turns.map((turn) => [turn.sequence, turn.role, turn.kind, turn.status])).toEqual(
      [
        [1, "planner", "initial_proposal", "committed"],
        [2, "critic", "proposal_review", "committed"],
        [3, "finalizer", "finalization", "committed"],
      ],
    );
    expect(details.artifacts.map((artifact) => artifact.type)).toEqual([
      "proposal",
      "review",
      "final",
    ]);
    expect(details.attempts.map((attempt) => attempt.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(runtime.starts.map((call) => call.agentId)).toEqual([
      PLANNER_AGENT.id,
      CRITIC_AGENT.id,
      FINALIZER_AGENT.id,
    ]);
  });

  it("commits each turn's output artifact under the acting role", async () => {
    const { service, runId } = await startRun(HAPPY_PATH);
    const details = await settle(service, runId);

    for (const turn of details.turns) {
      const artifact = details.artifacts.find(
        (candidate) => candidate.id === turn.outputArtifactId,
      );
      expect(artifact).toBeDefined();
      expect(artifact?.turnId).toBe(turn.id);
      expect(artifact?.createdByRole).toBe(turn.role);
      expect(artifact?.createdByAgentId).toBe(turn.agentId);
    }

    const final = details.artifacts.find((artifact) => artifact.type === "final");
    expect(details.run.finalArtifactId).toBe(final?.id);
    expect(final?.payload).toEqual(VALID_FINAL_PAYLOAD);
  });

  it("reloads durable state between transitions", async () => {
    const { service, runId } = await startRun(HAPPY_PATH);
    const details = await settle(service, runId);

    expect(details.run.nextTurnSequence).toBe(4);
    expect(details.run.version).toBeGreaterThan(details.turns.length);
    expect(details.turns.every((turn) => turn.activeAttemptId === undefined)).toBe(true);
    expect(details.attempts.every((attempt) => attempt.finishedAt !== undefined)).toBe(true);
    expect(new Set(details.attempts.map((attempt) => attempt.leaseToken)).size).toBe(3);
  });

  it("gives every attempt a distinct lease and correlated Agent run", async () => {
    const { service, repository, runId } = await startRun(HAPPY_PATH);
    await settle(service, runId);
    const details = await repository.getRunDetails(runId);

    expect(details?.attempts.map((attempt) => attempt.agentRunId)).toEqual([
      "agent-run-0001",
      "agent-run-0002",
      "agent-run-0003",
    ]);
    expect(details?.attempts.every((attempt) => attempt.promptDigest?.length === 64)).toBe(true);
  });

  it("sends each role only the context its turn allows", async () => {
    const { service, runtime, runId } = await startRun([
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(REJECTING_REVIEW_OUTPUT),
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(APPROVING_REVIEW_OUTPUT),
      succeeds(VALID_FINAL_OUTPUT),
    ]);
    await settle(service, runId);

    const [planner, critic, revision, secondReview, finalizer] = runtime.starts.map(
      (call) => call.prompt,
    );

    expect(planner).toContain("Role: planner");
    expect(planner).toContain("(none for this turn)");

    expect(critic).toContain("Role: critic");
    expect(critic).toContain(VALID_PROPOSAL_PAYLOAD.summary);

    expect(revision).toContain("Role: planner");
    expect(revision).toContain("Strengthen the risks section before finalization.");

    expect(secondReview).toContain("Role: critic");
    expect(secondReview).not.toContain("Strengthen the risks section before finalization.");

    expect(finalizer).toContain("Role: finalizer");
    expect(finalizer).toContain("The proposal covers every required section.");
  });
});

describe("walking skeleton: lease is required to commit", () => {
  it("refuses a commit that presents a superseded lease", async () => {
    const clock = new AdvancingClock();
    const repository = new InMemoryCoordinationRepository(clock);
    const run = await repository.createRun({
      run: {
        id: "run-lease",
        name: "Lease",
        objective: "Objective",
        requiredSections: [{ key: "users", title: "Users" }],
        participants: [
          { role: "planner", agentId: PLANNER_AGENT.id, agentNameSnapshot: "Planner" },
          { role: "critic", agentId: CRITIC_AGENT.id, agentNameSnapshot: "Critic" },
          { role: "finalizer", agentId: FINALIZER_AGENT.id, agentNameSnapshot: "Finaliser" },
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
        version: 1,
        createdAt: clock.nowIso(),
        updatedAt: clock.nowIso(),
      },
    });
    const started = await repository.startRun(run.id);
    if (started.kind !== "started") throw new Error("expected the run to start");

    const turn = {
      id: "turn-lease",
      runId: run.id,
      sequence: 1,
      role: "planner" as const,
      agentId: PLANNER_AGENT.id,
      kind: "initial_proposal" as const,
      status: "scheduled" as const,
      attemptCount: 0,
      inputArtifactIds: [],
      lastValidationErrors: [],
      createdAt: clock.nowIso(),
    };
    await repository.scheduleTurn({
      runId: run.id,
      expectedRunVersion: started.run.version,
      turn,
      nextPhase: "drafting",
      nextRevision: 0,
    });

    const attempt = {
      id: "attempt-lease",
      runId: run.id,
      turnId: turn.id,
      number: 1,
      agentId: PLANNER_AGENT.id,
      leaseToken: "lease-first",
      status: "running" as const,
      createdAt: clock.nowIso(),
    };
    await repository.beginAttempt({ runId: run.id, turnId: turn.id, attempt });

    const artifact = {
      id: "artifact-late",
      runId: run.id,
      turnId: turn.id,
      createdByRole: "planner" as const,
      createdByAgentId: PLANNER_AGENT.id,
      sizeChars: 10,
      createdAt: clock.nowIso(),
      type: "proposal" as const,
      payload: VALID_PROPOSAL_PAYLOAD,
    };

    expect(
      await repository.commitAcceptedArtifact({
        runId: run.id,
        turnId: turn.id,
        attemptId: attempt.id,
        leaseToken: "lease-someone-else",
        artifact,
      }),
    ).toEqual({ kind: "stale" });

    expect(
      await repository.attachAgentRun({
        attemptId: attempt.id,
        leaseToken: "lease-someone-else",
        agentRunId: "agent-run-x",
      }),
    ).toBe("stale");

    await repository.finishAttempt({
      runId: run.id,
      turnId: turn.id,
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken,
      status: "invalid_output",
      errorCode: "INVALID_AGENT_OUTPUT",
      errorMessage: "rejected",
    });

    expect(
      await repository.commitAcceptedArtifact({
        runId: run.id,
        turnId: turn.id,
        attemptId: attempt.id,
        leaseToken: attempt.leaseToken,
        artifact,
      }),
    ).toEqual({ kind: "stale" });

    const details = await repository.getRunDetails(run.id);
    expect(details?.artifacts).toEqual([]);
  });
});
