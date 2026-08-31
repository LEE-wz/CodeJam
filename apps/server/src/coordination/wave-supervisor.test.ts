import { describe, expect, it } from "vitest";
import {
  CoordinationArtifactProtocolDispatchV1,
  SharedSessionArtifactProtocol,
  VerifiedHandoffArtifactProtocol,
} from "./artifact-protocol.js";
import type {
  CoordinationRuntime,
  RuntimeExecutionInput,
  RuntimeOutcome,
  RuntimeStartResult,
} from "./contracts.js";
import { RoleScopedContextBuilder } from "./context-builder.js";
import { CoordinationService, runBoundedWave } from "./service.js";
import { SharedSessionWorkflowV1 } from "./session-workflow.js";
import { VerifiedHandoffWorkflowV1 } from "./workflow.js";
import type {
  CoordinationRunDetails,
  CreateSessionRunRequest,
  SessionMessagePayload,
} from "./types.js";
import { SESSION_LIMITS } from "./types.js";
import { AdvancingClock, DeterministicIdGenerator } from "./testing/controls.js";
import { FakeAgentDirectory } from "./testing/fakes.js";
import { InMemoryCoordinationRepository } from "./testing/memory-repository.js";
import { freeChatPayload, sessionParticipantRoster } from "./testing/session-fixtures.js";

/* ------------------------------------------------------------------ *
 * A runtime double built for waves.
 *
 * The scripted runtime in `testing/fakes.ts` pops one shared FIFO queue, which
 * cannot express "participant three fails while participant four succeeds".
 * This double is keyed by Agent and, more importantly, measures how many
 * attempts are genuinely in flight at once, so the concurrency cap is asserted
 * against observed behaviour rather than against the constant that produced it.
 * ------------------------------------------------------------------ */

type WaveBehaviour =
  | { kind: "ok"; output: string }
  | { kind: "fail"; message: string }
  | { kind: "timeout" }
  | { kind: "busy" }
  | { kind: "hold" };

const ok = (content: string): WaveBehaviour => ({
  kind: "ok",
  output: JSON.stringify(freeChatPayload(content)),
});
const fails = (message = "Agent execution failed"): WaveBehaviour => ({ kind: "fail", message });
const busy = (): WaveBehaviour => ({ kind: "busy" });
const holds = (): WaveBehaviour => ({ kind: "hold" });

class WaveRuntime implements CoordinationRuntime {
  readonly starts: RuntimeExecutionInput[] = [];
  readonly cancelledAttemptIds: string[] = [];
  peakConcurrency = 0;
  inFlight = 0;

  private nextAgentRun = 1;
  private readonly held = new Map<string, (outcome: RuntimeOutcome) => void>();
  private readonly heldByAgent = new Map<string, string[]>();

  constructor(
    private readonly script: Map<string, WaveBehaviour[]>,
    private readonly fallback: WaveBehaviour = ok("fallback contribution"),
  ) {}

  async start(input: RuntimeExecutionInput): Promise<RuntimeStartResult> {
    this.starts.push({ ...input });
    const behaviour = this.script.get(input.agentId)?.shift() ?? this.fallback;

    if (behaviour.kind === "busy") {
      // Mirrors the AgentService refusal the real gateway maps to `busy`.
      return { kind: "failed", message: "This Agent is already running", busy: true };
    }

    this.inFlight += 1;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.inFlight);
    const agentRunId = `agent-run-${String(this.nextAgentRun).padStart(4, "0")}`;
    this.nextAgentRun += 1;

    const release = (outcome: RuntimeOutcome): RuntimeOutcome => {
      this.inFlight -= 1;
      return outcome;
    };

    if (behaviour.kind === "hold") {
      const completion = new Promise<RuntimeOutcome>((resolve) => {
        this.held.set(input.attemptId, (outcome) => resolve(release(outcome)));
      });
      const queue = this.heldByAgent.get(input.agentId) ?? [];
      queue.push(input.attemptId);
      this.heldByAgent.set(input.agentId, queue);
      return { kind: "started", handle: { agentRunId, completion } };
    }

