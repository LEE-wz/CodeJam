import type {
  BeginAttemptInput,
  BeginAttemptResult,
  AppendUserMessageInput,
  AppendUserMessageResult,
  Clock,
  CommitAcceptedArtifactInput,
  CommitAcceptedArtifactResult,
  CoordinationRepository,
  CreateRunRecordInput,
  FinishAttemptInput,
  NonTerminalRunSummary,
  ReconcileRunResult,
  ScheduleTurnInput,
  ScheduleTurnResult,
  ScheduleTurnsInput,
  ScheduleTurnsResult,
  StartRunCommitResult,
} from "../contracts.js";
import type {
  AgentRunId,
  CoordinationArtifact,
  CoordinationAttempt,
  CoordinationAttemptId,
  CoordinationErrorCode,
  CoordinationRun,
  CoordinationRunDetails,
  CoordinationRunId,
  CoordinationTurn,
} from "../types.js";

/**
 * In-memory stand-in for the durable repository, sufficient to prove Phase 1
 * workflow semantics without disk or HTTP.
 *
 * Every read returns a deep copy, so a caller that wants current state has to
 * reload it -- the same discipline the durable repository will require. Lease,
 * active-attempt, and status checks are enforced here so that stale and late
 * results are rejected exactly as they will be in Phase 2. Atomicity, events,
 * migration, and reservations remain Phase 2 work.
 */
export class InMemoryCoordinationRepository implements CoordinationRepository {
  private readonly runs = new Map<CoordinationRunId, CoordinationRun>();
  private readonly order: CoordinationRunId[] = [];
  private readonly turns: CoordinationTurn[] = [];
  private readonly attempts: CoordinationAttempt[] = [];
  private readonly artifacts: CoordinationArtifact[] = [];

  constructor(private readonly clock: Clock) {}

  async listRuns(limit = 50): Promise<CoordinationRun[]> {
    return [...this.order]
      .reverse()
      .slice(0, limit)
      .flatMap((id) => {
        const run = this.runs.get(id);
        return run ? [structuredClone(run)] : [];
      });
  }

