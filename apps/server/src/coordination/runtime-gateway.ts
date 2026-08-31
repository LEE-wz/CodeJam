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

/**
 * Whether a start failure means "this Agent is occupied right now" rather than
 * "this Agent is broken". Recognised from the AgentService reservation contract:
 * an `AGENT_RESERVED` code, or the busy refusal it raises without one.
 */
const isContention = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "AGENT_RESERVED") return true;
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  const message = error instanceof Error ? error.message : "";
  return statusCode === 409 && /already running|reserved/i.test(message);
};

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
        ...(input.threadPolicy === undefined ? {} : { threadPolicy: input.threadPolicy }),
        coordination: {
          runId: input.runId,
          turnId: input.turnId,
          attemptId: input.attemptId,
        },
      });
    } catch (error) {
      // PA13-13: contention is a bounded, retryable condition, not a fault. The
      // attempt never reached the provider, so a bidding wave may skip this
      // participant once its budget is spent while an execution assignee stays
      // under the stricter execution policy.
      return {
        kind: "failed",
        message: this.safeMessage(error, "Agent execution could not start"),
        ...(isContention(error) ? { busy: true } : {}),
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
