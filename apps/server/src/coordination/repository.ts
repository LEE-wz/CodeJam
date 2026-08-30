import type { JsonStore } from "../store.js";
import type { Database } from "../types.js";
import { createCoordinationEventFactory, materialiseEvent } from "./events.js";
import type { CoordinationEventDraft, CoordinationEventFactory } from "./events.js";
import type {
  BeginAttemptInput,
  BeginAttemptResult,
  Clock,
  CommitAcceptedArtifactInput,
  CommitAcceptedArtifactResult,
  CoordinationRepository,
  CreateRunRecordInput,
  FinishAttemptInput,
  IdGenerator,
  ScheduleTurnInput,
  ScheduleTurnResult,
  StartRunCommitResult,
} from "./contracts.js";
import type {
  AgentId,
  AgentRunId,
  CoordinationAttempt,
  CoordinationAttemptId,
  CoordinationErrorCode,
  CoordinationRun,
  CoordinationRunDetails,
  CoordinationRunId,
  CoordinationTurn,
} from "./types.js";

export type {
  BeginAttemptInput,
  BeginAttemptResult,
  CommitAcceptedArtifactInput,
  CommitAcceptedArtifactResult,
  CoordinationRepository,
  CreateRunRecordInput,
  FinishAttemptInput,
  ScheduleTurnInput,
  ScheduleTurnResult,
  StartRunCommitResult,
} from "./contracts.js";

/** Default cap for `listRuns`, per the frozen list contract. */
export const RUN_LIST_LIMIT = 50;

/** Coordination run statuses that reserve their participant Agents (Section 10.4). */
const ACTIVE_RUN_STATUSES = new Set<CoordinationRun["status"]>(["running", "stop_requested"]);

/** Ordinary Agent Run statuses that mean the Agent is still busy. */
const ACTIVE_AGENT_RUN_STATUSES = new Set(["queued", "running"]);

const TERMINAL_RUN_STATUSES = new Set<CoordinationRun["status"]>([
  "completed",
  "failed",
  "stopped",
]);

export interface DurableCoordinationRepositoryDependencies {
  store: JsonStore;
  clock: Clock;
  ids: IdGenerator;
  events?: CoordinationEventFactory;
}

/**
 * The durable coordination repository.
 *
 * Every command runs inside exactly one `JsonStore.mutate()` callback, which is
 * where all reading, checking, mutating, and event appending happen together
 * (overview Section 10.3). There is deliberately no read-check-write sequence
 * across separate store calls, because the store only serialises individual
 * mutations, not sequences of them.
 *
 * Expected races return a discriminated `stale`/`conflict` result rather than
 * throwing, and a losing caller never mutates run state - it only leaves an
 * `attempt.stale_ignored` event behind as evidence.
 *
 * Reads return deep copies, so a caller that wants current state must reload.
 */
export class DurableCoordinationRepository implements CoordinationRepository {
  private readonly store: JsonStore;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly events: CoordinationEventFactory;

  constructor(dependencies: DurableCoordinationRepositoryDependencies) {
    this.store = dependencies.store;
    this.clock = dependencies.clock;
    this.ids = dependencies.ids;
    this.events = dependencies.events ?? createCoordinationEventFactory();
  }

  // ---------------------------------------------------------------- reads

  async listRuns(limit: number = RUN_LIST_LIMIT): Promise<CoordinationRun[]> {
    const runs = this.store.snapshot().coordinationRuns;
    return runs
      .map((run, index) => ({ run, index }))
      .sort((left, right) => {
        const byCreatedAt = right.run.createdAt.localeCompare(left.run.createdAt);
        // Insertion order breaks ties, so equal timestamps stay deterministic.
        return byCreatedAt !== 0 ? byCreatedAt : right.index - left.index;
      })
      .slice(0, Math.max(0, limit))
      .map((entry) => entry.run);
  }

  async getRunDetails(id: CoordinationRunId): Promise<CoordinationRunDetails | undefined> {
    const database = this.store.snapshot();
    const run = database.coordinationRuns.find((candidate) => candidate.id === id);
    if (!run) {
      return undefined;
    }
    return buildRunDetails(database, run);
  }

  /**
   * Agent IDs reserved by a non-terminal coordination run (Section 10.4).
   * `AgentService` uses this to refuse an ordinary Playground turn on an Agent
   * that Relay is currently driving. There is no separate reservation table.
   */
  async listReservedAgentIds(): Promise<AgentId[]> {
    return [...collectReservedAgentIds(this.store.snapshot())];
  }

