import { describe, expect, it } from "vitest";
import { VerifiedHandoffArtifactProtocol } from "./artifact-protocol.js";
import { RoleScopedContextBuilder } from "./context-builder.js";
import { CoordinationService } from "./service.js";
import { VerifiedHandoffWorkflowV1 } from "./workflow.js";
import type { ContextBuilder, VerifiedHandoffWorkflow } from "./contracts.js";
import { CoordinationError } from "./errors.js";
import type {
  CoordinationRun,
  CoordinationRunDetails,
  CoordinationRunId,
} from "./types.js";
import { DEFAULT_COORDINATION_POLICY } from "./types.js";
import { AdvancingClock, DeterministicIdGenerator } from "./testing/controls.js";
import { InMemoryCoordinationRepository } from "./testing/memory-repository.js";
import {
  FakeAgentDirectory,
  ScriptedCoordinationRuntime,
  cancelled,
  deferred,
  failsExecution,
  failsToStart,
  succeeds,
  timesOut,
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
  INVALID_ARTIFACT_OUTPUT,
  VALID_PROPOSAL_OUTPUT,
  VALID_PROPOSAL_PAYLOAD,
} from "./testing/fixtures.js";

/**
 * The Phase 1 walking skeleton: the real workflow, artifact protocol, and
 * context builder, driven by the shared in-memory repository and scripted
 * runtime. No disk, HTTP, timers, or model calls take part.
 */