    const outcome: RuntimeOutcome =
      behaviour.kind === "ok"
        ? { kind: "succeeded", rawOutput: behaviour.output }
        : behaviour.kind === "timeout"
          ? { kind: "timed_out", message: "Agent execution timed out" }
          : { kind: "failed", message: behaviour.message };
    return {
      kind: "started",
      handle: { agentRunId, completion: Promise.resolve(release(outcome)) },
    };
  }

  async cancelAttempt(attemptId: string): Promise<boolean> {
    this.cancelledAttemptIds.push(attemptId);
    return this.held.has(attemptId);
  }

  /** Release every attempt currently held, with one outcome each. */
  releaseAll(outcomeFor: (agentId: string) => RuntimeOutcome): void {
    for (const [agentId, attemptIds] of this.heldByAgent) {
      for (const attemptId of attemptIds.splice(0)) {
        const resolve = this.held.get(attemptId);
        if (!resolve) continue;
        this.held.delete(attemptId);
        resolve(outcomeFor(agentId));
      }
    }
  }

  heldCount(): number {
    return this.held.size;
  }
}

/* ------------------------------------------------------------------ *
 * Harness.
 * ------------------------------------------------------------------ */

const waveHarness = (participantCount: number, runtime: WaveRuntime) => {
  const clock = new AdvancingClock();
  const ids = new DeterministicIdGenerator();
  const repository = new InMemoryCoordinationRepository(clock);
  const roster = sessionParticipantRoster(participantCount);
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
    reconcileIntervalMs: 0,
  });
  return { service, repository, roster, runtime };
};

const waveRequest = (
  roster: ReturnType<typeof sessionParticipantRoster>,
  policy: Partial<NonNullable<CreateSessionRunRequest["policy"]>> = {},
): CreateSessionRunRequest => ({
  workflow: "shared_session_v1",
  name: "Wave session",
  objective: "Answer the prompt from every angle at once.",
  agents: roster.map((agent) => agent.id),
  policy: {
    sessionProtocol: "free_chat",
    sessionWaveMode: "parallel",
    maxTurns: 500,
    ...policy,
  },
});

const flush = async (ticks = 400): Promise<void> => {
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
};

const settledStatuses = new Set(["awaiting_input", "completed", "failed", "stopped"]);

const settle = async (
  service: CoordinationService,
  runId: string,
  ticks = 6_000,
): Promise<CoordinationRunDetails> => {
  for (let tick = 0; tick < ticks; tick += 1) {
    const details = await service.getRun(runId);
    if (details && settledStatuses.has(details.run.status)) return details;
    await Promise.resolve();
  }
  throw new Error("wave run did not settle");
};

const startWave = async (
  participantCount: number,
  runtime: WaveRuntime,
  policy: Partial<NonNullable<CreateSessionRunRequest["policy"]>> = {},
) => {
  const context = waveHarness(participantCount, runtime);
  const run = await context.service.createRun(waveRequest(context.roster, policy));
  await context.service.resumeRun(run.id, { content: "What should we ship first?" });
  return { ...context, runId: run.id };
};

const scriptFor = (
  roster: ReturnType<typeof sessionParticipantRoster>,
  behaviour: (agentId: string, index: number) => WaveBehaviour[],
): Map<string, WaveBehaviour[]> =>
  new Map(roster.map((agent, index) => [agent.id, behaviour(agent.id, index)]));

/* ================================================================== *
 * PA13-10 — the bounded runner itself.
 * ================================================================== */