  async isAgentReserved(agentId: AgentId): Promise<boolean> {
    return collectReservedAgentIds(this.store.snapshot()).has(agentId);
  }

  // ------------------------------------------------------------- commands

  async createRun(input: CreateRunRecordInput): Promise<CoordinationRun> {
    return this.store.mutate((database) => {
      const existing = database.coordinationRuns.find(
        (candidate) => candidate.id === input.run.id,
      );
      // Creation is idempotent on the run ID so a retry cannot duplicate a run.
      if (existing) {
        return structuredClone(existing);
      }

      const run = structuredClone(input.run);
      database.coordinationRuns.push(run);
      this.append(
        database,
        this.events.runCreated({
          runId: run.id,
          name: run.name,
          workflow: run.policy.workflow,
          maxRevisions: run.policy.maxRevisions,
          maxTurns: run.policy.maxTurns,
          requiredSectionKeys: run.requiredSections.map((section) => section.key),
        }),
      );
      return structuredClone(run);
    });
  }

  async startRun(id: CoordinationRunId): Promise<StartRunCommitResult> {
    return this.store.mutate((database) => {
      const run = database.coordinationRuns.find((candidate) => candidate.id === id);
      if (!run) {
        return { kind: "not_found" } as const;
      }
      if (run.status !== "created") {
        return {
          kind: "conflict",
          code: "INVALID_STATE",
          message: "Coordination run is already active",
        } as const;
      }

      const agentIds = run.participants.map((participant) => participant.agentId);
      if (new Set(agentIds).size !== agentIds.length) {
        return {
          kind: "conflict",
          code: "INVALID_STATE",
          message: "Coordination run participants must be distinct Agents",
        } as const;
      }

      for (const agentId of agentIds) {
        const agent = database.agents.find((candidate) => candidate.id === agentId);
        if (!agent) {
          return {
            kind: "conflict",
            code: "AGENT_NOT_READY",
            message: "A participant Agent no longer exists",
          } as const;
        }
        if (agent.status !== "ready") {
          return {
            kind: "conflict",
            code: "AGENT_NOT_READY",
            message: `Agent "${agent.name}" is not ready`,
          } as const;
        }
      }

      // Reservations are derived, not stored: an Agent is reserved while it
      // appears in another non-terminal coordination run, or while it has an
      // ordinary Agent Run in flight.
      const reserved = collectReservedAgentIds(database, run.id);
      const reservedParticipant = agentIds.find((agentId) => reserved.has(agentId));
      if (reservedParticipant !== undefined) {
        return {
          kind: "conflict",
          code: "AGENT_RESERVED",
          message: "A participant Agent is reserved by another coordination run",
        } as const;
      }

      const busyParticipant = database.runs.find(
        (agentRun) =>
          agentIds.includes(agentRun.agentId) && ACTIVE_AGENT_RUN_STATUSES.has(agentRun.status),
      );
      if (busyParticipant) {
        return {
          kind: "conflict",
          code: "AGENT_RESERVED",
          message: "A participant Agent has an ordinary run in progress",
        } as const;
      }

      const now = this.clock.nowIso();
      run.status = "running";
      run.startedAt = now;
      run.updatedAt = now;
      run.version += 1;
      this.append(
        database,
        this.events.runStarted({ runId: run.id, participantAgentIds: agentIds }),
      );
      return { kind: "started", run: structuredClone(run) } as const;
    });
  }

  async scheduleTurn(input: ScheduleTurnInput): Promise<ScheduleTurnResult> {
    return this.store.mutate((database) => {
      const run = database.coordinationRuns.find((candidate) => candidate.id === input.runId);
      if (!run) {
        return { kind: "not_found" } as const;
      }
      if (
        run.status !== "running" ||
        run.activeTurnId !== undefined ||
        run.version !== input.expectedRunVersion
      ) {
        return { kind: "stale", currentRun: structuredClone(run) } as const;
      }

      const turn = structuredClone(input.turn);
      database.coordinationTurns.push(turn);
      run.activeTurnId = turn.id;
      run.nextTurnSequence += 1;
      run.phase = input.nextPhase;
      run.revision = input.nextRevision;
      run.version += 1;
      run.updatedAt = this.clock.nowIso();

      this.append(
        database,
        this.events.turnScheduled({
          runId: run.id,
          turnId: turn.id,
          sequence: turn.sequence,
          role: turn.role,
          agentId: turn.agentId,
          kind: turn.kind,
          phase: run.phase,
          revision: run.revision,
          expectedArtifactType: expectedArtifactTypeForTurn(turn),
          inputArtifactCount: turn.inputArtifactIds.length,
        }),
      );
      return {
        kind: "scheduled",
        run: structuredClone(run),
        turn: structuredClone(turn),
      } as const;
    });
  }