  async getRunDetails(id: CoordinationRunId): Promise<CoordinationRunDetails | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    return structuredClone({
      run,
      turns: this.turns.filter((turn) => turn.runId === id),
      attempts: this.attempts.filter((attempt) => attempt.runId === id),
      artifacts: this.artifacts.filter((artifact) => artifact.runId === id),
      events: [],
    });
  }

  async createRun(input: CreateRunRecordInput): Promise<CoordinationRun> {
    this.runs.set(input.run.id, structuredClone(input.run));
    this.order.push(input.run.id);
    return structuredClone(input.run);
  }

  async startRun(id: CoordinationRunId): Promise<StartRunCommitResult> {
    const run = this.runs.get(id);
    if (!run) return { kind: "not_found" };
    if (run.status !== "created") {
      return {
        kind: "conflict",
        code: "INVALID_STATE",
        message: "Coordination run is already active",
      };
    }
    run.status = "running";
    run.startedAt = this.clock.nowIso();
    run.updatedAt = this.clock.nowIso();
    run.version += 1;
    return { kind: "started", run: structuredClone(run) };
  }

  async appendUserMessage(input: AppendUserMessageInput): Promise<AppendUserMessageResult> {
    const run = this.runs.get(input.runId);
    if (!run) return { kind: "not_found" };
    if (run.status === "completed" || run.status === "failed" || run.status === "stopped") {
      return { kind: "terminal", run: structuredClone(run) };
    }
    const latest = run.lastUserArtifactId
      ? this.artifacts.find((artifact) => artifact.id === run.lastUserArtifactId)
      : undefined;
    if (
      input.clientMessageId !== undefined &&
      latest?.type === "user_message" &&
      latest.clientMessageId === input.clientMessageId
    ) {
      return { kind: "duplicate", run: structuredClone(run) };
    }
    if (run.status !== "created" && run.status !== "awaiting_input") {
      return { kind: "conflict", run: structuredClone(run) };
    }
    const now = this.clock.nowIso();
    const transcriptSequence = this.nextTranscriptSequence(run.id);
    const artifact: CoordinationArtifact = {
      id: `user-${run.id}-${transcriptSequence}`,
      runId: run.id,
      type: "user_message",
      payload: { schemaVersion: 1, type: "user_message", content: input.content.trim() },
      createdBy: { kind: "user" },
      ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
      transcriptSequence,
      sizeChars: input.content.trim().length,
      createdAt: now,
    };
    this.artifacts.push(artifact);
    run.lastUserArtifactId = artifact.id;
    run.status = "running";
    run.startedAt ??= now;
    run.updatedAt = now;
    run.version += 1;
    return { kind: "appended", run: structuredClone(run), artifact: structuredClone(artifact) };
  }

  async awaitInput(id: CoordinationRunId): Promise<CoordinationRun | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    if (run.status === "running" && activeTurnIdsFor(run).length === 0) {
      run.status = "awaiting_input";
      run.version += 1;
      run.updatedAt = this.clock.nowIso();
    }
    return structuredClone(run);
  }

  async endSession(id: CoordinationRunId): Promise<
    | { kind: "ended"; run: CoordinationRun }
    | { kind: "conflict"; run: CoordinationRun }
    | { kind: "not_found" }
  > {
    const run = this.runs.get(id);
    if (!run) return { kind: "not_found" };
    if (run.status !== "created" && run.status !== "awaiting_input") {
      return { kind: "conflict", run: structuredClone(run) };
    }
    const latest = this.artifacts
      .filter((artifact) => artifact.runId === id && artifact.type === "session_message")
      .at(-1);
    run.status = "completed";
    run.phase = "done";
    run.endedByUser = true;
    if (latest) run.finalArtifactId = latest.id;
    run.completedAt = this.clock.nowIso();
    run.updatedAt = this.clock.nowIso();
    run.version += 1;
    return { kind: "ended", run: structuredClone(run) };
  }

  async scheduleTurn(input: ScheduleTurnInput): Promise<ScheduleTurnResult> {
    const scheduled = await this.scheduleTurns({
      runId: input.runId,
      expectedRunVersion: input.expectedRunVersion,
      turns: [input.turn],
      nextPhase: input.nextPhase,
      nextRevision: input.nextRevision,
    });
    if (scheduled.kind !== "scheduled") return scheduled;
    return { kind: "scheduled", run: scheduled.run, turn: scheduled.turns[0]! };
  }

  async scheduleTurns(input: ScheduleTurnsInput): Promise<ScheduleTurnsResult> {
    const run = this.runs.get(input.runId);
    if (!run) return { kind: "not_found" };
    const activeTurnIds = ensureActiveTurnIds(run);
    if (
      run.status !== "running" ||
      activeTurnIds.length !== 0 ||
      input.turns.length === 0 ||
      run.version !== input.expectedRunVersion
    ) {
      return { kind: "stale", currentRun: structuredClone(run) };
    }
    const turns = [...input.turns]
      .map((turn) => structuredClone(turn))
      .sort((left, right) => left.sequence - right.sequence);
    if (
      new Set(turns.map((turn) => turn.id)).size !== turns.length ||
      new Set(turns.map((turn) => turn.agentId)).size !== turns.length ||
      !turns.every(
        (turn, index) =>
          turn.runId === run.id &&
          turn.status === "scheduled" &&
          turn.sequence === run.nextTurnSequence + index,
      )
    ) {
      return { kind: "stale", currentRun: structuredClone(run) };
    }
    this.turns.push(...turns);
    run.activeTurnIds = turns.map((turn) => turn.id);
    run.nextTurnSequence += turns.length;
    run.phase = input.nextPhase;
    run.revision = input.nextRevision;
    run.version += 1;
    run.updatedAt = this.clock.nowIso();
    return { kind: "scheduled", run: structuredClone(run), turns: structuredClone(turns) };
  }

  async beginAttempt(input: BeginAttemptInput): Promise<BeginAttemptResult> {
    const run = this.runs.get(input.runId);
    const turn = this.findTurn(input.turnId);
    if (!run || !turn) return { kind: "not_found" };
    if (
      run.status !== "running" ||
      !activeTurnIdsFor(run).includes(turn.id) ||
      turn.status !== "scheduled"
    ) {
      return { kind: "stale" };
    }
    const attempt = structuredClone(input.attempt);
    this.attempts.push(attempt);
    turn.status = "running";
    turn.activeAttemptId = attempt.id;
    turn.attemptCount += 1;
    turn.startedAt ??= this.clock.nowIso();
    run.version += 1;
    return { kind: "started", run: structuredClone(run), turn: structuredClone(turn) };
  }

  async attachAgentRun(input: {
    attemptId: CoordinationAttemptId;
    leaseToken: string;
    agentRunId: AgentRunId;
  }): Promise<"attached" | "stale"> {
    const attempt = this.findAttempt(input.attemptId);
    const turn = attempt ? this.findTurn(attempt.turnId) : undefined;
    if (
      !attempt ||
      !turn ||
      attempt.leaseToken !== input.leaseToken ||
      attempt.status !== "running" ||
      turn.activeAttemptId !== attempt.id
    ) {
      return "stale";
    }
    attempt.agentRunId = input.agentRunId;
    return "attached";
  }

  async commitAcceptedArtifact(
    input: CommitAcceptedArtifactInput,
  ): Promise<CommitAcceptedArtifactResult> {
    const run = this.runs.get(input.runId);
    const turn = this.findTurn(input.turnId);
    const attempt = this.findAttempt(input.attemptId);
    if (!run || !turn || !attempt) return { kind: "not_found" };
    if (
      run.status !== "running" ||
      !activeTurnIdsFor(run).includes(turn.id) ||
      turn.status !== "running" ||
      turn.activeAttemptId !== attempt.id ||
      attempt.status !== "running" ||
      attempt.leaseToken !== input.leaseToken
    ) {
      return { kind: "stale" };
    }

    const artifact = structuredClone(input.artifact);
    if (artifact.type === "session_message") {
      artifact.transcriptSequence = this.nextTranscriptSequence(run.id);
    }
    let nextExpectedNumber: number | undefined;
    if (
      artifact.type === "session_message" &&
      run.policy.workflow === "shared_session_v1" &&
      run.policy.sessionProtocol === "countdown"
    ) {
      const value = Number(artifact.payload.content);
      if (!Number.isInteger(value) || !run.sharedState) {
        return { kind: "stale" };
      }
      nextExpectedNumber = value - 1;
    }
    this.artifacts.push(artifact);
    attempt.status = "succeeded";
    attempt.finishedAt = this.clock.nowIso();
    turn.status = "committed";
    turn.outputArtifactId = artifact.id;
    turn.completedAt = this.clock.nowIso();
    delete turn.activeAttemptId;
    run.activeTurnIds = activeTurnIdsFor(run).filter((id) => id !== turn.id);
    if (artifact.type === "proposal") run.latestProposalArtifactId = artifact.id;
    if (artifact.type === "review") run.latestReviewArtifactId = artifact.id;
    if (nextExpectedNumber !== undefined && run.sharedState) {
      run.sharedState.nextExpectedNumber = nextExpectedNumber;
    }
    run.version += 1;
    run.updatedAt = this.clock.nowIso();
    return {
      kind: "committed",
      run: structuredClone(run),
      turn: structuredClone(turn),
      artifact: structuredClone(artifact),
    };
  }

  async finishAttempt(input: FinishAttemptInput): Promise<"finished" | "stale"> {
    const run = this.runs.get(input.runId);
    const turn = this.findTurn(input.turnId);
    const attempt = this.findAttempt(input.attemptId);
    if (
      !run ||
      !turn ||
      !attempt ||
      turn.activeAttemptId !== attempt.id ||
      attempt.status !== "running" ||
      attempt.leaseToken !== input.leaseToken
    ) {
      return "stale";
    }
    attempt.status = input.status;
    attempt.errorCode = input.errorCode;
    attempt.errorMessage = input.errorMessage;
    attempt.finishedAt = this.clock.nowIso();
    turn.lastValidationErrors = [...(input.validationErrors ?? [])];
    delete turn.activeAttemptId;
    if (input.status === "cancelled") {
      turn.status = "cancelled";
      turn.completedAt = this.clock.nowIso();
      run.activeTurnIds = activeTurnIdsFor(run).filter((id) => id !== turn.id);
    } else {
      turn.status = "scheduled";
    }
    run.version += 1;
    return "finished";
  }

  async requestStop(id: CoordinationRunId): Promise<CoordinationRun | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    if (run.status === "running") {
      run.status = "stop_requested";
      run.version += 1;
      run.updatedAt = this.clock.nowIso();
    }
    return structuredClone(run);
  }

  async finishStopped(id: CoordinationRunId): Promise<CoordinationRun | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    if (run.status === "stop_requested" || run.status === "running") {
      this.settleActiveWork(run, "cancelled");
      if (run.policy.workflow === "shared_session_v1") {
        run.status = "awaiting_input";
      } else {
        run.status = "stopped";
        run.errorCode = "STOPPED_BY_USER";
        run.stoppedAt = this.clock.nowIso();
      }
      run.version += 1;
      run.updatedAt = this.clock.nowIso();
    }
    return structuredClone(run);
  }

  async completeRun(input: {
    runId: CoordinationRunId;
    finalArtifactId: string;
  }): Promise<CoordinationRun | undefined> {
    const run = this.runs.get(input.runId);
    if (!run) return undefined;
    if (run.status !== "running") return structuredClone(run);
    run.status = "completed";
    run.phase = "done";
    run.finalArtifactId = input.finalArtifactId;
    run.completedAt = this.clock.nowIso();
    run.version += 1;
    run.updatedAt = this.clock.nowIso();
    return structuredClone(run);
  }

  async failRun(input: {
    runId: CoordinationRunId;
    code: CoordinationErrorCode;
    message: string;
  }): Promise<CoordinationRun | undefined> {
    const run = this.runs.get(input.runId);
    if (!run) return undefined;
    if (run.status === "completed" || run.status === "failed" || run.status === "stopped") {
      return structuredClone(run);
    }
    this.settleActiveWork(run, "failed");
    run.status = "failed";
    run.errorCode = input.code;
    run.errorMessage = input.message;
    run.failedAt = this.clock.nowIso();
    run.version += 1;
    run.updatedAt = this.clock.nowIso();
    return structuredClone(run);
  }

  async interruptActiveRuns(): Promise<CoordinationRunId[]> {
    return [];
  }

  async listNonTerminalRuns(): Promise<NonTerminalRunSummary[]> {
    const summaries: NonTerminalRunSummary[] = [];
    for (const run of this.runs.values()) {
      if (run.status !== "running" && run.status !== "stop_requested") continue;
      summaries.push({
        runId: run.id,
        status: run.status,
        activeTurnIds: activeTurnIdsFor(run),
        hasRunningAttempt: this.attempts.some(
          (attempt) => attempt.runId === run.id && attempt.status === "running",
        ),
      });
    }
    return summaries;
  }

  /**
   * Mirrors the durable command's decision table so in-memory workflow tests
   * exercise the same reconciliation semantics. Events are the durable
   * repository's concern, so none are recorded here.
   */
  async reconcileRun(input: {
    runId: CoordinationRunId;
    reason: string;
  }): Promise<ReconcileRunResult> {
    const run = this.runs.get(input.runId);
    if (!run) return { kind: "not_found" };
    if (run.status === "completed" || run.status === "failed" || run.status === "stopped") {
      return { kind: "terminal", run: structuredClone(run) };
    }
    if (run.status !== "running") {
      return { kind: "owned", run: structuredClone(run) };
    }
    if (activeTurnIdsFor(run).length === 0) {
      return { kind: "noop", run: structuredClone(run) };
    }
    this.settleActiveWork(run, "failed");
    run.version += 1;
    run.updatedAt = this.clock.nowIso();
    return { kind: "reconciled", run: structuredClone(run) };
  }

  private settleActiveWork(run: CoordinationRun, turnStatus: "failed" | "cancelled"): void {
    const turns = activeTurnIdsFor(run)
      .map((turnId) => this.findTurn(turnId))
      .flatMap((turn) => (turn ? [turn] : []));
    for (const turn of turns) {
      const attempt = turn.activeAttemptId ? this.findAttempt(turn.activeAttemptId) : undefined;
      if (attempt && attempt.status === "running") {
        attempt.status = "cancelled";
        attempt.finishedAt = this.clock.nowIso();
      }
      turn.status = turnStatus;
      turn.completedAt = this.clock.nowIso();
      delete turn.activeAttemptId;
    }
    run.activeTurnIds = [];
  }

  private findTurn(id: string): CoordinationTurn | undefined {
    return this.turns.find((turn) => turn.id === id);
  }

  private findAttempt(id: string): CoordinationAttempt | undefined {
    return this.attempts.find((attempt) => attempt.id === id);
  }

  private nextTranscriptSequence(runId: CoordinationRunId): number {
    return this.artifacts
      .filter((artifact) => artifact.runId === runId)
      .reduce((maximum, artifact) => Math.max(maximum, artifact.transcriptSequence ?? 0), 0) + 1;
  }
}

const activeTurnIdsFor = (run: CoordinationRun): string[] => {
  if (Array.isArray(run.activeTurnIds)) return [...run.activeTurnIds];
  const legacy = run as CoordinationRun & { activeTurnId?: string };
  return legacy.activeTurnId === undefined ? [] : [legacy.activeTurnId];
};

const ensureActiveTurnIds = (run: CoordinationRun): string[] => {
  if (!Array.isArray(run.activeTurnIds)) run.activeTurnIds = activeTurnIdsFor(run);
  return run.activeTurnIds;
};
