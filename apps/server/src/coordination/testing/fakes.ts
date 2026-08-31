import type {
  ArtifactProtocol,
  ArtifactValidationResult,
  AppendUserMessageInput,
  AppendUserMessageResult,
  BeginAttemptInput,
  BeginAttemptResult,
  CommitAcceptedArtifactInput,
  CommitAcceptedArtifactResult,
  ContextBuildInput,
  CoordinationAgentDirectory,
  FailTurnInput,
  FailTurnResult,
  CoordinationAgentView,
  CoordinationRepository,
  CoordinationRuntime,
  CreateRunRecordInput,
  FinishAttemptInput,
  NonTerminalRunSummary,
  PromptEnvelope,
  ReconcileRunResult,
  RuntimeExecutionInput,
  RuntimeOutcome,
  RuntimeStartResult,
  ScheduleTurnInput,
  ScheduleTurnResult,
  ScheduleTurnsInput,
  ScheduleTurnsResult,
  StartRunCommitResult,
  VerifiedHandoffWorkflow,
  WorkflowDecision,
  WorkflowView,
} from "../contracts.js";
import type {
  CoordinationRun,
  CoordinationRunDetails,
  CoordinationRunId,
} from "../types.js";
import { COORDINATION_AGENTS } from "./fixtures.js";

const notImplemented = (method: string): never => {
  throw new Error(`NotImplemented: ${method}`);
};

export class FakeAgentDirectory implements CoordinationAgentDirectory {
  constructor(
    private readonly agents: readonly CoordinationAgentView[] = COORDINATION_AGENTS,
  ) {}

  async getAgentsByIds(ids: string[]): Promise<CoordinationAgentView[]> {
    return this.agents.filter((agent) => ids.includes(agent.id)).map((agent) => ({ ...agent }));
  }
}

export class FakeWorkflow implements VerifiedHandoffWorkflow {
  constructor(private readonly decisions: WorkflowDecision[] = []) {}

  decideNext(_view: WorkflowView): WorkflowDecision {
    return this.decisions.shift() ?? notImplemented("FakeWorkflow.decideNext");
  }
}

export class FakeContextBuilder {
  build(input: ContextBuildInput): PromptEnvelope {
    return {
      prompt: `Role: ${input.turn.role}`,
      promptDigest: `prompt-${input.turn.id}`,
      truncated: false,
    };
  }
}

export class FakeArtifactProtocol implements ArtifactProtocol {
  constructor(
    private readonly result: ArtifactValidationResult = {
      ok: false,
      code: "INVALID_AGENT_OUTPUT",
      errors: [{ path: "output", code: "not_scripted", message: "No artifact scripted" }],
    },
  ) {}

  validate(): ArtifactValidationResult {
    return this.result;
  }
}

export class FakeCoordinationRepository implements CoordinationRepository {
  async listRuns(_limit?: number): Promise<CoordinationRun[]> {
    return notImplemented("FakeCoordinationRepository.listRuns");
  }

  async getRunDetails(_id: string): Promise<CoordinationRunDetails | undefined> {
    return notImplemented("FakeCoordinationRepository.getRunDetails");
  }

  async createRun(_input: CreateRunRecordInput): Promise<CoordinationRun> {
    return notImplemented("FakeCoordinationRepository.createRun");
  }

  async startRun(_id: string): Promise<StartRunCommitResult> {
    return notImplemented("FakeCoordinationRepository.startRun");
  }

  async appendUserMessage(_input: AppendUserMessageInput): Promise<AppendUserMessageResult> {
    return notImplemented("FakeCoordinationRepository.appendUserMessage");
  }

  async awaitInput(_id: string): Promise<CoordinationRun | undefined> {
    return notImplemented("FakeCoordinationRepository.awaitInput");
  }

  async endSession(_id: string): Promise<
    | { kind: "ended"; run: CoordinationRun }
    | { kind: "conflict"; run: CoordinationRun }
    | { kind: "not_found" }
  > {
    return notImplemented("FakeCoordinationRepository.endSession");
  }

  async scheduleTurn(_input: ScheduleTurnInput): Promise<ScheduleTurnResult> {
    return notImplemented("FakeCoordinationRepository.scheduleTurn");
  }

  async scheduleTurns(_input: ScheduleTurnsInput): Promise<ScheduleTurnsResult> {
    return notImplemented("FakeCoordinationRepository.scheduleTurns");
  }

  async failTurn(_input: FailTurnInput): Promise<FailTurnResult> {
    return notImplemented("FakeCoordinationRepository.failTurn");
  }

  async beginAttempt(_input: BeginAttemptInput): Promise<BeginAttemptResult> {
    return notImplemented("FakeCoordinationRepository.beginAttempt");
  }

  async attachAgentRun(_input: {
    attemptId: string;
    leaseToken: string;
    agentRunId: string;
  }): Promise<"attached" | "stale"> {
    return notImplemented("FakeCoordinationRepository.attachAgentRun");
  }

  async commitAcceptedArtifact(
    _input: CommitAcceptedArtifactInput,
  ): Promise<CommitAcceptedArtifactResult> {
    return notImplemented("FakeCoordinationRepository.commitAcceptedArtifact");
  }

  async finishAttempt(_input: FinishAttemptInput): Promise<"finished" | "stale"> {
    return notImplemented("FakeCoordinationRepository.finishAttempt");
  }