  async beginAttempt(input: BeginAttemptInput): Promise<BeginAttemptResult> {
    return this.store.mutate((database) => {
      const run = database.coordinationRuns.find((candidate) => candidate.id === input.runId);
      const turn = database.coordinationTurns.find((candidate) => candidate.id === input.turnId);
      if (!run || !turn) {
        return { kind: "not_found" } as const;
      }
      if (run.status !== "running" || turn.status !== "scheduled") {
        return { kind: "stale" } as const;
      }

      const attempt = structuredClone(input.attempt);
      database.coordinationAttempts.push(attempt);
      turn.status = "running";
      turn.activeAttemptId = attempt.id;
      turn.attemptCount += 1;
      turn.startedAt ??= this.clock.nowIso();
      run.version += 1;
      run.updatedAt = this.clock.nowIso();

      this.append(
        database,
        this.events.attemptStarted({
          runId: run.id,
          turnId: turn.id,
          attemptId: attempt.id,
          attemptNumber: attempt.number,
          role: turn.role,
          agentId: attempt.agentId,
          promptDigest: attempt.promptDigest ?? "",
          truncated: input.truncated ?? false,
          timeoutMs: run.policy.perAttemptTimeoutMs,
        }),
      );
      return {
        kind: "started",
        run: structuredClone(run),
        turn: structuredClone(turn),
      } as const;
    });
  }

  async attachAgentRun(input: {
    attemptId: CoordinationAttemptId;
    leaseToken: string;
    agentRunId: AgentRunId;
  }): Promise<"attached" | "stale"> {
    return this.store.mutate((database) => {
      const attempt = database.coordinationAttempts.find(
        (candidate) => candidate.id === input.attemptId,
      );
      const turn = attempt
        ? database.coordinationTurns.find((candidate) => candidate.id === attempt.turnId)
        : undefined;

      // Correlation attaches only to the attempt that still holds the lease, so
      // a superseded attempt can never claim a later Agent Run.
      if (
        !attempt ||
        !turn ||
        attempt.leaseToken !== input.leaseToken ||
        attempt.status !== "running" ||
        turn.activeAttemptId !== attempt.id
      ) {
        return "stale" as const;
      }

      attempt.agentRunId = input.agentRunId;

      // Stamp the additive v2 correlation onto the ordinary Agent Run so the
      // Playground row shows which coordination attempt produced it.
      const agentRun = database.runs.find((candidate) => candidate.id === input.agentRunId);
      if (agentRun) {
        agentRun.source = "coordination";
        agentRun.coordinationRunId = attempt.runId;
        agentRun.coordinationTurnId = attempt.turnId;
        agentRun.coordinationAttemptId = attempt.id;
      }
      return "attached" as const;
    });
  }