export const harness = (
  steps: ScriptedRuntimeStep[],
  overrides: {
    contextBuilder?: ContextBuilder;
    workflow?: VerifiedHandoffWorkflow;
  } = {},
) => {
  const clock = new AdvancingClock();
  const ids = new DeterministicIdGenerator();
  const repository = new InMemoryCoordinationRepository(clock);
  const runtime = new ScriptedCoordinationRuntime(steps);
  const service = new CoordinationService({
    agentDirectory: new FakeAgentDirectory(),
    repository,
    workflow: overrides.workflow ?? new VerifiedHandoffWorkflowV1(),
    contextBuilder: overrides.contextBuilder ?? new RoleScopedContextBuilder(),
    artifactProtocol: new VerifiedHandoffArtifactProtocol({ clock, ids }),
    runtime,
    clock,
    ids,
    // No test may depend on a wall-clock tick: the reconciliation sweep is
    // driven explicitly where it is under test (P11-06).
    reconcileIntervalMs: 0,
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

export const seedRun = async (
  context: ReturnType<typeof harness>,
  policy: Partial<CoordinationRun["policy"]> = {},
): Promise<CoordinationRunId> => {
  const now = context.clock.nowIso();
  const run: CoordinationRun = {
    id: context.ids.runId(),
    name: CREATE_RUN_REQUEST.name,
    objective: CREATE_RUN_REQUEST.objective,
    requiredSections: CREATE_RUN_REQUEST.requiredSections.map((section) => ({ ...section })),
    participants: [
      { role: "planner", agentId: PLANNER_AGENT.id, agentNameSnapshot: PLANNER_AGENT.name },
      { role: "critic", agentId: CRITIC_AGENT.id, agentNameSnapshot: CRITIC_AGENT.name },
      {
        role: "finalizer",
        agentId: FINALIZER_AGENT.id,
        agentNameSnapshot: FINALIZER_AGENT.name,
      },
    ],
    policy: { ...DEFAULT_COORDINATION_POLICY, ...policy },
    status: "created",
    phase: "drafting",
    revision: 0,
    nextTurnSequence: 1,
    activeTurnIds: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await context.repository.createRun({ run });
  await context.service.startRun(run.id);
  return run.id;
};

export const startRun = async (
  steps: ScriptedRuntimeStep[],
  overrides: Parameters<typeof harness>[1] = {},
) => {
  const context = harness(steps, overrides);
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
    expect(details.run.activeTurnIds).toEqual([]);

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
        activeTurnIds: [],
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

/** Yields to the microtask queue so the background loop can advance. */
export const flush = async (ticks = 200): Promise<void> => {
  for (let tick = 0; tick < ticks; tick += 1) {
    await Promise.resolve();
  }
};

const taskSection = (prompt: string): string =>
  prompt.slice(prompt.indexOf("[YOUR TASK]"), prompt.indexOf("[OUTPUT CONTRACT]"));

const badKeyProposal = (count: number): string =>
  JSON.stringify({
    schemaVersion: 1,
    type: "proposal",
    summary: "Summary",
    sections: Array.from({ length: count }, (_, index) => ({
      key: `Bad Key ${index}`,
      title: `Title ${index}`,
      content: "Body.",
    })),
  });

describe("walking skeleton: bounded retry feedback", () => {
  it("replays validator feedback into the retry prompt and then commits", async () => {
    const { service, runtime, runId } = await startRun([
      succeeds(INVALID_ARTIFACT_OUTPUT),
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(APPROVING_REVIEW_OUTPUT),
      succeeds(VALID_FINAL_OUTPUT),
    ]);
    const details = await settle(service, runId);

    expect(details.run.status).toBe("completed");
    expect(taskSection(runtime.starts[0]!.prompt)).not.toContain("Your previous attempt");
    expect(taskSection(runtime.starts[1]!.prompt)).toContain("Your previous attempt");
    expect(runtime.starts[1]!.prompt).toContain("Too small: expected array to have >=1 items");

    const plannerTurn = details.turns.find((turn) => turn.sequence === 1);
    expect(plannerTurn?.status).toBe("committed");
    expect(plannerTurn?.attemptCount).toBe(2);
    expect(details.attempts.slice(0, 2).map((attempt) => attempt.status)).toEqual([
      "invalid_output",
      "succeeded",
    ]);
  });

  it("replaces stale validator feedback with the latest runtime failure", async () => {
    const context = harness([
      succeeds(INVALID_ARTIFACT_OUTPUT),
      timesOut("Attempt exceeded its time limit"),
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(APPROVING_REVIEW_OUTPUT),
      succeeds(VALID_FINAL_OUTPUT),
    ]);
    const runId = await seedRun(context, { maxAttemptsPerTurn: 3 });
    const details = await settle(context.service, runId);

    const second = taskSection(context.runtime.starts[1]!.prompt);
    const third = taskSection(context.runtime.starts[2]!.prompt);

    expect(second).toContain("Too small");
    expect(third).toContain("Attempt exceeded its time limit");
    expect(third).not.toContain("Too small");
    expect(details.run.status).toBe("completed");
    expect(details.attempts.slice(0, 3).map((attempt) => attempt.status)).toEqual([
      "invalid_output",
      "timed_out",
      "succeeded",
    ]);
  });

  it("carries the most specific safe error into a failed run", async () => {
    const { service, runId } = await startRun([
      succeeds(INVALID_ARTIFACT_OUTPUT),
      timesOut("Attempt exceeded its time limit"),
    ]);
    const details = await settle(service, runId);

    expect(details.run.status).toBe("failed");
    expect(details.run.errorCode).toBe("MAX_ATTEMPTS_EXCEEDED");
    expect(details.run.errorMessage).toContain("Attempt exceeded its time limit");
    expect(details.attempts.map((attempt) => attempt.status)).toEqual([
      "invalid_output",
      "timed_out",
    ]);
  });

  it("bounds how much feedback a retry prompt replays", async () => {
    const { service, runtime, runId } = await startRun([
      succeeds(badKeyProposal(14)),
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(APPROVING_REVIEW_OUTPUT),
      succeeds(VALID_FINAL_OUTPUT),
    ]);
    await settle(service, runId);

    const feedbackLines = taskSection(runtime.starts[1]!.prompt)
      .split("\n")
      .filter((line) => line.startsWith("  - "));

    expect(feedbackLines.length).toBeGreaterThan(0);
    expect(feedbackLines.length).toBeLessThanOrEqual(10);
  });

  it("fails the run after the attempt limit without committing anything", async () => {
    const { service, runtime, runId } = await startRun([
      succeeds(INVALID_ARTIFACT_OUTPUT),
      succeeds(INVALID_ARTIFACT_OUTPUT),
    ]);
    const details = await settle(service, runId);

    expect(details.run.status).toBe("failed");
    expect(details.run.errorCode).toBe("MAX_ATTEMPTS_EXCEEDED");
    expect(details.artifacts).toEqual([]);
    expect(runtime.starts).toHaveLength(2);
    expect(details.turns[0]?.status).toBe("failed");
  });
});

describe("walking skeleton: safe recovery and cleanup", () => {
  it("fails the run with the structured code when a component rejects the context", async () => {
    // The first call is createRun's context-cap probe; only the loop's real
    // turn prompts fail here.
    let calls = 0;
    const throwingBuilder: ContextBuilder = {
      build(input) {
        calls += 1;
        if (calls === 1) {
          return new RoleScopedContextBuilder().build(input);
        }
        throw new CoordinationError(400, "VALIDATION_FAILED", "Context could not be built");
      },
    };
    const { service, runId } = await startRun(HAPPY_PATH, {
      contextBuilder: throwingBuilder,
    });
    const details = await settle(service, runId);

    expect(details.run.status).toBe("failed");
    expect(details.run.errorCode).toBe("VALIDATION_FAILED");
    expect(details.run.errorMessage).toBe("Context could not be built");
  });

  it("fails safely and generically when a component throws an unexpected error", async () => {
    const throwingWorkflow: VerifiedHandoffWorkflow = {
      decideNext() {
        throw new Error("boom: /secret/path token=abc");
      },
    };
    const { service, runId } = await startRun(HAPPY_PATH, { workflow: throwingWorkflow });
    const details = await settle(service, runId);

    expect(details.run.status).toBe("failed");
    expect(details.run.errorCode).toBe("INTERNAL_ERROR");
    expect(details.run.errorMessage).not.toContain("secret");
    expect(details.run.errorMessage).not.toContain("token=abc");
  });

  it("releases the local loop once a run reaches a terminal state", async () => {
    const { service, runId } = await startRun(HAPPY_PATH);
    await settle(service, runId);

    await expect(service.startRun(runId)).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: "Coordination run is already active",
    });
  });

  it("refuses a second local loop while a run is still active", async () => {
    const { service, runId } = await startRun([deferred()]);

    await expect(service.startRun(runId)).rejects.toMatchObject({
      statusCode: 409,
      code: "INVALID_STATE",
      message: "Coordination run is already running",
    });
  });

  it("stops a deferred attempt and ignores its late success", async () => {
    const { service, runtime, runId } = await startRun([deferred()]);
    await runtime.waitForStarts(1);

    const stopped = await service.stopRun(runId);
    expect(stopped.status).toBe("stopped");
    expect(runtime.cancelledAttemptIds).toHaveLength(1);

    const [pending] = runtime.pendingAttemptIds();
    expect(pending).toBeDefined();
    runtime.resolveAttempt(pending!, {
      kind: "succeeded",
      rawOutput: VALID_PROPOSAL_OUTPUT,
    });
    await flush();

    const details = await service.getRun(runId);
    expect(details?.run.status).toBe("stopped");
    expect(details?.run.errorCode).toBe("STOPPED_BY_USER");
    expect(details?.artifacts).toEqual([]);
    expect(details?.attempts[0]?.status).toBe("cancelled");
  });

  it("treats stopping a terminal run as idempotent", async () => {
    const { service, runId } = await startRun(HAPPY_PATH);
    await settle(service, runId);

    const first = await service.stopRun(runId);
    const second = await service.stopRun(runId);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
  });

  it("reports a missing run rather than starting a loop for it", async () => {
    const { service } = harness([]);

    await expect(service.startRun("run-missing")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
    await expect(service.stopRun("run-missing")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
  });

  it("records a runtime execution failure and retries once", async () => {
    const { service, runtime, runId } = await startRun([
      failsExecution("Agent execution failed"),
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(APPROVING_REVIEW_OUTPUT),
      succeeds(VALID_FINAL_OUTPUT),
    ]);
    const details = await settle(service, runId);

    expect(details.run.status).toBe("completed");
    expect(runtime.starts.length).toBe(4);
    expect(details.attempts[0]?.status).toBe("failed");
    expect(details.attempts[0]?.errorCode).toBe("AGENT_EXECUTION_FAILED");
  });
});

describe("walking skeleton: rejection and revision", () => {
  it("routes a rejected proposal back to the Planner and completes after approval", async () => {
    const { service, runId } = await startRun([
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(REJECTING_REVIEW_OUTPUT),
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(APPROVING_REVIEW_OUTPUT),
      succeeds(VALID_FINAL_OUTPUT),
    ]);
    const details = await settle(service, runId);

    expect(details.run.status).toBe("completed");
    expect(details.run.revision).toBe(1);
    expect(details.turns.map((turn) => turn.kind)).toEqual([
      "initial_proposal",
      "proposal_review",
      "proposal_revision",
      "proposal_review",
      "finalization",
    ]);
    expect(details.turns.every((turn) => turn.status === "committed")).toBe(true);
  });

  it("treats a rejection as a committed review, not a failed attempt", async () => {
    const { service, runId } = await startRun([
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(REJECTING_REVIEW_OUTPUT),
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(APPROVING_REVIEW_OUTPUT),
      succeeds(VALID_FINAL_OUTPUT),
    ]);
    const details = await settle(service, runId);
    const rejection = details.turns[1];

    expect(rejection?.status).toBe("committed");
    expect(rejection?.attemptCount).toBe(1);
    expect(details.attempts.every((attempt) => attempt.status === "succeeded")).toBe(true);
    expect(details.turns.every((turn) => turn.attemptCount === 1)).toBe(true);
  });

  it("fails the run once the revision limit is reached", async () => {
    const { service, runId } = await startRun([
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(REJECTING_REVIEW_OUTPUT),
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(REJECTING_REVIEW_OUTPUT),
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(REJECTING_REVIEW_OUTPUT),
    ]);
    const details = await settle(service, runId);

    expect(details.run.status).toBe("failed");
    expect(details.run.errorCode).toBe("MAX_REVISIONS_EXCEEDED");
    expect(details.run.revision).toBe(2);
    expect(details.artifacts.filter((artifact) => artifact.type === "final")).toEqual([]);
  });

  it("fails the run once the turn limit is reached", async () => {
    const context = harness([
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(REJECTING_REVIEW_OUTPUT),
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(APPROVING_REVIEW_OUTPUT),
      succeeds(VALID_FINAL_OUTPUT),
    ]);
    const runId = await seedRun(context, { maxTurns: 3 });
    const details = await settle(context.service, runId);

    expect(details.run.status).toBe("failed");
    expect(details.run.errorCode).toBe("MAX_TURNS_EXCEEDED");
    expect(details.turns).toHaveLength(3);
  });
});

describe("walking skeleton: recovery matrix", () => {
  it("retries once after a timeout and then completes", async () => {
    const { service, runId } = await startRun([
      timesOut("Attempt exceeded its time limit"),
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(APPROVING_REVIEW_OUTPUT),
      succeeds(VALID_FINAL_OUTPUT),
    ]);
    const details = await settle(service, runId);

    expect(details.run.status).toBe("completed");
    expect(details.attempts[0]?.status).toBe("timed_out");
    expect(details.attempts[0]?.errorCode).toBe("ATTEMPT_TIMED_OUT");
    expect(details.attempts[1]?.status).toBe("succeeded");
    expect(details.turns[0]?.attemptCount).toBe(2);
  });

  it("fails the run after two runtime failures", async () => {
    const { service, runId } = await startRun([
      failsExecution("Agent execution failed"),
      failsExecution("Agent execution failed"),
    ]);
    const details = await settle(service, runId);

    expect(details.run.status).toBe("failed");
    expect(details.run.errorCode).toBe("MAX_ATTEMPTS_EXCEEDED");
    expect(details.run.errorMessage).toContain("Agent execution failed");
    expect(details.attempts.map((attempt) => attempt.status)).toEqual(["failed", "failed"]);
  });

  it("fails the run after two timeouts", async () => {
    const { service, runId } = await startRun([timesOut("slow"), timesOut("slow")]);
    const details = await settle(service, runId);

    expect(details.run.status).toBe("failed");
    expect(details.run.errorCode).toBe("MAX_ATTEMPTS_EXCEEDED");
    expect(details.attempts.map((attempt) => attempt.status)).toEqual([
      "timed_out",
      "timed_out",
    ]);
  });

  it("retries once when the runtime cannot start the Agent at all", async () => {
    const { service, runId } = await startRun([
      failsToStart("Agent runtime is unavailable"),
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(APPROVING_REVIEW_OUTPUT),
      succeeds(VALID_FINAL_OUTPUT),
    ]);
    const details = await settle(service, runId);

    expect(details.run.status).toBe("completed");
    expect(details.attempts[0]?.status).toBe("failed");
    expect(details.attempts[0]?.errorMessage).toBe("Agent runtime is unavailable");
    expect(details.attempts[0]?.agentRunId).toBeUndefined();
  });

  it("ignores a late success that arrives after the lease is gone", async () => {
    const { service, runtime, runId } = await startRun([deferred()]);
    await runtime.waitForStarts(1);
    await service.stopRun(runId);

    const before = await service.getRun(runId);
    expect(before?.run.status).toBe("stopped");

    runtime.resolveAttempt(runtime.pendingAttemptIds()[0]!, {
      kind: "succeeded",
      rawOutput: VALID_PROPOSAL_OUTPUT,
    });
    await flush();

    const after = await service.getRun(runId);
    expect(after?.run.status).toBe("stopped");
    expect(after?.artifacts).toEqual([]);
    expect(after?.turns[0]?.status).toBe("cancelled");
    expect(after?.run.version).toBe(before?.run.version);
  });

  it("stops cleanly when the Agent is cancelled mid-attempt", async () => {
    const { service, runId } = await startRun([cancelled("Attempt cancelled")]);
    const details = await settle(service, runId);

    expect(["failed", "stopped"]).toContain(details.run.status);
    expect(details.attempts[0]?.status).toBe("cancelled");
    expect(details.artifacts).toEqual([]);
  });
});

describe("walking skeleton: Phase 1 matrix coverage", () => {
  const SCENARIOS = [
    { name: "normal approval", steps: HAPPY_PATH, status: "completed" },
    {
      name: "reject, revise, approve",
      steps: [
        succeeds(VALID_PROPOSAL_OUTPUT),
        succeeds(REJECTING_REVIEW_OUTPUT),
        succeeds(VALID_PROPOSAL_OUTPUT),
        succeeds(APPROVING_REVIEW_OUTPUT),
        succeeds(VALID_FINAL_OUTPUT),
      ],
      status: "completed",
    },
    {
      name: "invalid then success",
      steps: [
        succeeds(INVALID_ARTIFACT_OUTPUT),
        succeeds(VALID_PROPOSAL_OUTPUT),
        succeeds(APPROVING_REVIEW_OUTPUT),
        succeeds(VALID_FINAL_OUTPUT),
      ],
      status: "completed",
    },
    {
      name: "invalid twice",
      steps: [succeeds(INVALID_ARTIFACT_OUTPUT), succeeds(INVALID_ARTIFACT_OUTPUT)],
      status: "failed",
    },
    {
      name: "timeout then success",
      steps: [
        timesOut("slow"),
        succeeds(VALID_PROPOSAL_OUTPUT),
        succeeds(APPROVING_REVIEW_OUTPUT),
        succeeds(VALID_FINAL_OUTPUT),
      ],
      status: "completed",
    },
    {
      name: "runtime failure twice",
      steps: [failsExecution("down"), failsExecution("down")],
      status: "failed",
    },
  ] as const;

  for (const scenario of SCENARIOS) {
    it(`${scenario.name} settles as ${scenario.status}`, async () => {
      const { service, runId } = await startRun([...scenario.steps]);
      const details = await settle(service, runId);

      expect(details.run.status).toBe(scenario.status);
      expect(details.run.activeTurnIds).toEqual([]);
      expect(details.turns.every((turn) => turn.activeAttemptId === undefined)).toBe(true);
      if (scenario.status === "completed") {
        expect(details.run.finalArtifactId).toBeDefined();
      } else {
        expect(details.run.finalArtifactId).toBeUndefined();
        expect(details.run.errorCode).toBeDefined();
      }
    });
  }

  it("never commits more than one artifact per logical turn", async () => {
    const { service, runId } = await startRun([
      succeeds(INVALID_ARTIFACT_OUTPUT),
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(REJECTING_REVIEW_OUTPUT),
      succeeds(VALID_PROPOSAL_OUTPUT),
      succeeds(APPROVING_REVIEW_OUTPUT),
      succeeds(VALID_FINAL_OUTPUT),
    ]);
    const details = await settle(service, runId);

    const committedTurnIds = details.artifacts.map((artifact) => artifact.turnId);
    expect(new Set(committedTurnIds).size).toBe(committedTurnIds.length);
    expect(details.artifacts).toHaveLength(
      details.turns.filter((turn) => turn.status === "committed").length,
    );
  });
});
