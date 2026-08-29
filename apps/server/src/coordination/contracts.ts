import type {
  AgentId,
  AgentRunId,
  ArtifactType,
  CoordinationArtifact,
  CoordinationArtifactId,
  CoordinationAttempt,
  CoordinationAttemptId,
  CoordinationErrorCode,
  CoordinationRole,
  CoordinationRun,
  CoordinationRunDetails,
  CoordinationRunId,
  CoordinationTurn,
  CoordinationTurnId,
  CreateCoordinationRunRequest,
} from "./types.js";

export interface Clock {
  nowIso(): string;
}

export interface IdGenerator {
  runId(): CoordinationRunId;
  turnId(): CoordinationTurnId;
  attemptId(): CoordinationAttemptId;
  artifactId(): CoordinationArtifactId;
  eventId(): string;
  leaseToken(): string;
}

export interface CoordinationServiceContract {
  initialize(): Promise<void>;
  listRuns(): Promise<CoordinationRun[]>;
  getRun(id: CoordinationRunId): Promise<CoordinationRunDetails | undefined>;
  createRun(input: CreateCoordinationRunRequest): Promise<CoordinationRun>;
  startRun(id: CoordinationRunId): Promise<CoordinationRun>;
  stopRun(id: CoordinationRunId): Promise<CoordinationRun>;
}

export interface CoordinationAgentView {
  id: AgentId;
  name: string;
  status: "ready" | "busy" | "stopped" | "error";
}

export interface CoordinationAgentDirectory {
  getAgentsByIds(ids: AgentId[]): Promise<CoordinationAgentView[]>;
}

export type WorkflowDecision =
  | {
      kind: "schedule";
      role: CoordinationRole;
      turnKind: CoordinationTurn["kind"];
      phase: CoordinationRun["phase"];
      revision: number;
      inputArtifactIds: CoordinationArtifactId[];
      expectedArtifactType: ArtifactType;
    }
  | { kind: "complete"; finalArtifactId: CoordinationArtifactId }
  | { kind: "fail"; code: CoordinationErrorCode; message: string };

export interface WorkflowView {
  run: CoordinationRun;
  artifacts: CoordinationArtifact[];
}

export interface VerifiedHandoffWorkflow {
  decideNext(view: WorkflowView): WorkflowDecision;
}

export interface PromptEnvelope {
  prompt: string;
  promptDigest: string;
  includedArtifactIds: CoordinationArtifactId[];
  truncated: boolean;
}

export interface ContextBuildInput {
  run: CoordinationRun;
  turn: CoordinationTurn;
  artifacts: CoordinationArtifact[];
  retryValidationErrors: string[];
}

export interface ContextBuilder {
  build(input: ContextBuildInput): PromptEnvelope;
}

export interface ArtifactValidationError {
  path: string;
  code: string;
  message: string;
}

export type ArtifactValidationResult =
  | { ok: true; artifact: CoordinationArtifact }
  | {
      ok: false;
      code: "INVALID_AGENT_OUTPUT" | "OUTPUT_TOO_LARGE";
      errors: ArtifactValidationError[];
    };

export interface ArtifactProtocol {
  validate(input: {
    run: CoordinationRun;
    turn: CoordinationTurn;
    attempt: CoordinationAttempt;
    rawOutput: string;
  }): ArtifactValidationResult;
}

export interface CreateRunRecordInput {
  run: CoordinationRun;
}

export type StartRunCommitResult =
  | { kind: "started"; run: CoordinationRun }
  | { kind: "not_found" }
  | {
      kind: "conflict";
      code: "INVALID_STATE" | "AGENT_NOT_READY" | "AGENT_RESERVED";
      message: string;
    };

export interface ScheduleTurnInput {
  runId: CoordinationRunId;
  expectedRunVersion: number;
  turn: CoordinationTurn;
  nextPhase: CoordinationRun["phase"];
  nextRevision: number;
}

export type ScheduleTurnResult =
  | { kind: "scheduled"; run: CoordinationRun; turn: CoordinationTurn }
  | { kind: "stale"; currentRun: CoordinationRun }
  | { kind: "not_found" };

export interface BeginAttemptInput {
  runId: CoordinationRunId;
  turnId: CoordinationTurnId;
  attempt: CoordinationAttempt;
}

export type BeginAttemptResult =
  | { kind: "started"; run: CoordinationRun; turn: CoordinationTurn }
  | { kind: "stale" }
  | { kind: "not_found" };

