import type {
  ArtifactProtocol,
  ArtifactValidationResult,
  BeginAttemptInput,
  BeginAttemptResult,
  CommitAcceptedArtifactInput,
  CommitAcceptedArtifactResult,
  ContextBuildInput,
  CoordinationAgentDirectory,
  CoordinationAgentView,
  CoordinationRepository,
  CoordinationRuntime,
  CreateRunRecordInput,
  FinishAttemptInput,
  PromptEnvelope,
  RuntimeExecutionInput,
  RuntimeOutcome,
  RuntimeStartResult,
  ScheduleTurnInput,
  ScheduleTurnResult,
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
      includedArtifactIds: input.artifacts.map((artifact) => artifact.id),
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

  async scheduleTurn(_input: ScheduleTurnInput): Promise<ScheduleTurnResult> {
    return notImplemented("FakeCoordinationRepository.scheduleTurn");
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
}

export class ScriptedCoordinationRuntime implements CoordinationRuntime {
  readonly starts: RuntimeExecutionInput[] = [];
  readonly cancelledAttemptIds: string[] = [];
  private nextAgentRun = 1;

  constructor(private readonly outcomes: RuntimeOutcome[] = []) {}

  async start(input: RuntimeExecutionInput): Promise<RuntimeStartResult> {
    this.starts.push({ ...input });
    const outcome = this.outcomes.shift();
    if (!outcome) {
      return { kind: "failed", message: "No runtime outcome scripted" };
    }
    const agentRunId = `agent-run-${String(this.nextAgentRun).padStart(4, "0")}`;
    this.nextAgentRun += 1;
    return {
      kind: "started",
      handle: { agentRunId, completion: Promise.resolve(outcome) },
    };
  }

  async cancelAttempt(attemptId: string): Promise<boolean> {
    this.cancelledAttemptIds.push(attemptId);
    return true;
  }
}