  async commitAcceptedArtifact(
    input: CommitAcceptedArtifactInput,
  ): Promise<CommitAcceptedArtifactResult> {
    return this.store.mutate((database) => {
      const run = database.coordinationRuns.find((candidate) => candidate.id === input.runId);
      const turn = database.coordinationTurns.find((candidate) => candidate.id === input.turnId);
      const attempt = database.coordinationAttempts.find(
        (candidate) => candidate.id === input.attemptId,
      );
      if (!run || !turn || !attempt) {
        return { kind: "not_found" } as const;
      }

      // Status, active pointers, and the opaque lease are checked together.
      // A stop between runtime success and commit lands here, and so does a
      // late result from a superseded attempt.
      if (
        run.status !== "running" ||
        run.activeTurnId !== turn.id ||
        turn.status !== "running" ||
        turn.activeAttemptId !== attempt.id ||
        attempt.status !== "running" ||
        attempt.leaseToken !== input.leaseToken
      ) {
        this.appendStaleIgnored(database, run, turn, attempt, "commit lost its lease");
        return { kind: "stale" } as const;
      }

      const now = this.clock.nowIso();
      const artifact = structuredClone(input.artifact);
      database.coordinationArtifacts.push(artifact);

      attempt.status = "succeeded";
      attempt.finishedAt = now;
      if (input.outputDigest !== undefined) {
        attempt.outputDigest = input.outputDigest;
      }

      turn.status = "committed";
      turn.outputArtifactId = artifact.id;
      turn.completedAt = now;
      turn.lastValidationErrors = [];
      delete turn.activeAttemptId;

      delete run.activeTurnId;
      if (artifact.type === "proposal") {
        run.latestProposalArtifactId = artifact.id;
      }
      if (artifact.type === "review") {
        run.latestReviewArtifactId = artifact.id;
      }
      run.version += 1;
      run.updatedAt = now;

      this.append(
        database,
        this.events.turnCommitted({
          runId: run.id,
          turnId: turn.id,
          attemptId: attempt.id,
          artifactId: artifact.id,
          sequence: turn.sequence,
          role: turn.role,
          agentId: attempt.agentId,
          artifactType: artifact.type,
          sizeChars: artifact.sizeChars,
          outputDigest: input.outputDigest ?? "",
        }),
      );

      if (artifact.type === "review") {
        this.append(
          database,
          this.events.reviewDecided({
            runId: run.id,
            turnId: turn.id,
            artifactId: artifact.id,
            agentId: attempt.agentId,
            decision: artifact.payload.decision,
            issueCount: artifact.payload.issues.length,
            issueCodes: artifact.payload.issues.map((issue) => issue.code),
            revision: run.revision,
          }),
        );
      }

      return {
        kind: "committed",
        run: structuredClone(run),
        turn: structuredClone(turn),
        artifact: structuredClone(artifact),
      } as const;
    });
  }

  async finishAttempt(input: FinishAttemptInput): Promise<"finished" | "stale"> {
    return this.store.mutate((database) => {
      const run = database.coordinationRuns.find((candidate) => candidate.id === input.runId);
      const turn = database.coordinationTurns.find((candidate) => candidate.id === input.turnId);
      const attempt = database.coordinationAttempts.find(
        (candidate) => candidate.id === input.attemptId,
      );
      if (!run || !turn || !attempt) {
        return "stale" as const;
      }
      if (
        turn.activeAttemptId !== attempt.id ||
        attempt.status !== "running" ||
        attempt.leaseToken !== input.leaseToken
      ) {
        this.appendStaleIgnored(database, run, turn, attempt, "result arrived after the lease ended");
        return "stale" as const;
      }

      const now = this.clock.nowIso();
      attempt.status = input.status;
      attempt.errorCode = input.errorCode;
      attempt.errorMessage = input.errorMessage;
      attempt.finishedAt = now;
      turn.lastValidationErrors = [...(input.validationErrors ?? [])];
      delete turn.activeAttemptId;

      if (input.status === "cancelled") {
        turn.status = "cancelled";
        turn.completedAt = now;
        delete run.activeTurnId;
      } else {
        // The turn stays schedulable so the service can retry within its ceiling.
        turn.status = "scheduled";
      }
      run.version += 1;
      run.updatedAt = now;

      this.append(database, this.attemptSettlementEvent(run, turn, attempt, input));
      return "finished" as const;
    });
  }

  async requestStop(id: CoordinationRunId): Promise<CoordinationRun | undefined> {
    return this.store.mutate((database) => {
      const run = database.coordinationRuns.find((candidate) => candidate.id === id);
      if (!run) {
        return undefined;
      }
      if (run.status === "running") {
        run.status = "stop_requested";
        run.version += 1;
        run.updatedAt = this.clock.nowIso();
        this.append(database, this.events.runStopRequested({ runId: run.id }));
      }
      return structuredClone(run);
    });
  }

  async finishStopped(id: CoordinationRunId): Promise<CoordinationRun | undefined> {
    return this.store.mutate((database) => {
      const run = database.coordinationRuns.find((candidate) => candidate.id === id);
      if (!run) {
        return undefined;
      }
      // A terminal run is immutable: stopping it again is a no-op, not an
      // overwrite of its recorded outcome.
      if (run.status !== "running" && run.status !== "stop_requested") {
        return structuredClone(run);
      }

      const now = this.clock.nowIso();
      this.settleActiveWork(database, run, "cancelled", "STOPPED_BY_USER", "run stopped by user");
      run.status = "stopped";
      run.errorCode = "STOPPED_BY_USER";
      run.stoppedAt = now;
      run.version += 1;
      run.updatedAt = now;
      this.append(database, this.events.runStopped({ runId: run.id, code: "STOPPED_BY_USER" }));
      return structuredClone(run);
    });
  }