export interface CommitAcceptedArtifactInput {
  runId: CoordinationRunId;
  turnId: CoordinationTurnId;
  attemptId: CoordinationAttemptId;
  leaseToken: string;
  artifact: CoordinationArtifact;
}

export type CommitAcceptedArtifactResult =
  | {
      kind: "committed";
      run: CoordinationRun;
      turn: CoordinationTurn;
      artifact: CoordinationArtifact;
    }
  | { kind: "stale" }
  | { kind: "not_found" };

export interface FinishAttemptInput {
  runId: CoordinationRunId;
  turnId: CoordinationTurnId;
  attemptId: CoordinationAttemptId;
  leaseToken: string;
  status: "invalid_output" | "timed_out" | "failed" | "cancelled";
  errorCode: CoordinationErrorCode;
  errorMessage: string;
  validationErrors?: string[];
}

export interface CoordinationRepository {
  listRuns(limit?: number): Promise<CoordinationRun[]>;
  getRunDetails(id: CoordinationRunId): Promise<CoordinationRunDetails | undefined>;
  createRun(input: CreateRunRecordInput): Promise<CoordinationRun>;
  startRun(id: CoordinationRunId): Promise<StartRunCommitResult>;
  scheduleTurn(input: ScheduleTurnInput): Promise<ScheduleTurnResult>;
  beginAttempt(input: BeginAttemptInput): Promise<BeginAttemptResult>;
  attachAgentRun(input: {
    attemptId: CoordinationAttemptId;
    leaseToken: string;
    agentRunId: AgentRunId;
  }): Promise<"attached" | "stale">;
  commitAcceptedArtifact(
    input: CommitAcceptedArtifactInput,
  ): Promise<CommitAcceptedArtifactResult>;
  finishAttempt(input: FinishAttemptInput): Promise<"finished" | "stale">;
  requestStop(id: CoordinationRunId): Promise<CoordinationRun | undefined>;
  finishStopped(id: CoordinationRunId): Promise<CoordinationRun | undefined>;
  completeRun(input: {
    runId: CoordinationRunId;
    finalArtifactId: CoordinationArtifactId;
  }): Promise<CoordinationRun | undefined>;
  failRun(input: {
    runId: CoordinationRunId;
    code: CoordinationErrorCode;
    message: string;
  }): Promise<CoordinationRun | undefined>;
  interruptActiveRuns(): Promise<CoordinationRunId[]>;
}

export interface RuntimeExecutionInput {
  runId: CoordinationRunId;
  turnId: CoordinationTurnId;
  attemptId: CoordinationAttemptId;
  leaseToken: string;
  agentId: AgentId;
  prompt: string;
  timeoutMs: number;
}

export type RuntimeOutcome =
  | { kind: "succeeded"; rawOutput: string }
  | { kind: "timed_out"; message: string }
  | { kind: "cancelled"; message: string }
  | { kind: "failed"; message: string };

export interface RuntimeExecutionHandle {
  agentRunId: AgentRunId;
  completion: Promise<RuntimeOutcome>;
}

export type RuntimeStartResult =
  | { kind: "started"; handle: RuntimeExecutionHandle }
  | { kind: "failed"; message: string };

export interface CoordinationRuntime {
  start(input: RuntimeExecutionInput): Promise<RuntimeStartResult>;
  cancelAttempt(attemptId: CoordinationAttemptId): Promise<boolean>;
}

export interface Redactor {
  text(value: string, maxChars: number): string;
  eventDetails(
    value: Record<string, unknown>,
  ): Record<string, string | number | boolean | null | string[]>;
}

export interface StartAgentExecutionRequest {
  agentId: AgentId;
  prompt: string;
  source: "playground" | "coordination";
  coordination?: {
    runId: CoordinationRunId;
    turnId: CoordinationTurnId;
    attemptId: CoordinationAttemptId;
  };
}

export interface AgentExecutionHandle {
  agentRunId: AgentRunId;
  messageId: string;
  completion: Promise<{
    status: "completed" | "failed" | "cancelled";
    output?: string;
    error?: string;
  }>;
}

export interface AgentExecutionControl {
  startExecution(input: StartAgentExecutionRequest): Promise<AgentExecutionHandle>;
  cancelRun(agentRunId: AgentRunId): Promise<boolean>;
}
