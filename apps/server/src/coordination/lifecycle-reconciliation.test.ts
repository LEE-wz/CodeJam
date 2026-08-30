import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import type { Agent } from "../types.js";
import { VerifiedHandoffArtifactProtocol } from "./artifact-protocol.js";
import { RoleScopedContextBuilder } from "./context-builder.js";
import type {
  BeginAttemptInput,
  BeginAttemptResult,
  CommitAcceptedArtifactInput,
  CommitAcceptedArtifactResult,
  CoordinationRepository,
  CreateRunRecordInput,
  FinishAttemptInput,
  CoordinationRuntime,
  NonTerminalRunSummary,
  ReconcileRunResult,
  RuntimeExecutionInput,
  RuntimeOutcome,
  RuntimeStartResult,
  ScheduleTurnInput,
  ScheduleTurnResult,
  StartRunCommitResult,
} from "./contracts.js";
import { DurableCoordinationRepository } from "./repository.js";
import { CoordinationService } from "./service.js";
import { AdvancingClock, DeterministicIdGenerator } from "./testing/controls.js";
import {
  FakeAgentDirectory,
  ScriptedCoordinationRuntime,
  deferred,
  failsExecution,
  failsToStart,
  type ScriptedRuntimeStep,
} from "./testing/fakes.js";
import {
  APPROVING_REVIEW_OUTPUT,
  CREATE_RUN_REQUEST,
  CRITIC_AGENT,
  FINALIZER_AGENT,
  PLANNER_AGENT,
  VALID_FINAL_OUTPUT,
  VALID_PROPOSAL_OUTPUT,
} from "./testing/fixtures.js";
import { VerifiedHandoffWorkflowV1 } from "./workflow.js";
import type {
  AgentId,
  CoordinationRunDetails,
  CoordinationRunId,
} from "./types.js";

/**
 * Phase 11 lifecycle tests.
 *
 * These run against the **durable** repository over a temporary JsonStore, not
 * the in-memory stand-in, because the properties under test are durable ones:
 * derived Agent reservations, the event ledger, and what a restart settles.
 * Timing is never used — every race is driven by a deferred completion or by an
 * injected repository result, and the loop is advanced by yielding to the
 * microtask queue.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 }),
      ),
  );
});

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

/** Every stale path the P11-01 classification names, as an injectable fault. */
type StalePath =
  | "scheduleTurn.not_found"
  | "beginAttempt.stale"
  | "attachAgentRun.stale"
  | "commitAcceptedArtifact.stale"
  | "finishAttempt.stale";

/**
 * Delegating repository that can inject exactly one stale result.
 *
 * The point is to reproduce a lost race deterministically: the durable state is
 * left exactly as the real race would leave it (turn and attempt still
 * `running`, run still `running`), and only the answer the service sees is
 * changed. Nothing here weakens the repository under test — reconciliation,
 * reservations, and events all run for real.
 */
class FaultInjectingRepository implements CoordinationRepository {
  private readonly pending = new Set<StalePath>();

  constructor(private readonly inner: DurableCoordinationRepository) {}

  private beforeBeginAttemptHooks: Array<() => Promise<void>> = [];

  injectOnce(path: StalePath): void {
    this.pending.add(path);
  }

  /**
   * Runs once, immediately before the next `beginAttempt` reaches the durable
   * repository. It is how a test supersedes a turn in the window between the
   * service's reload and its attempt, without faking the repository's answer.
   */
  beforeBeginAttempt(hook: () => Promise<void>): void {
    this.beforeBeginAttemptHooks.push(hook);
  }

  private take(path: StalePath): boolean {
    return this.pending.delete(path);
  }

  listRuns(limit?: number) {
    return this.inner.listRuns(limit);
  }
  getRunDetails(id: CoordinationRunId) {
    return this.inner.getRunDetails(id);
  }
  createRun(input: CreateRunRecordInput) {
    return this.inner.createRun(input);
  }
  startRun(id: CoordinationRunId): Promise<StartRunCommitResult> {
    return this.inner.startRun(id);
  }

  async scheduleTurn(input: ScheduleTurnInput): Promise<ScheduleTurnResult> {
    if (this.take("scheduleTurn.not_found")) {
      return { kind: "not_found" };
    }
    return this.inner.scheduleTurn(input);
  }

  async beginAttempt(input: BeginAttemptInput): Promise<BeginAttemptResult> {
    const hook = this.beforeBeginAttemptHooks.shift();
    if (hook) await hook();
    if (this.take("beginAttempt.stale")) {
      return { kind: "stale" };
    }
    return this.inner.beginAttempt(input);
  }

