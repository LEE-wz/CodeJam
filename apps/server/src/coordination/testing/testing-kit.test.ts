import { describe, expect, it } from "vitest";
import { AdvancingClock, DeterministicIdGenerator, FixedClock } from "./controls.js";
import {
  APPROVING_REVIEW_ARTIFACT,
  COORDINATION_AGENTS,
  CREATE_RUN_REQUEST,
  INVALID_ARTIFACT_OUTPUT,
  REJECTING_REVIEW_ARTIFACT,
  REQUIRED_SECTIONS,
  VALID_FINAL_ARTIFACT,
  VALID_PROPOSAL_ARTIFACT,
} from "./fixtures.js";
import {
  deferred,
  failsExecution,
  failsToStart,
  ScriptedCoordinationRuntime,
  succeeds,
  timesOut,
} from "./fakes.js";

describe("Phase 0 testing kit", () => {
  it("provides fixed and advancing deterministic controls", () => {
    expect(new FixedClock().nowIso()).toBe("2026-08-29T00:00:00.000Z");

    const clock = new AdvancingClock("2026-08-29T00:00:00.000Z", 1_000);
    expect(clock.nowIso()).toBe("2026-08-29T00:00:00.000Z");
    expect(clock.nowIso()).toBe("2026-08-29T00:00:01.000Z");

    const ids = new DeterministicIdGenerator();
    expect([
      ids.runId(),
      ids.turnId(),
      ids.attemptId(),
      ids.artifactId(),
      ids.eventId(),
      ids.leaseToken(),
      ids.runId(),
    ]).toEqual([
      "run-0001",
      "turn-0001",
      "attempt-0001",
      "artifact-0001",
      "event-0001",
      "lease-0001",
      "run-0002",
    ]);
  });

  it("provides the complete stable artifact and Agent fixture set", () => {
    expect(new Set(COORDINATION_AGENTS.map((agent) => agent.id)).size).toBe(3);
    expect(REQUIRED_SECTIONS).toHaveLength(3);
    expect(CREATE_RUN_REQUEST.requiredSections).toHaveLength(3);
    expect(VALID_PROPOSAL_ARTIFACT.payload.type).toBe("proposal");
    expect(REJECTING_REVIEW_ARTIFACT.payload).toMatchObject({
      type: "review",
      decision: "reject",
    });
    expect(APPROVING_REVIEW_ARTIFACT.payload).toMatchObject({
      type: "review",
      decision: "approve",
    });
    expect(VALID_FINAL_ARTIFACT.payload.type).toBe("final");
    expect(() => JSON.parse(INVALID_ARTIFACT_OUTPUT)).not.toThrow();
  });
});

describe("Phase 1 scripted runtime", () => {
  const executionInput = (attemptId: string) => ({
    runId: "run-0001",
    turnId: "turn-0001",
    attemptId,
    leaseToken: "lease-0001",
    agentId: "agent-planner",
    prompt: "Role: planner",
    timeoutMs: 1_000,
  });

  it("returns queued outcomes in order and captures every call", async () => {
    const runtime = new ScriptedCoordinationRuntime([
      succeeds("first"),
      timesOut("slow"),
      failsExecution("boom"),
    ]);

    const first = await runtime.start(executionInput("attempt-1"));
    const second = await runtime.start(executionInput("attempt-2"));
    const third = await runtime.start(executionInput("attempt-3"));

    expect(first.kind).toBe("started");
    expect(second.kind).toBe("started");
    expect(third.kind).toBe("started");
    if (first.kind !== "started" || second.kind !== "started" || third.kind !== "started") {
      throw new Error("expected every scripted start to succeed");
    }

    expect(await first.handle.completion).toEqual({ kind: "succeeded", rawOutput: "first" });
    expect(await second.handle.completion).toEqual({ kind: "timed_out", message: "slow" });
    expect(await third.handle.completion).toEqual({ kind: "failed", message: "boom" });
    expect(runtime.starts.map((call) => call.attemptId)).toEqual([
      "attempt-1",
      "attempt-2",
      "attempt-3",
    ]);
    expect(first.handle.agentRunId).not.toBe(second.handle.agentRunId);
  });

  it("reports a scripted start failure without an execution handle", async () => {
    const runtime = new ScriptedCoordinationRuntime([failsToStart("engine down")]);

    expect(await runtime.start(executionInput("attempt-1"))).toEqual({
      kind: "failed",
      message: "engine down",
    });
  });

  it("fails loudly when no outcome is scripted", async () => {
    const runtime = new ScriptedCoordinationRuntime();

    expect(await runtime.start(executionInput("attempt-1"))).toEqual({
      kind: "failed",
      message: "No runtime outcome scripted",
    });
  });

  it("leaves a deferred attempt pending until the test resolves it", async () => {
    const runtime = new ScriptedCoordinationRuntime([deferred()]);
    const started = await runtime.start(executionInput("attempt-1"));
    if (started.kind !== "started") throw new Error("expected a started attempt");

    let settled = false;
    void started.handle.completion.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(runtime.pendingAttemptIds()).toEqual(["attempt-1"]);

    runtime.resolveAttempt("attempt-1", { kind: "succeeded", rawOutput: "late" });

    expect(await started.handle.completion).toEqual({ kind: "succeeded", rawOutput: "late" });
    expect(runtime.pendingAttemptIds()).toEqual([]);
  });

  it("records cancellation without resolving the deferred completion", async () => {
    const runtime = new ScriptedCoordinationRuntime([deferred()]);
    const started = await runtime.start(executionInput("attempt-1"));
    if (started.kind !== "started") throw new Error("expected a started attempt");

    expect(await runtime.cancelAttempt("attempt-1")).toBe(true);
    expect(runtime.cancelledAttemptIds).toEqual(["attempt-1"]);
    expect(runtime.pendingAttemptIds()).toEqual(["attempt-1"]);

    runtime.resolveAttempt("attempt-1", { kind: "succeeded", rawOutput: "late" });
    expect(await started.handle.completion).toEqual({ kind: "succeeded", rawOutput: "late" });
  });

  it("throws when a test resolves an attempt that is not pending", () => {
    const runtime = new ScriptedCoordinationRuntime();

    expect(() => runtime.resolveAttempt("attempt-9", { kind: "failed", message: "x" })).toThrow(
      /No deferred attempt is pending/,
    );
  });

  it("lets a test wait for a given number of started attempts", async () => {
    const runtime = new ScriptedCoordinationRuntime([deferred(), deferred()]);
    let reached = false;
    const waiter = runtime.waitForStarts(2).then(() => {
      reached = true;
    });

    await runtime.start(executionInput("attempt-1"));
    await Promise.resolve();
    expect(reached).toBe(false);

    await runtime.start(executionInput("attempt-2"));
    await waiter;

    expect(reached).toBe(true);
    await expect(runtime.waitForStarts(1)).resolves.toBeUndefined();
  });
});