  async requestStop(_id: string): Promise<CoordinationRun | undefined> {
    return notImplemented("FakeCoordinationRepository.requestStop");
  }

  async finishStopped(_id: string): Promise<CoordinationRun | undefined> {
    return notImplemented("FakeCoordinationRepository.finishStopped");
  }

  async completeRun(_input: {
    runId: string;
    finalArtifactId: string;
  }): Promise<CoordinationRun | undefined> {
    return notImplemented("FakeCoordinationRepository.completeRun");
  }

  async failRun(_input: {
    runId: string;
    code: NonNullable<CoordinationRun["errorCode"]>;
    message: string;
  }): Promise<CoordinationRun | undefined> {
    return notImplemented("FakeCoordinationRepository.failRun");
  }

  async interruptActiveRuns(): Promise<CoordinationRunId[]> {
    return notImplemented("FakeCoordinationRepository.interruptActiveRuns");
  }

  async listNonTerminalRuns(): Promise<NonTerminalRunSummary[]> {
    return notImplemented("FakeCoordinationRepository.listNonTerminalRuns");
  }

  async reconcileRun(_input: {
    runId: CoordinationRunId;
    reason: string;
  }): Promise<ReconcileRunResult> {
    return notImplemented("FakeCoordinationRepository.reconcileRun");
  }
}

/**
 * One scripted step per `CoordinationRuntime.start()` call.
 *
 * `deferred` is what makes race tests possible without sleeping: the attempt
 * starts, the service awaits its completion, and the test decides exactly when
 * -- and with which outcome -- that completion resolves.
 */
export type ScriptedRuntimeStep =
  | { kind: "outcome"; outcome: RuntimeOutcome }
  | { kind: "deferred" }
  | { kind: "start_failed"; message: string };

export const succeeds = (rawOutput: string): ScriptedRuntimeStep => ({
  kind: "outcome",
  outcome: { kind: "succeeded", rawOutput },
});

export const timesOut = (message = "Attempt timed out"): ScriptedRuntimeStep => ({
  kind: "outcome",
  outcome: { kind: "timed_out", message },
});

export const failsExecution = (
  message = "Agent execution failed",
): ScriptedRuntimeStep => ({ kind: "outcome", outcome: { kind: "failed", message } });

export const cancelled = (message = "Attempt cancelled"): ScriptedRuntimeStep => ({
  kind: "outcome",
  outcome: { kind: "cancelled", message },
});

export const deferred = (): ScriptedRuntimeStep => ({ kind: "deferred" });

export const failsToStart = (
  message = "Agent execution could not start",
): ScriptedRuntimeStep => ({ kind: "start_failed", message });

const isRuntimeOutcome = (
  step: ScriptedRuntimeStep | RuntimeOutcome,
): step is RuntimeOutcome =>
  step.kind === "succeeded" ||
  step.kind === "timed_out" ||
  step.kind === "cancelled" ||
  step.kind === "failed";

export class ScriptedCoordinationRuntime implements CoordinationRuntime {
  readonly starts: RuntimeExecutionInput[] = [];
  readonly cancelledAttemptIds: string[] = [];

  private readonly steps: ScriptedRuntimeStep[];
  private readonly pending = new Map<string, (outcome: RuntimeOutcome) => void>();
  private readonly startWaiters: Array<{ count: number; resolve: () => void }> = [];
  private nextAgentRun = 1;

  constructor(steps: Array<ScriptedRuntimeStep | RuntimeOutcome> = []) {
    this.steps = steps.map((step) =>
      isRuntimeOutcome(step) ? { kind: "outcome", outcome: step } : step,
    );
  }

  async start(input: RuntimeExecutionInput): Promise<RuntimeStartResult> {
    this.starts.push({ ...input });
    this.releaseStartWaiters();

    const step = this.steps.shift();
    if (!step) {
      return { kind: "failed", message: "No runtime outcome scripted" };
    }
    if (step.kind === "start_failed") {
      return { kind: "failed", message: step.message };
    }

    const agentRunId = `agent-run-${String(this.nextAgentRun).padStart(4, "0")}`;
    this.nextAgentRun += 1;

    const completion =
      step.kind === "outcome"
        ? Promise.resolve(step.outcome)
        : new Promise<RuntimeOutcome>((resolve) => {
            this.pending.set(input.attemptId, resolve);
          });

    return { kind: "started", handle: { agentRunId, completion } };
  }

  /**
   * Records the cancellation without resolving a deferred completion. Tests stay
   * in control of the late result, which is exactly the race the lease has to
   * survive: a cancelled attempt may still return successfully afterwards.
   */
  async cancelAttempt(attemptId: string): Promise<boolean> {
    this.cancelledAttemptIds.push(attemptId);
    return this.pending.has(attemptId);
  }

  /** Resolves a deferred attempt with the outcome the test chooses. */
  resolveAttempt(attemptId: string, outcome: RuntimeOutcome): void {
    const resolve = this.pending.get(attemptId);
    if (!resolve) {
      throw new Error(`No deferred attempt is pending for ${attemptId}`);
    }
    this.pending.delete(attemptId);
    resolve(outcome);
  }

  pendingAttemptIds(): string[] {
    return [...this.pending.keys()];
  }

  /** Resolves once `count` attempts have been started. */
  waitForStarts(count: number): Promise<void> {
    if (this.starts.length >= count) {
      return Promise.resolve();
    }
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