  async attachAgentRun(input: {
    attemptId: string;
    leaseToken: string;
    agentRunId: string;
  }): Promise<"attached" | "stale"> {
    if (this.take("attachAgentRun.stale")) {
      return "stale";
    }
    return this.inner.attachAgentRun(input);
  }

  async commitAcceptedArtifact(
    input: CommitAcceptedArtifactInput,
  ): Promise<CommitAcceptedArtifactResult> {
    if (this.take("commitAcceptedArtifact.stale")) {
      return { kind: "stale" };
    }
    return this.inner.commitAcceptedArtifact(input);
  }

  async finishAttempt(input: FinishAttemptInput): Promise<"finished" | "stale"> {
    if (this.take("finishAttempt.stale")) {
      return "stale";
    }
    return this.inner.finishAttempt(input);
  }

  requestStop(id: CoordinationRunId) {
    return this.inner.requestStop(id);
  }
  finishStopped(id: CoordinationRunId) {
    return this.inner.finishStopped(id);
  }
  completeRun(input: { runId: CoordinationRunId; finalArtifactId: string }) {
    return this.inner.completeRun(input);
  }
  failRun(input: {
    runId: CoordinationRunId;
    code: NonNullable<CoordinationRunDetails["run"]["errorCode"]>;
    message: string;
  }) {
    return this.inner.failRun(input);
  }
  interruptActiveRuns() {
    return this.inner.interruptActiveRuns();
  }
  listNonTerminalRuns(): Promise<NonTerminalRunSummary[]> {
    return this.inner.listNonTerminalRuns();
  }
  reconcileRun(input: { runId: CoordinationRunId; reason: string }): Promise<ReconcileRunResult> {
    return this.inner.reconcileRun(input);
  }
}

/** The artifact each role is expected to produce, keyed by acting Agent. */
const OUTPUT_BY_AGENT: Record<string, string> = {
  [PLANNER_AGENT.id]: VALID_PROPOSAL_OUTPUT,
  [CRITIC_AGENT.id]: APPROVING_REVIEW_OUTPUT,
  [FINALIZER_AGENT.id]: VALID_FINAL_OUTPUT,
};

/**
 * A runtime that answers by role rather than from a flat queue.
 *
 * Reconciliation re-schedules the turn it lost, so a positional script would
 * hand the retried turn the *next* role's artifact and fail validation for a
 * reason that has nothing to do with the path under test. Answering by acting
 * Agent keeps every retry valid, which is what lets these tests assert that a
 * reconciled run actually reaches `completed`.
 *
 * `prefix` steps are consumed first, so a test can still script a deferred
 * completion or a failure before the role-aware behaviour takes over.
 */
class RoleAwareRuntime implements CoordinationRuntime {
  readonly starts: RuntimeExecutionInput[] = [];
  readonly cancelledAttemptIds: string[] = [];

  private readonly prefix: ScriptedRuntimeStep[];
  private readonly pendingCompletions = new Map<string, (outcome: RuntimeOutcome) => void>();
  private readonly startWaiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(prefix: ScriptedRuntimeStep[] = []) {
    this.prefix = [...prefix];
  }

  async start(input: RuntimeExecutionInput): Promise<RuntimeStartResult> {
    this.starts.push({ ...input });
    this.releaseStartWaiters();

    const agentRunId = `agent-run-${String(this.starts.length).padStart(4, "0")}`;
    const step = this.prefix.shift();
    if (step?.kind === "start_failed") {
      return { kind: "failed", message: step.message };
    }
    if (step?.kind === "deferred") {
      return {
        kind: "started",
        handle: {
          agentRunId,
          completion: new Promise<RuntimeOutcome>((resolve) => {
            this.pendingCompletions.set(input.attemptId, resolve);
          }),
        },
      };
    }
    if (step?.kind === "outcome") {
      return { kind: "started", handle: { agentRunId, completion: Promise.resolve(step.outcome) } };
    }

    const rawOutput = OUTPUT_BY_AGENT[input.agentId];
    if (rawOutput === undefined) {
      return { kind: "failed", message: "No output is defined for this Agent" };
    }
    return {
      kind: "started",
      handle: { agentRunId, completion: Promise.resolve({ kind: "succeeded", rawOutput }) },
    };
  }