  async completeRun(input: {
    runId: CoordinationRunId;
    finalArtifactId: string;
  }): Promise<CoordinationRun | undefined> {
    return this.store.mutate((database) => {
      const run = database.coordinationRuns.find((candidate) => candidate.id === input.runId);
      if (!run) {
        return undefined;
      }
      if (run.status !== "running") {
        return structuredClone(run);
      }

      const now = this.clock.nowIso();
      run.status = "completed";
      run.phase = "done";
      run.finalArtifactId = input.finalArtifactId;
      run.completedAt = now;
      run.version += 1;
      run.updatedAt = now;
      this.append(
        database,
        this.events.runCompleted({ runId: run.id, artifactId: input.finalArtifactId }),
      );
      return structuredClone(run);
    });
  }

  async failRun(input: {
    runId: CoordinationRunId;
    code: CoordinationErrorCode;
    message: string;
  }): Promise<CoordinationRun | undefined> {
    return this.store.mutate((database) => {
      const run = database.coordinationRuns.find((candidate) => candidate.id === input.runId);
      if (!run) {
        return undefined;
      }
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        return structuredClone(run);
      }

      const now = this.clock.nowIso();
      this.settleActiveWork(database, run, "failed", input.code, input.message);
      run.status = "failed";
      run.errorCode = input.code;
      run.errorMessage = input.message;
      run.failedAt = now;
      run.version += 1;
      run.updatedAt = now;
      this.append(
        database,
        this.events.runFailed({ runId: run.id, code: input.code, reason: input.message }),
      );
      return structuredClone(run);
    });
  }

  /**
   * Settle every coordination run left active by a crash or restart
   * (Section 10.5). The run becomes terminal, which is what releases its
   * derived Agent reservations; no background loop is resumed.
   */
  async interruptActiveRuns(): Promise<CoordinationRunId[]> {
    return this.store.mutate((database) => {
      const interrupted: CoordinationRunId[] = [];
      for (const run of database.coordinationRuns) {
        if (!ACTIVE_RUN_STATUSES.has(run.status)) {
          continue;
        }

        const now = this.clock.nowIso();
        this.append(
          database,
          this.events.runInterrupted({ runId: run.id, code: "SERVER_RESTARTED" }),
        );
        this.settleActiveWork(
          database,
          run,
          "failed",
          "SERVER_RESTARTED",
          "server restarted while the attempt was running",
        );
        run.status = "failed";
        run.errorCode = "SERVER_RESTARTED";
        run.errorMessage = "Server restarted while this run was active";
        run.failedAt = now;
        run.version += 1;
        run.updatedAt = now;
        this.append(
          database,
          this.events.runFailed({
            runId: run.id,
            code: "SERVER_RESTARTED",
            reason: "Server restarted while this run was active",
          }),
        );
        interrupted.push(run.id);
      }
      return interrupted;
    });
  }

  // -------------------------------------------------------------- helpers

  /** Cancel the active attempt and close the active turn of a run going terminal. */
  private settleActiveWork(
    database: Database,
    run: CoordinationRun,
    turnStatus: "failed" | "cancelled",
    code: CoordinationErrorCode,
    message: string,
  ): void {
    const turn = run.activeTurnId
      ? database.coordinationTurns.find((candidate) => candidate.id === run.activeTurnId)
      : undefined;

    if (turn) {
      const now = this.clock.nowIso();
      const attempt = turn.activeAttemptId
        ? database.coordinationAttempts.find((candidate) => candidate.id === turn.activeAttemptId)
        : undefined;

      if (attempt && attempt.status === "running") {
        attempt.status = "cancelled";
        attempt.errorCode = code;
        attempt.errorMessage = message;
        attempt.finishedAt = now;
        this.append(
          database,
          this.events.attemptCancelled({
            runId: run.id,
            turnId: turn.id,
            attemptId: attempt.id,
            attemptNumber: attempt.number,
            role: turn.role,
            agentId: attempt.agentId,
            code,
            reason: message,
          }),
        );
      }

      turn.status = turnStatus;
      turn.completedAt = now;
      delete turn.activeAttemptId;
    }
    delete run.activeTurnId;
  }

  private attemptSettlementEvent(
    run: CoordinationRun,
    turn: CoordinationTurn,
    attempt: CoordinationAttempt,
    input: FinishAttemptInput,
  ): CoordinationEventDraft {
    const base = {
      runId: run.id,
      turnId: turn.id,
      attemptId: attempt.id,
      attemptNumber: attempt.number,
      role: turn.role,
      agentId: attempt.agentId,
    };
    switch (input.status) {
      case "invalid_output":
        return this.events.attemptInvalidOutput({
          ...base,
          code: input.errorCode,
          validationErrors: input.validationErrors ?? [],
        });
      case "timed_out":
        return this.events.attemptTimedOut({
          ...base,
          timeoutMs: run.policy.perAttemptTimeoutMs,
        });
      case "cancelled":
        return this.events.attemptCancelled({
          ...base,
          code: input.errorCode,
          reason: input.errorMessage,
        });
      case "failed":
      default:
        return this.events.attemptFailed({
          ...base,
          code: input.errorCode,
          reason: input.errorMessage,
        });
    }
  }

  /**
   * The only write a losing caller is allowed to make. It records that a late
   * result arrived without touching artifact pointers, revision, phase, run
   * version, or a terminal outcome.
   */
  private appendStaleIgnored(
    database: Database,
    run: CoordinationRun,
    turn: CoordinationTurn,
    attempt: CoordinationAttempt,
    reason: string,
  ): void {
    this.append(
      database,
      this.events.attemptStaleIgnored({
        runId: run.id,
        turnId: turn.id,
        attemptId: attempt.id,
        attemptNumber: attempt.number,
        reason,
      }),
    );
  }

  /** Append an event with the next per-run sequence, inside the current mutation. */
  private append(database: Database, draft: CoordinationEventDraft): void {
    const highest = database.coordinationEvents.reduce(
      (maximum, event) => (event.runId === draft.runId ? Math.max(maximum, event.sequence) : maximum),
      0,
    );
    database.coordinationEvents.push(
      materialiseEvent(draft, {
        id: this.ids.eventId(),
        sequence: highest + 1,
        createdAt: this.clock.nowIso(),
      }),
    );
  }
}