describe("runBoundedWave", () => {
  it("never exceeds the cap and still settles every task", async () => {
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 10 }, (_unused, index) => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Several await points, so a task cannot look concurrent by accident.
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
      inFlight -= 1;
      return index;
    });

    const results = await runBoundedWave(3, tasks);

    expect(peak).toBe(3);
    expect(inFlight).toBe(0);
    expect(results).toHaveLength(10);
    expect(results.map((result) => (result.status === "fulfilled" ? result.value : -1))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("settles siblings even when one task rejects", async () => {
    const results = await runBoundedWave(2, [
      async () => "first",
      async () => {
        throw new Error("member exploded");
      },
      async () => "third",
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    expect(results[2]).toMatchObject({ status: "fulfilled", value: "third" });
  });

  it("runs a single worker when the cap is below one", async () => {
    let peak = 0;
    let inFlight = 0;
    const tasks = Array.from({ length: 3 }, () => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });

    await runBoundedWave(0, tasks);

    expect(peak).toBe(1);
  });
});

/* ================================================================== *
 * PA13-10 / PA13-16 — concurrency is bounded by a semaphore, not by timing.
 * ================================================================== */

describe("wave concurrency cap", () => {
  it("opens only the default min(participants, 4) attempts at once", async () => {
    const roster = sessionParticipantRoster(10);
    const runtime = new WaveRuntime(scriptFor(roster, () => [holds()]));
    const context = await startWave(10, runtime);

    await flush();

    expect(runtime.inFlight).toBe(SESSION_LIMITS.defaultParallelTurns);
    expect(runtime.peakConcurrency).toBe(SESSION_LIMITS.defaultParallelTurns);
    expect(runtime.starts).toHaveLength(SESSION_LIMITS.defaultParallelTurns);

    runtime.releaseAll((agentId) => ({
      kind: "succeeded",
      rawOutput: JSON.stringify(freeChatPayload(`held by ${agentId}`)),
    }));
    await flush();
    // Releasing one batch lets the next batch in, and never more than the cap.
    expect(runtime.inFlight).toBeLessThanOrEqual(SESSION_LIMITS.defaultParallelTurns);
    expect(runtime.peakConcurrency).toBe(SESSION_LIMITS.defaultParallelTurns);

    for (let round = 0; round < 4; round += 1) {
      runtime.releaseAll((agentId) => ({
        kind: "succeeded",
        rawOutput: JSON.stringify(freeChatPayload(`held by ${agentId}`)),
      }));
      await flush();
    }

    const details = await settle(context.service, context.runId);
    expect(details.run.status).toBe("awaiting_input");
    expect(runtime.peakConcurrency).toBe(SESSION_LIMITS.defaultParallelTurns);
  });

  it("honours an explicit lower cap", async () => {
    const roster = sessionParticipantRoster(6);
    const runtime = new WaveRuntime(scriptFor(roster, () => [holds()]));
    await startWave(6, runtime, { maxParallelTurns: 2 });

    await flush();

    expect(runtime.inFlight).toBe(2);
    expect(runtime.peakConcurrency).toBe(2);
  });

  it("never exceeds the ten-participant ceiling", async () => {
    const roster = sessionParticipantRoster(10);
    const runtime = new WaveRuntime(scriptFor(roster, () => [holds()]));
    await startWave(10, runtime, { maxParallelTurns: SESSION_LIMITS.maxParallelTurns });

    await flush();

    expect(runtime.inFlight).toBe(10);
    expect(runtime.peakConcurrency).toBeLessThanOrEqual(SESSION_LIMITS.maxParallelTurns);
  });
});

/* ================================================================== *
 * PA13-11 — execution waves keep the strict failure contract.
 * ================================================================== */

describe("execution wave settlement", () => {
  it("commits every member of a healthy wave and returns to the user once", async () => {
    const roster = sessionParticipantRoster(4);
    const runtime = new WaveRuntime(
      scriptFor(roster, (agentId) => [ok(`contribution from ${agentId}`)]),
    );
    const context = await startWave(4, runtime);

    const details = await settle(context.service, context.runId);

    expect(details.run.status).toBe("awaiting_input");
    expect(details.turns).toHaveLength(4);
    expect(details.turns.every((turn) => turn.status === "committed")).toBe(true);
    expect(details.turns.every((turn) => turn.wavePurpose === "session_execution")).toBe(true);
    // One atomic wave: contiguous sequences, no gaps, no second wave.
    expect(details.turns.map((turn) => turn.sequence).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(details.run.activeTurnIds).toEqual([]);
    expect(
      details.artifacts.filter((artifact) => artifact.type === "session_message"),
    ).toHaveLength(4);
  });

  it("fails the run on retry exhaustion, but only after every sibling settled", async () => {
    const roster = sessionParticipantRoster(4);
    const failing = roster[2]!.id;
    const runtime = new WaveRuntime(
      scriptFor(roster, (agentId) =>
        agentId === failing
          ? [fails("provider rejected the request"), fails("provider rejected the request")]
          : [ok(`contribution from ${agentId}`)],
      ),
    );
    const context = await startWave(4, runtime);

    const details = await settle(context.service, context.runId);

    expect(details.run.status).toBe("failed");
    expect(details.run.errorCode).toBe("MAX_ATTEMPTS_EXCEEDED");

    // The three healthy siblings committed before the run was failed. If the
    // failing member had settled the run early, these would be cancelled.
    const committed = details.turns.filter((turn) => turn.status === "committed");
    expect(committed).toHaveLength(3);
    expect(committed.map((turn) => turn.agentId).sort()).toEqual(
      roster
        .filter((agent) => agent.id !== failing)
        .map((agent) => agent.id)
        .sort(),
    );
    expect(details.run.activeTurnIds).toEqual([]);
    // Both attempts of the failing member were spent: the budget is per turn.
    const failingAttempts = details.attempts.filter((attempt) => attempt.agentId === failing);
    expect(failingAttempts).toHaveLength(2);
  });

  it("never leaves an execution wave member holding an active lease", async () => {
    const roster = sessionParticipantRoster(3);
    const failing = roster[0]!.id;
    const runtime = new WaveRuntime(
      scriptFor(roster, (agentId) =>
        agentId === failing ? [fails(), fails()] : [ok(`from ${agentId}`)],
      ),
    );
    const context = await startWave(3, runtime);

    const details = await settle(context.service, context.runId);

    expect(details.run.status).toBe("failed");
    expect(details.run.activeTurnIds).toEqual([]);
    expect(details.attempts.every((attempt) => attempt.status !== "running")).toBe(true);
    expect(details.turns.every((turn) => turn.activeAttemptId === undefined)).toBe(true);
  });
});

/* ================================================================== *
 * PA13-12 — bidding waves tolerate partial failure.
 * ================================================================== */

describe("bidding wave settlement", () => {
  it("retires one failed bidder and leaves the session usable", async () => {
    const roster = sessionParticipantRoster(4);
    const failing = roster[1]!.id;
    const runtime = new WaveRuntime(
      scriptFor(roster, (agentId) =>
        agentId === failing ? [fails(), fails()] : [ok(`bid from ${agentId}`)],
      ),
    );
    const context = await startWave(4, runtime, {
      sessionWavePurpose: "session_bidding",
    });

    const details = await settle(context.service, context.runId);

    // The session survives: it is idle and ready for the next prompt.
    expect(details.run.status).toBe("awaiting_input");
    expect(details.run.errorCode).toBeUndefined();
    expect(details.run.activeTurnIds).toEqual([]);

    const retired = details.turns.filter((turn) => turn.status === "failed");
    expect(retired).toHaveLength(1);
    expect(retired[0]?.agentId).toBe(failing);
    expect(details.turns.filter((turn) => turn.status === "committed")).toHaveLength(3);
    expect(details.turns.every((turn) => turn.wavePurpose === "session_bidding")).toBe(true);

    // The in-memory repository deliberately keeps no event ledger, so the
    // `turn.failed` evidence for this same case is asserted against the durable
    // repository in `wave-repository.test.ts`.
    expect(details.attempts.filter((attempt) => attempt.agentId === failing)).toHaveLength(2);
  });

  it("accepts another prompt after a partial bidding failure", async () => {
    const roster = sessionParticipantRoster(3);
    const failing = roster[2]!.id;
    const runtime = new WaveRuntime(
      new Map([[failing, [fails(), fails()]]]),
      ok("a usable bid"),
    );
    const context = await startWave(3, runtime, {
      sessionWavePurpose: "session_bidding",
    });
    await settle(context.service, context.runId);

    await context.service.resumeRun(context.runId, { content: "And the second round?" });
    const details = await settle(context.service, context.runId);

    expect(details.run.status).toBe("awaiting_input");
    // Round two scheduled a full wave again, including the previously failed
    // bidder: unavailability is per round, not a permanent ejection.
    expect(details.turns).toHaveLength(6);
    expect(details.turns.filter((turn) => turn.agentId === failing)).toHaveLength(2);
  });

  it("fails honestly when no bidder returns anything usable", async () => {
    const roster = sessionParticipantRoster(3);
    const runtime = new WaveRuntime(scriptFor(roster, () => [fails(), fails()]));
    const context = await startWave(3, runtime, {
      sessionWavePurpose: "session_bidding",
    });

    const details = await settle(context.service, context.runId);

    // Zero valid bids is never silently successful.
    expect(details.run.status).toBe("failed");
    expect(details.run.errorCode).toBe("MAX_ATTEMPTS_EXCEEDED");
    expect(details.run.status).not.toBe("awaiting_input");
  });

  it("keeps invalid output tolerant for bidders and strict for execution", async () => {
    const roster = sessionParticipantRoster(3);
    const invalid = roster[0]!.id;
    const garbage: WaveBehaviour = { kind: "ok", output: "not json at all" };

    const bidding = await startWave(
      3,
      new WaveRuntime(
        new Map([[invalid, [garbage, garbage]]]),
        ok("a usable bid"),
      ),
      { sessionWavePurpose: "session_bidding" },
    );
    const biddingDetails = await settle(bidding.service, bidding.runId);
    expect(biddingDetails.run.status).toBe("awaiting_input");
    expect(
      biddingDetails.attempts.filter((attempt) => attempt.status === "invalid_output"),
    ).toHaveLength(2);

    const execution = await startWave(
      3,
      new WaveRuntime(
        new Map([[invalid, [garbage, garbage]]]),
        ok("a usable contribution"),
      ),
    );
    const executionDetails = await settle(execution.service, execution.runId);
    expect(executionDetails.run.status).toBe("failed");
  });
});

/* ================================================================== *
 * PA13-13 — contention is bounded and never waits without a deadline.
 * ================================================================== */

describe("wave contention", () => {
  it("skips a persistently busy bidder without failing its siblings", async () => {
    const roster = sessionParticipantRoster(3);
    const contended = roster[1]!.id;
    const runtime = new WaveRuntime(
      new Map([[contended, [busy(), busy()]]]),
      ok("a usable bid"),
    );
    const context = await startWave(3, runtime, {
      sessionWavePurpose: "session_bidding",
    });

    const details = await settle(context.service, context.runId);

    expect(details.run.status).toBe("awaiting_input");
    const retired = details.turns.filter((turn) => turn.status === "failed");
    expect(retired.map((turn) => turn.agentId)).toEqual([contended]);
    // Contention is attributed as reservation pressure, not as an Agent fault.
    const contendedAttempts = details.attempts.filter(
      (attempt) => attempt.agentId === contended,
    );
    expect(contendedAttempts).toHaveLength(2);
    expect(contendedAttempts.every((attempt) => attempt.errorCode === "AGENT_RESERVED")).toBe(
      true,
    );
    // Bounded: exactly the turn's budget, no unbounded waiting.
    expect(runtime.starts.filter((start) => start.agentId === contended)).toHaveLength(2);
  });

  it("recovers when contention clears within the budget", async () => {
    const roster = sessionParticipantRoster(3);
    const contended = roster[0]!.id;
    const runtime = new WaveRuntime(
      new Map([[contended, [busy(), ok("late but valid bid")]]]),
      ok("a usable bid"),
    );
    const context = await startWave(3, runtime, {
      sessionWavePurpose: "session_bidding",
    });

    const details = await settle(context.service, context.runId);

    expect(details.run.status).toBe("awaiting_input");
    expect(details.turns.every((turn) => turn.status === "committed")).toBe(true);
  });

  it("applies the strict policy to a busy execution assignee", async () => {
    const roster = sessionParticipantRoster(3);
    const contended = roster[2]!.id;
    const runtime = new WaveRuntime(
      new Map([[contended, [busy(), busy()]]]),
      ok("a usable contribution"),
    );
    const context = await startWave(3, runtime);

    const details = await settle(context.service, context.runId);

    expect(details.run.status).toBe("failed");
    expect(details.run.errorCode).toBe("MAX_ATTEMPTS_EXCEEDED");
    expect(details.turns.filter((turn) => turn.status === "committed")).toHaveLength(2);
  });
});

/* ================================================================== *
 * PA13-09 — bid-shaped turns run on isolated threads.
 * ================================================================== */

describe("wave thread policy", () => {
  it("requests a fresh thread for every bid and the default thread for execution", async () => {
    const roster = sessionParticipantRoster(3);

    const bidding = await startWave(
      3,
      new WaveRuntime(scriptFor(roster, (agentId) => [ok(`bid from ${agentId}`)])),
      { sessionWavePurpose: "session_bidding" },
    );
    await settle(bidding.service, bidding.runId);
    expect(bidding.runtime.starts).toHaveLength(3);
    expect(bidding.runtime.starts.every((start) => start.threadPolicy === "fresh")).toBe(true);

    const execution = await startWave(
      3,
      new WaveRuntime(scriptFor(roster, (agentId) => [ok(`from ${agentId}`)])),
    );
    await settle(execution.service, execution.runId);
    expect(
      execution.runtime.starts.every((start) => start.threadPolicy === "agent_default"),
    ).toBe(true);
  });

  it("gives every bidder the same explicit transcript regardless of its history", async () => {
    const roster = sessionParticipantRoster(3);
    const runtime = new WaveRuntime(scriptFor(roster, (agentId) => [ok(`bid from ${agentId}`)]));
    const context = await startWave(3, runtime, {
      sessionWavePurpose: "session_bidding",
    });
    await settle(context.service, context.runId);

    const prompts = runtime.starts.map((start) => start.prompt);
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) {
      expect(prompt).toContain("What should we ship first?");
    }
    // Bids in one wave see the same transcript: no bidder sees a sibling's bid,
    // and none of them carries a private thread that the others lack.
    for (const prompt of prompts) {
      for (const agent of roster) {
        expect(prompt).not.toContain(`bid from ${agent.id}`);
      }
    }
  });
});

/* ================================================================== *
 * PA13-14 — concurrent history stays validated.
 * ================================================================== */

describe("wave validation", () => {
  it("rejects a bidding purpose on a sequential session", async () => {
    const roster = sessionParticipantRoster(3);
    const context = waveHarness(3, new WaveRuntime(new Map()));
    await expect(
      context.service.createRun(
        waveRequest(context.roster, {
          sessionWaveMode: "sequential",
          sessionWavePurpose: "session_bidding",
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(roster).toHaveLength(3);
  });

  it("rejects a wave on the strictly ordered countdown protocol", async () => {
    const context = waveHarness(3, new WaveRuntime(new Map()));
    await expect(
      context.service.createRun(
        waveRequest(context.roster, {
          sessionProtocol: "countdown",
          sessionWaveMode: "parallel",
          maxTurns: undefined,
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects a concurrency cap outside the frozen bounds", async () => {
    const context = waveHarness(3, new WaveRuntime(new Map()));
    await expect(
      context.service.createRun(
        waveRequest(context.roster, { maxParallelTurns: SESSION_LIMITS.maxParallelTurns + 1 }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      context.service.createRun(waveRequest(context.roster, { maxParallelTurns: 0 })),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("refuses to decide on a transcript whose turns disagree about purpose", async () => {
    const roster = sessionParticipantRoster(3);
    const runtime = new WaveRuntime(scriptFor(roster, (agentId) => [ok(`bid from ${agentId}`)]));
    const context = await startWave(3, runtime, {
      sessionWavePurpose: "session_bidding",
    });
    const details = await settle(context.service, context.runId);

    // A stored turn that claims the other purpose is an invalid state, not a
    // routing hint: the workflow refuses rather than scheduling around it.
    const mixed = new SharedSessionWorkflowV1().decideNext({
      run: details.run,
      turns: details.turns.map((turn, index) =>
        index === 0 ? { ...turn, wavePurpose: "session_execution" as const } : turn,
      ),
      artifacts: details.artifacts,
    });
    expect(mixed).toMatchObject({ kind: "fail", code: "INVALID_STATE" });
  });

  it("refuses a transcript whose turn names a non-participant", async () => {
    const roster = sessionParticipantRoster(3);
    const runtime = new WaveRuntime(scriptFor(roster, (agentId) => [ok(`from ${agentId}`)]));
    const context = await startWave(3, runtime);
    const details = await settle(context.service, context.runId);

    const foreign = new SharedSessionWorkflowV1().decideNext({
      run: details.run,
      turns: details.turns.map((turn, index) =>
        index === 1 ? { ...turn, agentId: "agent-not-enrolled" } : turn,
      ),
      artifacts: details.artifacts,
    });
    expect(foreign).toMatchObject({ kind: "fail", code: "INVALID_STATE" });
  });

  it("refuses a transcript with duplicate turn sequences", async () => {
    const roster = sessionParticipantRoster(3);
    const runtime = new WaveRuntime(scriptFor(roster, (agentId) => [ok(`from ${agentId}`)]));
    const context = await startWave(3, runtime);
    const details = await settle(context.service, context.runId);

    const duplicated = new SharedSessionWorkflowV1().decideNext({
      run: details.run,
      turns: details.turns.map((turn, index) =>
        index === 2 ? { ...turn, sequence: details.turns[0]!.sequence } : turn,
      ),
      artifacts: details.artifacts,
    });
    expect(duplicated).toMatchObject({ kind: "fail", code: "INVALID_STATE" });
  });

  it("accepts a wave transcript whose members committed out of round-robin order", async () => {
    const roster = sessionParticipantRoster(4);
    const runtime = new WaveRuntime(scriptFor(roster, () => [holds()]));
    const context = await startWave(4, runtime, { maxParallelTurns: 4 });
    await flush();

    // Release in reverse, so commit order is the opposite of schedule order.
    const outcomes = new Map(
      roster.map((agent, index) => [
        agent.id,
        { kind: "succeeded" as const, rawOutput: JSON.stringify(freeChatPayload(`m${index}`)) },
      ]),
    );
    runtime.releaseAll((agentId) => outcomes.get(agentId)!);

    const details = await settle(context.service, context.runId);
    expect(details.run.status).toBe("awaiting_input");
    expect(details.turns.every((turn) => turn.status === "committed")).toBe(true);
  });
});

/* ================================================================== *
 * PA13-17 — usage is attributed to every real attempt.
 * ================================================================== */

describe("wave usage attribution", () => {
  it("counts failed and retried attempts, not only accepted artifacts", async () => {
    const roster = sessionParticipantRoster(3);
    const failing = roster[0]!.id;
    const usage = { inputTokens: 10, cachedInputTokens: 4, outputTokens: 6 };
    const withUsage = (content: string): WaveBehaviour => ({
      kind: "ok",
      output: JSON.stringify(freeChatPayload(content)),
    });

    class UsageRuntime extends WaveRuntime {
      override async start(input: RuntimeExecutionInput): Promise<RuntimeStartResult> {
        const started = await super.start(input);
        if (started.kind !== "started") return started;
        return {
          kind: "started",
          handle: {
            agentRunId: started.handle.agentRunId,
            completion: started.handle.completion.then((outcome) => ({ ...outcome, usage })),
          },
        };
      }
    }

    const runtime = new UsageRuntime(
      new Map([[failing, [fails(), fails()]]]),
      withUsage("a usable bid"),
    );
    const context = await startWave(3, runtime, {
      sessionWavePurpose: "session_bidding",
    });
    const details = await settle(context.service, context.runId);

    // Two failed attempts from the retired bidder plus two successful siblings.
    expect(details.attempts).toHaveLength(4);
    expect(details.attempts.every((attempt) => attempt.usage?.inputTokens === 10)).toBe(true);
    expect(details.usageTotals).toEqual({
      inputTokens: 40,
      cachedInputTokens: 16,
      outputTokens: 24,
    });
  });
});

/* ================================================================== *
 * Non-regression: sequential sessions are untouched.
 * ================================================================== */

describe("sequential sessions are unchanged by wave support", () => {
  it("still answers one participant at a time and never opens a wave", async () => {
    const roster = sessionParticipantRoster(3);
    const runtime = new WaveRuntime(
      scriptFor(roster, (agentId) => [
        { kind: "ok", output: JSON.stringify(freeChatPayload(`from ${agentId}`, true)) },
      ]),
    );
    const context = waveHarness(3, runtime);
    const run = await context.service.createRun({
      workflow: "shared_session_v1",
      name: "Sequential session",
      objective: "Answer in turn.",
      agents: context.roster.map((agent) => agent.id),
      policy: { sessionProtocol: "free_chat", maxTurns: 30 },
    });
    await context.service.resumeRun(run.id, { content: "One at a time please" });

    const details = await settle(context.service, run.id);

    expect(details.run.status).toBe("awaiting_input");
    expect(details.run.policy.sessionWaveMode).toBeUndefined();
    expect(runtime.peakConcurrency).toBe(1);
    expect(details.turns.every((turn) => turn.wavePurpose === "session_execution")).toBe(true);
    const scheduled = details.events.filter((event) => event.type === "turn.scheduled");
    expect(scheduled.every((event) => event.details.waveSize === undefined)).toBe(true);
  });
});

/* Type-only guard: the payload helper stays a session message. */
const _payloadShape: SessionMessagePayload = freeChatPayload("shape");
void _payloadShape;