  async cancelAttempt(attemptId: string): Promise<boolean> {
    this.cancelledAttemptIds.push(attemptId);
    return this.pendingCompletions.has(attemptId);
  }

  resolveAttempt(attemptId: string, outcome: RuntimeOutcome): void {
    const resolve = this.pendingCompletions.get(attemptId);
    if (!resolve) throw new Error(`No deferred attempt is pending for ${attemptId}`);
    this.pendingCompletions.delete(attemptId);
    resolve(outcome);
  }

  pendingAttemptIds(): string[] {
    return [...this.pendingCompletions.keys()];
  }

  waitForStarts(count: number): Promise<void> {
    if (this.starts.length >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.startWaiters.push({ count, resolve });
    });
  }

  private releaseStartWaiters(): void {
    for (let index = this.startWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.startWaiters[index];
      if (waiter && this.starts.length >= waiter.count) {
        this.startWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }
}

const createHarness = async (prefix: ScriptedRuntimeStep[] = []) => {
  const root = await mkdtemp(path.join(tmpdir(), "relay-lifecycle-test-"));
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

  const clock = new AdvancingClock();
  const ids = new DeterministicIdGenerator();
  const durable = new DurableCoordinationRepository({ store, clock, ids });
  const repository = new FaultInjectingRepository(durable);
  const runtime = new RoleAwareRuntime(prefix);
  const service = new CoordinationService({
    agentDirectory: new FakeAgentDirectory(),
    repository,
    workflow: new VerifiedHandoffWorkflowV1(),
    contextBuilder: new RoleScopedContextBuilder(),
    artifactProtocol: new VerifiedHandoffArtifactProtocol({ clock, ids }),
    runtime,
    clock,
    ids,
    // The sweep is driven explicitly, never by a wall-clock tick.
    reconcileIntervalMs: 0,
  });
  return { store, durable, repository, runtime, service, clock, ids };
};

const TERMINAL = new Set(["completed", "failed", "stopped"]);

/**
 * Yields one turn of the event loop.
 *
 * The durable repository awaits real file I/O, which resolves on the macrotask
 * queue, so draining microtasks alone would spin forever. This is still not a
 * sleep: it waits for the queue to drain, never for a duration.
 */
const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

const settle = async (
  service: CoordinationService,
  runId: CoordinationRunId,
  ticks = 2_000,
): Promise<CoordinationRunDetails> => {
  for (let index = 0; index < ticks; index += 1) {
    const details = await service.getRun(runId);
    if (details && TERMINAL.has(details.run.status)) {
      return details;
    }
    await tick();
  }
  throw new Error("coordination run did not reach a terminal state");
};

/** Yields until `predicate` holds, so a test never races the background loop. */
const until = async (predicate: () => Promise<boolean>, ticks = 2_000): Promise<void> => {
  for (let index = 0; index < ticks; index += 1) {
    if (await predicate()) return;
    await tick();
  }
  throw new Error("condition was not reached");
};

const startRun = async (prefix: ScriptedRuntimeStep[] = []) => {
  const context = await createHarness(prefix);
  const run = await context.service.createRun(CREATE_RUN_REQUEST);
  await context.service.startRun(run.id);
  return { ...context, runId: run.id };
};

/**
 * The Phase 11 invariant, checked against durable state: no Agent is reserved
 * unless some non-terminal run has a running attempt for it.
 */
const assertReservationInvariant = async (
  durable: DurableCoordinationRepository,
  store: JsonStore,
): Promise<void> => {
  const database = store.snapshot();
  const nonTerminalRunIds = new Set(
    database.coordinationRuns
      .filter((run) => run.status === "running" || run.status === "stop_requested")
      .map((run) => run.id),
  );
  const expected = new Set<AgentId>(
    database.coordinationAttempts
      .filter(
        (attempt) => attempt.status === "running" && nonTerminalRunIds.has(attempt.runId),
      )
      .map((attempt) => attempt.agentId),
  );
  expect(new Set(await durable.listReservedAgentIds())).toEqual(expected);
};

// --------------------------------------------------------------- P11-09

describe("P11-09 stale-path regressions", () => {
  /**
   * Each case fails on the pre-fix implementation, where every one of these
   * exits was a bare `return false`: the loop returned, and the run stayed
   * `running` with its turn active and its participants reserved forever. The
   * assertion that discriminates old from new is `status === "completed"`.
   */

  it("resumes when the turn is superseded between the reload and the attempt", async () => {
    const context = await startRun();
    // No injected answer here: the turn is genuinely superseded in durable state
    // after the service reloaded it and before `beginAttempt` runs, so the
    // repository refuses the attempt on its own terms.
    context.repository.beforeBeginAttempt(async () => {
      await context.store.mutate((database) => {
        const turn = database.coordinationTurns.find(
          (candidate) => candidate.status === "scheduled",
        );
        if (turn) turn.status = "cancelled";
      });
    });
    const details = await settle(context.service, context.runId);

    expect(details.run.status).toBe("completed");
    expect(details.run.activeTurnId).toBeUndefined();
    await assertReservationInvariant(context.durable, context.store);
    expect(await context.durable.listReservedAgentIds()).toEqual([]);
  });

  it("resumes after beginAttempt returns stale", async () => {
    const context = await startRun();
    // Nothing has begun yet on the very first tick, so injecting here lands on
    // the first attempt of the first turn.
    context.repository.injectOnce("beginAttempt.stale");
    const details = await settle(context.service, context.runId);

    expect(details.run.status).toBe("completed");
    expect(details.run.activeTurnId).toBeUndefined();
    // A reconciled turn is settled, not left running.
    expect(
      details.turns.every((turn) => turn.status !== "running" && turn.status !== "scheduled"),
    ).toBe(true);
    await assertReservationInvariant(context.durable, context.store);
    expect(await context.durable.listReservedAgentIds()).toEqual([]);
  });

  it("resumes after an attachAgentRun race", async () => {
    const context = await startRun();
    context.repository.injectOnce("attachAgentRun.stale");
    const details = await settle(context.service, context.runId);

    expect(details.run.status).toBe("completed");
    expect(details.run.activeTurnId).toBeUndefined();
    await assertReservationInvariant(context.durable, context.store);
    expect(await context.durable.listReservedAgentIds()).toEqual([]);
  });

  it("resumes after a commit that loses its lease, and records the reconciliation", async () => {
    const context = await startRun();
    context.repository.injectOnce("commitAcceptedArtifact.stale");
    const details = await settle(context.service, context.runId);

    expect(details.run.status).toBe("completed");
    expect(details.events.some((event) => event.type === "run.reconciled")).toBe(true);
    // The reconciliation event names no lease, prompt, or raw output.
    const reconciled = details.events.filter((event) => event.type === "run.reconciled");
    for (const event of reconciled) {
      expect(event.details).toMatchObject({ code: "RUN_ABANDONED" });
      expect(JSON.stringify(event)).not.toContain("lease-");
    }
    await assertReservationInvariant(context.durable, context.store);
    expect(await context.durable.listReservedAgentIds()).toEqual([]);
  });

  it("resumes after finishAttempt returns stale", async () => {
    // A runtime failure drives the service into `finishAttempt`, which is then
    // refused as stale: the attempt is left running with no owner.
    const context = await startRun([failsToStart()]);
    context.repository.injectOnce("finishAttempt.stale");
    const details = await settle(context.service, context.runId);

    expect(TERMINAL.has(details.run.status)).toBe(true);
    expect(details.run.activeTurnId).toBeUndefined();
    await assertReservationInvariant(context.durable, context.store);
    expect(await context.durable.listReservedAgentIds()).toEqual([]);
  });

  it("leaves no reservation when scheduleTurn cannot find the run, and the sweep resumes it", async () => {
    const context = await startRun();
    context.repository.injectOnce("scheduleTurn.not_found");

    // The loop exits without scheduling anything. Pre-fix this was terminal for
    // the run: it stayed `running` with nothing driving it and no way back.
    await until(async () => {
      const current = await context.service.getRun(context.runId);
      return current?.run.status === "running" && current.run.activeTurnId === undefined;
    });

    const stranded = await context.service.getRun(context.runId);
    expect(stranded?.run.status).toBe("running");
    expect(stranded?.run.activeTurnId).toBeUndefined();
    // No attempt ever began, so nothing is reserved even while stranded.
    expect(await context.durable.listReservedAgentIds()).toEqual([]);

    // The sweep is what gives an unowned run an owner again. It is a no-op
    // while the loop is still alive, so retry until it claims the run: that
    // transition *is* the behaviour under test.
    await until(async () =>
      (await context.service.reconcileUnownedRuns()).includes(context.runId),
    );

    const details = await settle(context.service, context.runId);
    expect(details.run.status).toBe("completed");
    await assertReservationInvariant(context.durable, context.store);
  });
});

// --------------------------------------------------------------- P11-10

describe("P11-10 lifecycle invariants", () => {
  it("holds the reservation invariant across a stop during a running attempt", async () => {
    const context = await startRun([deferred()]);
    await context.runtime.waitForStarts(1);

    // Mid-attempt the acting Agent — and only it — is reserved.
    expect(await context.durable.listReservedAgentIds()).toEqual([PLANNER_AGENT.id]);
    await assertReservationInvariant(context.durable, context.store);

    await context.service.stopRun(context.runId);

    const details = await context.service.getRun(context.runId);
    expect(details?.run.status).toBe("stopped");
    expect(await context.durable.listReservedAgentIds()).toEqual([]);
    await assertReservationInvariant(context.durable, context.store);

    // A late result from the cancelled attempt must change nothing.
    const pending = context.runtime.pendingAttemptIds()[0];
    if (pending) {
      context.runtime.resolveAttempt(pending, {
        kind: "succeeded",
        rawOutput: VALID_PROPOSAL_OUTPUT,
      });
    }
    await Promise.resolve();
    const after = await context.service.getRun(context.runId);
    expect(after?.run.status).toBe("stopped");
    await assertReservationInvariant(context.durable, context.store);
  });

  it("holds the reservation invariant when an attempt fails outright", async () => {
    const context = await startRun([failsExecution(), failsExecution()]);
    const details = await settle(context.service, context.runId);

    expect(details.run.status).toBe("failed");
    expect(details.run.errorCode).toBe("MAX_ATTEMPTS_EXCEEDED");
    expect(await context.durable.listReservedAgentIds()).toEqual([]);
    await assertReservationInvariant(context.durable, context.store);
  });

  it("settles a crashed run on initialize and frees its Agents, and a second initialize changes nothing", async () => {
    const context = await startRun([deferred()]);
    await context.runtime.waitForStarts(1);
    expect(await context.durable.listReservedAgentIds()).toEqual([PLANNER_AGENT.id]);

    // A restart is a fresh service over the same durable state: the old loop is
    // gone, and nothing in memory survives.
    const restarted = new CoordinationService({
      agentDirectory: new FakeAgentDirectory(),
      repository: context.durable,
      workflow: new VerifiedHandoffWorkflowV1(),
      contextBuilder: new RoleScopedContextBuilder(),
      artifactProtocol: new VerifiedHandoffArtifactProtocol({
        clock: context.clock,
        ids: context.ids,
      }),
      runtime: new ScriptedCoordinationRuntime([]),
      clock: context.clock,
      ids: context.ids,
      reconcileIntervalMs: 0,
    });
    await restarted.initialize();

    const settled = await restarted.getRun(context.runId);
    expect(settled?.run.status).toBe("failed");
    expect(settled?.run.errorCode).toBe("SERVER_RESTARTED");
    expect(settled?.run.activeTurnId).toBeUndefined();
    expect(await context.durable.listReservedAgentIds()).toEqual([]);
    await assertReservationInvariant(context.durable, context.store);

    const before = JSON.stringify(await restarted.getRun(context.runId));
    await restarted.initialize();
    expect(JSON.stringify(await restarted.getRun(context.runId))).toBe(before);
    await restarted.shutdown();
  });

  it("refuses to enrol one Agent in two live runs while reserving only the acting one", async () => {
    const context = await startRun([deferred()]);
    await context.runtime.waitForStarts(1);

    // The second run shares every participant, so admission refuses it even
    // though only the Planner currently holds a running attempt.
    const second = await context.service.createRun({
      ...CREATE_RUN_REQUEST,
      name: "Contending run",
    });
    await expect(context.service.startRun(second.id)).rejects.toMatchObject({
      code: "AGENT_RESERVED",
    });

    expect(await context.durable.listReservedAgentIds()).toEqual([PLANNER_AGENT.id]);
    await assertReservationInvariant(context.durable, context.store);

    await context.service.stopRun(context.runId);
    expect(await context.durable.listReservedAgentIds()).toEqual([]);
    await assertReservationInvariant(context.durable, context.store);
  });

  it("is a no-op sweep while a live loop owns the run", async () => {
    const context = await startRun([deferred()]);
    await context.runtime.waitForStarts(1);

    const before = JSON.stringify(await context.service.getRun(context.runId));
    expect(await context.service.reconcileUnownedRuns()).toEqual([]);
    expect(JSON.stringify(await context.service.getRun(context.runId))).toBe(before);

    await context.service.stopRun(context.runId);
  });
});