// ------------------------------------------------------------ pure helpers

const collectReservedAgentIds = (
  database: Database,
  excludeRunId?: CoordinationRunId,
): Set<AgentId> => {
  const reserved = new Set<AgentId>();
  for (const run of database.coordinationRuns) {
    if (run.id === excludeRunId || !ACTIVE_RUN_STATUSES.has(run.status)) {
      continue;
    }
    for (const participant of run.participants) {
      reserved.add(participant.agentId);
    }
  }
  return reserved;
};

const expectedArtifactTypeForTurn = (turn: CoordinationTurn): "proposal" | "review" | "final" => {
  switch (turn.kind) {
    case "proposal_review":
      return "review";
    case "finalization":
      return "final";
    default:
      return "proposal";
  }
};

/**
 * Deterministic detail read model: turns by sequence, attempts by their turn's
 * sequence then attempt number, artifacts by their turn's sequence, events by
 * their per-run sequence. Nothing relies on array insertion order.
 */
const buildRunDetails = (database: Database, run: CoordinationRun): CoordinationRunDetails => {
  const turns = database.coordinationTurns
    .filter((turn) => turn.runId === run.id)
    .sort((left, right) => left.sequence - right.sequence);

  const turnSequence = new Map(turns.map((turn) => [turn.id, turn.sequence]));
  const sequenceOf = (turnId: string): number => turnSequence.get(turnId) ?? Number.MAX_SAFE_INTEGER;

  const attempts = database.coordinationAttempts
    .filter((attempt) => attempt.runId === run.id)
    .sort(
      (left, right) =>
        sequenceOf(left.turnId) - sequenceOf(right.turnId) || left.number - right.number,
    );

  const artifacts = database.coordinationArtifacts
    .filter((artifact) => artifact.runId === run.id)
    .sort(
      (left, right) =>
        sequenceOf(left.turnId) - sequenceOf(right.turnId) || left.id.localeCompare(right.id),
    );

  const events = database.coordinationEvents
    .filter((event) => event.runId === run.id)
    .sort((left, right) => left.sequence - right.sequence);

  return structuredClone({ run, turns, attempts, artifacts, events }) as CoordinationRunDetails;
};
