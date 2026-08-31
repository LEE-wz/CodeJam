import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentExecutionControl,
  AgentExecutionHandle,
  StartAgentExecutionRequest,
} from "./contracts.js";
import { AgentServiceCoordinationRuntime } from "./runtime-gateway.js";

const input = {
  runId: "run-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  leaseToken: "lease-never-forwarded",
  agentId: "agent-1",
  prompt: "bounded prompt",
  timeoutMs: 100,
};

class FakeExecutionControl implements AgentExecutionControl {
  readonly starts: StartAgentExecutionRequest[] = [];
  readonly cancellations: string[] = [];
  private nextRun = 1;
  completion!: Promise<Awaited<AgentExecutionHandle["completion"]>>;
  resolve!: (result: Awaited<AgentExecutionHandle["completion"]>) => void;
  cancelResult: boolean | Promise<boolean> = true;

  async startExecution(request: StartAgentExecutionRequest): Promise<AgentExecutionHandle> {
    this.starts.push(request);
    this.completion = new Promise((resolve) => { this.resolve = resolve; });
    return {
      agentRunId: `agent-run-${this.nextRun++}`,
      messageId: "message-1",
      completion: this.completion,
    };
  }

  async cancelRun(agentRunId: string): Promise<boolean> {
    this.cancellations.push(agentRunId);
    return this.cancelResult;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentServiceCoordinationRuntime", () => {
  it("returns the Agent run ID before completion and maps exact successful output", async () => {
    const control = new FakeExecutionControl();
    const runtime = new AgentServiceCoordinationRuntime(control);
    const started = await runtime.start(input);
    expect(started).toMatchObject({ kind: "started", handle: { agentRunId: "agent-run-1" } });
    expect(control.starts[0]).toEqual({
      agentId: "agent-1",
      prompt: "bounded prompt",
      source: "coordination",
      coordination: { runId: "run-1", turnId: "turn-1", attemptId: "attempt-1" },
    });
    expect(JSON.stringify(control.starts[0])).not.toContain(input.leaseToken);

    control.resolve({
      status: "completed",
      output: "validated raw output",
      usage: { inputTokens: 80, cachedInputTokens: 20, outputTokens: 12 },
    });
    if (started.kind !== "started") throw new Error("runtime did not start");
    await expect(started.handle.completion).resolves.toEqual({
      kind: "succeeded",
      rawOutput: "validated raw output",
      usage: { inputTokens: 80, cachedInputTokens: 20, outputTokens: 12 },
    });
    expect(runtime.activeAttemptCount()).toBe(0);
  });

  it("maps and redacts execution failures", async () => {
    const control = new FakeExecutionControl();
    const runtime = new AgentServiceCoordinationRuntime(control);
    const started = await runtime.start(input);
    if (started.kind !== "started") throw new Error("runtime did not start");
    control.resolve({
      status: "failed",
      error: "api_key=super-secret postgres://user:hunter2@db/internal provider failed",
    });
    const outcome = await started.handle.completion;
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(JSON.stringify(outcome)).toContain("[redacted]");
    expect(JSON.stringify(outcome)).not.toContain("super-secret");
    expect(JSON.stringify(outcome)).not.toContain("hunter2");
  });

  it("lets timeout win, targets the correlated Agent run, and ignores late success", async () => {
    vi.useFakeTimers();
    const control = new FakeExecutionControl();
    const runtime = new AgentServiceCoordinationRuntime(control, 20);
    const started = await runtime.start({ ...input, timeoutMs: 100 });
    if (started.kind !== "started") throw new Error("runtime did not start");

    const outcomePromise = started.handle.completion;
    await vi.advanceTimersByTimeAsync(100);
    await expect(outcomePromise).resolves.toEqual({
      kind: "timed_out",
      message: "Agent execution timed out",
    });
    expect(control.cancellations).toEqual(["agent-run-1"]);
    expect(runtime.activeAttemptCount()).toBe(0);

    control.resolve({ status: "completed", output: "too late" });
    await vi.runAllTimersAsync();
    await expect(outcomePromise).resolves.toMatchObject({ kind: "timed_out" });
  });

  it("fails safely when timeout cancellation cannot confirm settlement", async () => {
    vi.useFakeTimers();
    const control = new FakeExecutionControl();
    control.cancelResult = false;
    const runtime = new AgentServiceCoordinationRuntime(control, 25);
    const started = await runtime.start({ ...input, timeoutMs: 100 });
    if (started.kind !== "started") throw new Error("runtime did not start");

    const outcome = started.handle.completion;
    await vi.advanceTimersByTimeAsync(125);
    await expect(outcome).resolves.toEqual({
      kind: "failed",
      message: "Agent execution did not settle after timeout cancellation",
    });
    expect(runtime.activeAttemptCount()).toBe(0);
  });

  it("maps user cancellation and cleans the attempt map", async () => {
    const control = new FakeExecutionControl();
    control.cancelRun = async (agentRunId) => {
      control.cancellations.push(agentRunId);
      control.resolve({ status: "cancelled" });
      return true;
    };
    const runtime = new AgentServiceCoordinationRuntime(control);
    const started = await runtime.start(input);
    if (started.kind !== "started") throw new Error("runtime did not start");
    await expect(runtime.cancelAttempt("attempt-1")).resolves.toBe(true);
    await expect(started.handle.completion).resolves.toEqual({
      kind: "cancelled",
      message: "Agent execution was cancelled",
    });
    expect(control.cancellations).toEqual(["agent-run-1"]);
    expect(runtime.activeAttemptCount()).toBe(0);
  });

  it("returns a safe start failure without creating active state", async () => {
    const control: AgentExecutionControl = {
      startExecution: async () => { throw new Error("password=hunter2 unavailable"); },
      cancelRun: async () => false,
    };
    const runtime = new AgentServiceCoordinationRuntime(control);
    const result = await runtime.start(input);
    expect(result).toEqual({
      kind: "failed",
      message: "password=[redacted] unavailable",
    });
    expect(runtime.activeAttemptCount()).toBe(0);
  });
});
