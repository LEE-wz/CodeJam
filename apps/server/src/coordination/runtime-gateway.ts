import type {
  AgentExecutionControl,
  AgentExecutionHandle,
  CoordinationRuntime,
  RuntimeExecutionHandle,
  RuntimeExecutionInput,
  RuntimeOutcome,
  RuntimeStartResult,
  StartAgentExecutionRequest,
} from "./contracts.js";
import type { CoordinationAttemptId } from "./types.js";
import { defaultRedactor } from "./redaction.js";

export type {
  AgentExecutionControl,
  AgentExecutionHandle,
  CoordinationRuntime,
  RuntimeExecutionHandle,
  RuntimeExecutionInput,
  RuntimeOutcome,
  RuntimeStartResult,
  StartAgentExecutionRequest,
} from "./contracts.js";

const SAFE_ERROR_CHARS = 200;

interface ActiveAttempt {
  agentRunId: string;
}

export class AgentServiceCoordinationRuntime implements CoordinationRuntime {
  private readonly activeAttempts = new Map<CoordinationAttemptId, ActiveAttempt>();

  constructor(
    private readonly executions: AgentExecutionControl,
    private readonly cancellationGraceMs = 2_000,
  ) {}

  async start(input: RuntimeExecutionInput): Promise<RuntimeStartResult> {
    let execution: AgentExecutionHandle;
    try {
      execution = await this.executions.startExecution({
        agentId: input.agentId,
        prompt: input.prompt,
        source: "coordination",
        coordination: {
          runId: input.runId,
          turnId: input.turnId,
          attemptId: input.attemptId,
        },
      });
    } catch (error) {
      return {
        kind: "failed",
        message: this.safeMessage(error, "Agent execution could not start"),
      };
    }

    this.activeAttempts.set(input.attemptId, { agentRunId: execution.agentRunId });
    const completion = this.settle(input, execution);
    return {
      kind: "started",
      handle: { agentRunId: execution.agentRunId, completion },
    };
  }

  async cancelAttempt(attemptId: CoordinationAttemptId): Promise<boolean> {
    const active = this.activeAttempts.get(attemptId);
    if (!active) return false;
    return this.executions.cancelRun(active.agentRunId);
  }

  /** Test/diagnostic surface containing identifiers neither in logs nor HTTP. */
  activeAttemptCount(): number {
    return this.activeAttempts.size;
  }

  private async settle(
    input: RuntimeExecutionInput,
    execution: AgentExecutionHandle,
  ): Promise<RuntimeOutcome> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutWon = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), input.timeoutMs);
    });
    const agentSettled = execution.completion.then((result) => ({
      kind: "agent" as const,
      result,
    }));

    try {
      const winner = await Promise.race([
        agentSettled,
        timeoutWon.then(() => ({ kind: "timeout" as const })),
      ]);
      if (winner.kind === "agent") {
        return this.mapResult(winner.result);
      }

      const cancellation = this.executions.cancelRun(execution.agentRunId);
      const confirmed = await this.waitForCancellation(cancellation, agentSettled);
      if (!confirmed) {
        return {
          kind: "failed",
          message: "Agent execution did not settle after timeout cancellation",
        };
      }
      return { kind: "timed_out", message: "Agent execution timed out" };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (this.activeAttempts.get(input.attemptId)?.agentRunId === execution.agentRunId) {
        this.activeAttempts.delete(input.attemptId);
      }
      void execution.completion.catch(() => undefined);
    }
  }

  private async waitForCancellation(
    cancellation: Promise<boolean>,
    settlement: Promise<unknown>,
  ): Promise<boolean> {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<false>((resolve) => {
      graceTimer = setTimeout(() => resolve(false), this.cancellationGraceMs);
    });
    try {
      return await Promise.race([
        cancellation
          .then((cancelled) =>
            cancelled ? true : new Promise<boolean>(() => undefined),
          )
          .catch(() => new Promise<boolean>(() => undefined)),
        settlement.then(() => true).catch(() => true),
        grace,
      ]);
    } finally {
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    }
  }

  private mapResult(
    result: Awaited<AgentExecutionHandle["completion"]>,
  ): RuntimeOutcome {
    if (result.status === "completed") {
      return {
        kind: "succeeded",
        rawOutput: result.output ?? "",
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      };
    }
    if (result.status === "cancelled") {
      return {
        kind: "cancelled",
        message: "Agent execution was cancelled",
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      };
    }
    return {
      kind: "failed",
      message: this.safeMessage(result.error, "Agent execution failed"),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  }

  private safeMessage(error: unknown, fallback: string): string {
    const value = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
    return defaultRedactor.text(value || fallback, SAFE_ERROR_CHARS);
  }
}
