import type { JsonStore } from "../store.js";
import type { Database } from "../types.js";
import { createCoordinationEventFactory, materialiseEvent } from "./events.js";
import type { CoordinationEventDraft, CoordinationEventFactory } from "./events.js";
import type {
  BeginAttemptInput,
  BeginAttemptResult,
  AppendUserMessageInput,
  AppendUserMessageResult,
  Clock,
  CommitAcceptedArtifactInput,
  CommitAcceptedArtifactResult,
  CoordinationRepository,
  CoordinationReservationAdvisory,
  CreateRunRecordInput,
  FailTurnInput,
  FailTurnResult,
  FinishAttemptInput,
  IdGenerator,
  NonTerminalRunSummary,
  ReconcileRunResult,
  ScheduleTurnInput,
  ScheduleTurnResult,
  ScheduleTurnsInput,
  ScheduleTurnsResult,
  StartRunCommitResult,
} from "./contracts.js";
import type {
  AgentId,
  AgentRunId,
  ArtifactType,
  CoordinationArtifact,
  CoordinationAttempt,
  CoordinationAttemptId,
  CoordinationErrorCode,
  CoordinationRun,
  CoordinationRunDetails,
  CoordinationRunId,
  CoordinationTurn,
} from "./types.js";
import { aggregateRunUsage } from "./types.js";

export type {
  BeginAttemptInput,
  BeginAttemptResult,
  CommitAcceptedArtifactInput,
  CommitAcceptedArtifactResult,
  CoordinationRepository,
  CoordinationReservationAdvisory,
  CreateRunRecordInput,
  FailTurnInput,
  FailTurnResult,
  FinishAttemptInput,
  NonTerminalRunSummary,
  ReconcileRunResult,
  ScheduleTurnInput,
  ScheduleTurnResult,
  ScheduleTurnsInput,
  ScheduleTurnsResult,
  StartRunCommitResult,
} from "./contracts.js";

/** Default cap for `listRuns`, per the frozen list contract. */
export const RUN_LIST_LIMIT = 50;

/** Coordination run statuses that reserve their participant Agents (Section 10.4). */
const ACTIVE_RUN_STATUSES = new Set<CoordinationRun["status"]>(["running", "stop_requested"]);
const LIVE_ENROLMENT_STATUSES = new Set<CoordinationRun["status"]>([
  "running",
  "stop_requested",
  "awaiting_input",
]);

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
   * Agent IDs reserved by a non-terminal coordination run (Section 10.4, as
   * narrowed by the Session v2 decision recorded for P11-05). An Agent is
   * reserved while it has a **running attempt**, not merely while it appears in
   * a running run, so the idle participants of a live session stay usable in the
   * Playground. There is still no separate reservation table: the fact is
   * derived from attempt rows.
   */
  async listReservedAgentIds(): Promise<AgentId[]> {
    return [...collectReservedAgentIds(this.store.snapshot())];
  }

  async isAgentReserved(agentId: AgentId): Promise<boolean> {
    return collectReservedAgentIds(this.store.snapshot()).has(agentId);
  }

  async getReservingRunId(agentId: AgentId): Promise<CoordinationRunId | undefined> {
    return findReservingRunId(this.store.snapshot(), agentId);
  }

  /**
   * Display-only: which non-terminal run an Agent belongs to, whether or not it
   * currently holds a running attempt. `AgentService` uses it to name the
   * session in a refusal instead of saying "reserved by coordination". It
   * returns the run's id and name snapshot and nothing else.
   */
  async getReservingRunSummary(
    agentId: AgentId,
  ): Promise<CoordinationReservationAdvisory | undefined> {
    return findEnrollingRunSummary(this.store.snapshot(), agentId);
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

      // Admission is deliberately stricter than the attempt-level reservation
      // rule above (P11-05 decision record). Reserving per running attempt is
      // what keeps an idle participant usable in the Playground; it is not a
      // licence for two coordination state machines to drive one Agent, so
      // enrolment in another live run still refuses the start.
      const enrolled = collectEnrolledAgentIds(database, run.id);
      const reservedParticipant = agentIds.find((agentId) => enrolled.has(agentId));
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

  async appendUserMessage(input: AppendUserMessageInput): Promise<AppendUserMessageResult> {
    return this.store.mutate((database) => {
      const run = database.coordinationRuns.find((candidate) => candidate.id === input.runId);
      if (!run) return { kind: "not_found" } as const;
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        return { kind: "terminal", run: structuredClone(run) } as const;
      }
      if (run.policy.workflow !== "shared_session_v1") {
        return { kind: "conflict", run: structuredClone(run) } as const;
      }
      const lastUserArtifact = run.lastUserArtifactId
        ? database.coordinationArtifacts.find(
            (artifact) => artifact.id === run.lastUserArtifactId && artifact.type === "user_message",
          )
        : undefined;
      if (
        input.clientMessageId !== undefined &&
        lastUserArtifact?.type === "user_message" &&
        lastUserArtifact.clientMessageId === input.clientMessageId
      ) {
        return { kind: "duplicate", run: structuredClone(run) } as const;
      }
      if (run.status !== "created" && run.status !== "awaiting_input") {
        return { kind: "conflict", run: structuredClone(run) } as const;
      }

      if (run.status === "created") {
        const agentIds = run.participants.map((participant) => participant.agentId);
        if (new Set(agentIds).size !== agentIds.length) {
          return {
            kind: "conflict",
            run: structuredClone(run),
            code: "INVALID_STATE",
            message: "Session participants must be distinct Agents",
          } as const;
        }
        for (const agentId of agentIds) {
          const agent = database.agents.find((candidate) => candidate.id === agentId);
          if (!agent || agent.status !== "ready") {
            return {
              kind: "conflict",
              run: structuredClone(run),
              code: "AGENT_NOT_READY",
              message: agent
                ? `Agent "${agent.name}" is not ready`
                : "A participant Agent no longer exists",
            } as const;
          }
        }
        const enrolled = collectEnrolledAgentIds(database, run.id);
        if (agentIds.some((agentId) => enrolled.has(agentId))) {
          return {
            kind: "conflict",
            run: structuredClone(run),
            code: "AGENT_RESERVED",
            message: "A participant Agent is reserved by another coordination run",
          } as const;
        }
        if (
          database.runs.some(
            (agentRun) =>
              agentIds.includes(agentRun.agentId) && ACTIVE_AGENT_RUN_STATUSES.has(agentRun.status),
          )
        ) {
          return {
            kind: "conflict",
            run: structuredClone(run),
            code: "AGENT_RESERVED",
            message: "A participant Agent has an ordinary run in progress",
          } as const;
        }
      }

      const now = this.clock.nowIso();
      const transcriptSequence = nextTranscriptSequence(database, run.id);
      const artifact: CoordinationArtifact = {
        id: this.ids.artifactId(),
        runId: run.id,
        type: "user_message",
        payload: { schemaVersion: 1, type: "user_message", content: input.content.trim() },
        createdBy: { kind: "user" },
        ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
        transcriptSequence,
        sizeChars: input.content.trim().length,
        createdAt: now,
      };
      database.coordinationArtifacts.push(artifact);
      const wasCreated = run.status === "created";
      run.lastUserArtifactId = artifact.id;
      run.status = "running";
      run.startedAt ??= now;
      run.updatedAt = now;
      run.version += 1;
      if (wasCreated) {
        this.append(
          database,
          this.events.runStarted({
            runId: run.id,
            participantAgentIds: run.participants.map(({ agentId }) => agentId),
          }),
        );
      }
      this.append(
        database,
        this.events.userMessageAppended({ runId: run.id, artifactId: artifact.id, transcriptSequence }),
      );
      return {
        kind: "appended",
        run: structuredClone(run),
        artifact: structuredClone(artifact),
      } as const;
    });
  }

  async awaitInput(id: CoordinationRunId): Promise<CoordinationRun | undefined> {
    return this.store.mutate((database) => {
      const run = database.coordinationRuns.find((candidate) => candidate.id === id);
      if (!run) return undefined;
      if (run.status !== "running") return structuredClone(run);
      run.activeTurnIds = [];
      run.status = "awaiting_input";
      run.version += 1;
      run.updatedAt = this.clock.nowIso();
      this.append(database, this.events.runAwaitingInput({ runId: run.id }));
      return structuredClone(run);
    });
  }

  async endSession(id: CoordinationRunId): Promise<
    | { kind: "ended"; run: CoordinationRun }
    | { kind: "conflict"; run: CoordinationRun }
    | { kind: "not_found" }
  > {
    return this.store.mutate((database) => {
      const run = database.coordinationRuns.find((candidate) => candidate.id === id);
      if (!run) return { kind: "not_found" } as const;
      if (
        run.policy.workflow !== "shared_session_v1" ||
        (run.status !== "created" && run.status !== "awaiting_input")
      ) {
        return { kind: "conflict", run: structuredClone(run) } as const;
      }
      const now = this.clock.nowIso();
      const latest = latestCommittedSessionArtifact(database, run.id);
      run.status = "completed";
      run.phase = "done";
      run.endedByUser = true;
      if (latest) run.finalArtifactId = latest.id;
      run.completedAt = now;
      run.updatedAt = now;
      run.version += 1;
      this.append(
        database,
        this.events.runCompleted({
          runId: run.id,
          ...(latest ? { artifactId: latest.id, artifactType: latest.type } : {}),
        }),
      );
      return { kind: "ended", run: structuredClone(run) } as const;
    });
  }

  async scheduleTurn(input: ScheduleTurnInput): Promise<ScheduleTurnResult> {
    const result = await this.scheduleTurns({ ...input, turns: [input.turn] });
    if (result.kind !== "scheduled") return result;
    return { kind: "scheduled", run: result.run, turn: result.turns[0]! };
  }

  async scheduleTurns(input: ScheduleTurnsInput): Promise<ScheduleTurnsResult> {
    return this.store.mutate((database) => {
      const run = database.coordinationRuns.find((candidate) => candidate.id === input.runId);
      if (!run) {
        return { kind: "not_found" } as const;
      }
      if (
        run.status !== "running" ||
        run.activeTurnIds.length > 0 ||
        run.version !== input.expectedRunVersion ||
        input.turns.length === 0 ||
        input.turns.some((turn, index) =>
          turn.runId !== run.id ||
          turn.sequence !== run.nextTurnSequence + index ||
          input.turns.some((candidate, candidateIndex) =>
            candidateIndex !== index && candidate.id === turn.id,
          ),
        )
      ) {
        return { kind: "stale", currentRun: structuredClone(run) } as const;
      }

      const turns = structuredClone(input.turns);
      for (const turn of turns) turn.wavePurpose ??= "session_execution";
      database.coordinationTurns.push(...turns);
      run.activeTurnIds = turns.map((turn) => turn.id);
      run.nextTurnSequence += turns.length;
      run.phase = input.nextPhase;
      run.revision = input.nextRevision;
      run.version += 1;
      run.updatedAt = this.clock.nowIso();

      for (const turn of turns) {
        this.append(database, this.events.turnScheduled({
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
          ...(turn.wavePurpose === undefined ? {} : { wavePurpose: turn.wavePurpose }),
          ...(turns.length > 1 ? { waveSize: turns.length } : {}),
        }));
      }
      return {
        kind: "scheduled",
        run: structuredClone(run),
        turns: structuredClone(turns),
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
        !run.activeTurnIds.includes(turn.id) ||
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
      if (artifact.type === "session_message") {
        artifact.transcriptSequence = nextTranscriptSequence(database, run.id);
      }

      // A countdown commit carries the next durable value forward in this same
      // mutation as the artifact, attempt, turn, and event. The protocol has
      // already checked the exact expected value; this defensive check keeps a
      // malformed direct repository call from corrupting shared state.
      const nextExpectedNumber = nextCountdownValue(run, artifact);
      if (nextExpectedNumber === "invalid") {
        return { kind: "stale" } as const;
      }
      database.coordinationArtifacts.push(artifact);

      attempt.status = "succeeded";
      attempt.finishedAt = now;
      if (input.usage !== undefined) attempt.usage = input.usage;
      if (input.outputDigest !== undefined) {
        attempt.outputDigest = input.outputDigest;
      }

      turn.status = "committed";
      turn.outputArtifactId = artifact.id;
      turn.completedAt = now;
      turn.lastValidationErrors = [];
      delete turn.activeAttemptId;

      run.activeTurnIds = run.activeTurnIds.filter((id) => id !== turn.id);
      if (artifact.type === "proposal") {
        run.latestProposalArtifactId = artifact.id;
      }
      if (artifact.type === "review") {
        run.latestReviewArtifactId = artifact.id;
      }
      if (typeof nextExpectedNumber === "number" && run.sharedState) {
        run.sharedState.nextExpectedNumber = nextExpectedNumber;
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
      if (input.usage !== undefined) attempt.usage = input.usage;
      turn.lastValidationErrors = [...(input.validationErrors ?? [])];
      delete turn.activeAttemptId;

      if (input.status === "cancelled") {
        turn.status = "cancelled";
        turn.completedAt = now;
        run.activeTurnIds = run.activeTurnIds.filter((id) => id !== turn.id);
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

  /**
   * Retire one member of a live wave (PA13-12).
   *
   * Only this turn is touched: siblings keep their leases, the run keeps its
   * status, and no terminal pointer moves. A running attempt on this turn is
   * cancelled in the same mutation so no attempt is left durably `running`, and
   * the reservation invariant therefore holds the moment this returns.
   */
  async failTurn(input: FailTurnInput): Promise<FailTurnResult> {
    return this.store.mutate((database) => {
      const run = database.coordinationRuns.find((candidate) => candidate.id === input.runId);
      const turn = database.coordinationTurns.find((candidate) => candidate.id === input.turnId);
      if (!run || !turn) {
        return { kind: "not_found" } as const;
      }
      if (
        run.status !== "running" ||
        !run.activeTurnIds.includes(turn.id) ||
        turn.status === "committed" ||
        turn.status === "failed" ||
        turn.status === "cancelled"
      ) {
        return { kind: "stale" } as const;
      }

      const now = this.clock.nowIso();
      const attempt = turn.activeAttemptId
        ? database.coordinationAttempts.find(
            (candidate) => candidate.id === turn.activeAttemptId,
          )
        : undefined;
      if (attempt && attempt.status === "running") {
        attempt.status = "cancelled";
        attempt.errorCode = input.code;
        attempt.errorMessage = input.message;
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
            code: input.code,
            reason: input.message,
          }),
        );
      }

      turn.status = "failed";
      turn.completedAt = now;
      delete turn.activeAttemptId;
      run.activeTurnIds = run.activeTurnIds.filter((id) => id !== turn.id);
      run.version += 1;
      run.updatedAt = now;

      this.append(
        database,
        this.events.turnFailed({
          runId: run.id,
          turnId: turn.id,
          sequence: turn.sequence,
          role: turn.role,
          agentId: turn.agentId,
          code: input.code,
          reason: input.message,
        }),
      );
      return {
        kind: "failed",
        run: structuredClone(run),
        turn: structuredClone(turn),
      } as const;
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
      if (run.policy.workflow === "shared_session_v1") {
        run.status = "awaiting_input";
        delete run.errorCode;
        delete run.errorMessage;
      } else {
        run.status = "stopped";
        run.errorCode = "STOPPED_BY_USER";
        run.stoppedAt = now;
      }
      run.version += 1;
      run.updatedAt = now;
      this.append(
        database,
        run.status === "awaiting_input"
          ? this.events.runAwaitingInput({ runId: run.id })
          : this.events.runStopped({ runId: run.id, code: "STOPPED_BY_USER" }),
      );
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
      const finalArtifact = database.coordinationArtifacts.find(
        (artifact) => artifact.id === input.finalArtifactId && artifact.runId === run.id,
      );
      run.status = "completed";
      run.phase = "done";
      run.finalArtifactId = input.finalArtifactId;
      run.completedAt = now;
      run.version += 1;
      run.updatedAt = now;
      this.append(
        database,
        this.events.runCompleted({
          runId: run.id,
          artifactId: input.finalArtifactId,
          artifactType: finalArtifact?.type,
        }),
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
   * Settle every coordination run left active by a crash or restart.
   * Verified handoffs fail terminally; shared sessions return to durable idle
   * so their committed transcript can be resumed. Either path releases every
   * attempt-derived Agent reservation and no loop is resumed automatically.
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
        if (run.policy.workflow === "shared_session_v1") {
          run.status = "awaiting_input";
          delete run.errorCode;
          delete run.errorMessage;
          this.append(database, this.events.runAwaitingInput({ runId: run.id }));
        } else {
          run.status = "failed";
          run.errorCode = "SERVER_RESTARTED";
          run.errorMessage = "Server restarted while this run was active";
          run.failedAt = now;
        }
        run.version += 1;
        run.updatedAt = now;
        if (run.status === "failed") {
          this.append(
            database,
            this.events.runFailed({
              runId: run.id,
              code: "SERVER_RESTARTED",
              reason: "Server restarted while this run was active",
            }),
          );
        }
        interrupted.push(run.id);
      }
      return interrupted;
    });
  }

  /**
   * Every run that still needs an owner, with the two facts a reconciler needs:
   * the turns the run points at, and whether any of its attempts is still
   * durably `running` (P11-04). `created` runs are excluded: nothing is
   * orchestrating them, so nothing can have stranded them.
   */
  async listNonTerminalRuns(): Promise<NonTerminalRunSummary[]> {
    const database = this.store.snapshot();
    const runIdsWithRunningAttempt = new Set(
      database.coordinationAttempts
        .filter((attempt) => attempt.status === "running")
        .map((attempt) => attempt.runId),
    );
    return database.coordinationRuns
      .filter((run) => ACTIVE_RUN_STATUSES.has(run.status))
      .map((run) => ({
        runId: run.id,
        status: run.status as "running" | "stop_requested",
        activeTurnIds: [...run.activeTurnIds],
        hasRunningAttempt: runIdsWithRunningAttempt.has(run.id),
      }));
  }

  /**
   * Settle a stranded turn and attempt so an abandoned run stays schedulable
   * (P11-04).
   *
   * Everything happens in one `JsonStore.mutate()`, exactly like every other
   * command: there is no read-check-write across store calls. The settlement
   * itself reuses `settleActiveWork`, so a reconciled turn and attempt close the
   * same way they do when a run goes terminal — the difference is only that the
   * run itself stays `running`.
   *
   * The command decides nothing about ownership. A caller must already know the
   * run has no live loop; `CoordinationService` decides that from its
   * `activeLoops` map. Statuses other than `running` are refused here:
   * `completed`/`failed`/`stopped` are immutable, `stop_requested` belongs to
   * the stop path, and `created` has no orchestration to reconcile.
   *
   * Idempotent: a run with no `activeTurnIds` returns `noop` without appending an
   * event or bumping the version, so running this twice changes nothing.
   */
  async reconcileRun(input: {
    runId: CoordinationRunId;
    reason: string;
  }): Promise<ReconcileRunResult> {
    return this.store.mutate((database) => {
      const run = database.coordinationRuns.find((candidate) => candidate.id === input.runId);
      if (!run) {
        return { kind: "not_found" } as const;
      }
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        return { kind: "terminal", run: structuredClone(run) } as const;
      }
      if (run.status !== "running") {
        return { kind: "owned", run: structuredClone(run) } as const;
      }
      if (run.activeTurnIds.length === 0) {
        return { kind: "noop", run: structuredClone(run) } as const;
      }

      const [turnId] = run.activeTurnIds;
      if (turnId === undefined) {
        return { kind: "noop", run: structuredClone(run) } as const;
      }
      this.settleActiveWork(
        database,
        run,
        "failed",
        "RUN_ABANDONED",
        "orchestration exited without settling this turn",
      );
      run.version += 1;
      run.updatedAt = this.clock.nowIso();
      this.append(
        database,
        this.events.runReconciled({
          runId: run.id,
          turnId,
          code: "RUN_ABANDONED",
          reason: input.reason,
        }),
      );
      return { kind: "reconciled", run: structuredClone(run) } as const;
    });
  }

  // -------------------------------------------------------------- helpers

  /** Cancel active attempts and close every active turn of a run going terminal. */
  private settleActiveWork(
    database: Database,
    run: CoordinationRun,
    turnStatus: "failed" | "cancelled",
    code: CoordinationErrorCode,
    message: string,
  ): void {
    for (const turnId of run.activeTurnIds) {
      const turn = database.coordinationTurns.find((candidate) => candidate.id === turnId);
      if (!turn) continue;
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
    run.activeTurnIds = [];
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

/**
 * Agents that are genuinely mid-attempt: they hold a `running` attempt inside a
 * non-terminal run (P11-05). This is the rule that refuses a Playground turn or
 * an Agent mutation. It is deliberately narrower than enrolment, so an idle
 * participant of a live session is not treated as busy.
 *
 * Exported so `AgentService` enforces the identical rule rather than its own
 * copy of a similar one.
 */
export const collectReservedAgentIds = (
  database: Database,
  excludeRunId?: CoordinationRunId,
): Set<AgentId> => {
  const activeRunIds = new Set<CoordinationRunId>();
  for (const run of database.coordinationRuns) {
    if (run.id !== excludeRunId && ACTIVE_RUN_STATUSES.has(run.status)) {
      activeRunIds.add(run.id);
    }
  }

  const reserved = new Set<AgentId>();
  for (const attempt of database.coordinationAttempts) {
    if (attempt.status === "running" && activeRunIds.has(attempt.runId)) {
      reserved.add(attempt.agentId);
    }
  }
  return reserved;
};

/**
 * Agents enrolled as participants of a non-terminal run, whether or not they
 * are mid-attempt. This is the admission rule `startRun` uses: it keeps two
 * coordination state machines from claiming one Agent, which reserving per
 * running attempt alone would not prevent.
 */
export const collectEnrolledAgentIds = (
  database: Database,
  excludeRunId?: CoordinationRunId,
): Set<AgentId> => {
  const enrolled = new Set<AgentId>();
  for (const run of database.coordinationRuns) {
    if (run.id === excludeRunId || !LIVE_ENROLMENT_STATUSES.has(run.status)) {
      continue;
    }
    for (const participant of run.participants) {
      enrolled.add(participant.agentId);
    }
  }
  return enrolled;
};

/** The non-terminal run in which this Agent currently holds a running attempt. */
export const findReservingRunId = (
  database: Database,
  agentId: AgentId,
): CoordinationRunId | undefined => {
  const activeRunIds = new Set(
    database.coordinationRuns
      .filter((run) => ACTIVE_RUN_STATUSES.has(run.status))
      .map((run) => run.id),
  );
  return database.coordinationAttempts.find(
    (attempt) =>
      attempt.agentId === agentId &&
      attempt.status === "running" &&
      activeRunIds.has(attempt.runId),
  )?.runId;
};

/**
 * Display-only: the non-terminal run this Agent is enrolled in, with its name
 * snapshot, so a refusal can say which session is responsible. Never returns a
 * lease, prompt, turn, or attempt.
 */
export const findEnrollingRunSummary = (
  database: Database,
  agentId: AgentId,
): CoordinationReservationAdvisory | undefined => {
  const run = database.coordinationRuns.find(
    (candidate) =>
      LIVE_ENROLMENT_STATUSES.has(candidate.status) &&
      candidate.participants.some((participant) => participant.agentId === agentId),
  );
  return run ? { runId: run.id, name: run.name } : undefined;
};

/**
 * A turn's output type is backend-owned. `satisfies` makes this deliberately
 * exhaustive: adding a new turn kind without deciding its durable output is a
 * compile error rather than a silent fallthrough to a proposal.
 */
const EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND = {
  initial_proposal: "proposal",
  proposal_revision: "proposal",
  proposal_review: "review",
  finalization: "final",
  session_turn: "session_message",
  session_bid: "session_bid",
} as const satisfies Readonly<Record<CoordinationTurn["kind"], ArtifactType>>;

const expectedArtifactTypeForTurn = (turn: CoordinationTurn): ArtifactType =>
  EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND[turn.kind];

/**
 * Returns the state update that belongs in a successful countdown commit.
 * `undefined` means this is not a countdown session; `invalid` is never
 * persisted and leaves the active lease untouched for ordinary validation.
 */
const nextCountdownValue = (
  run: CoordinationRun,
  artifact: CoordinationArtifact,
): number | undefined | "invalid" => {
  if (
    artifact.type !== "session_message" ||
    run.policy.workflow !== "shared_session_v1" ||
    run.policy.sessionProtocol !== "countdown"
  ) {
    return undefined;
  }

  const value = Number(artifact.payload.content);
  return Number.isInteger(value) && run.sharedState ? value - 1 : "invalid";
};

const nextTranscriptSequence = (database: Database, runId: CoordinationRunId): number =>
  database.coordinationArtifacts
    .filter((artifact) => artifact.runId === runId)
    .reduce((maximum, artifact) => Math.max(maximum, artifact.transcriptSequence ?? 0), 0) + 1;

const latestCommittedSessionArtifact = (
  database: Database,
  runId: CoordinationRunId,
): Extract<CoordinationArtifact, { type: "session_message" }> | undefined =>
  database.coordinationArtifacts
    .filter(
      (artifact): artifact is Extract<CoordinationArtifact, { type: "session_message" }> =>
        artifact.runId === runId && artifact.type === "session_message",
    )
    .sort(
      (left, right) =>
        (right.transcriptSequence ?? 0) - (left.transcriptSequence ?? 0) ||
        right.createdAt.localeCompare(left.createdAt),
    )[0];

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
      (left, right) => {
        const leftTranscript = left.transcriptSequence;
        const rightTranscript = right.transcriptSequence;
        if (leftTranscript !== undefined || rightTranscript !== undefined) {
          return (
            (leftTranscript ?? Number.MIN_SAFE_INTEGER) -
              (rightTranscript ?? Number.MIN_SAFE_INTEGER) ||
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id)
          );
        }
        return (
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id)
        );
      },
    );

  const events = database.coordinationEvents
    .filter((event) => event.runId === run.id)
    .sort((left, right) => left.sequence - right.sequence);

  return structuredClone({
    run,
    turns,
    attempts,
    usageTotals: aggregateRunUsage(attempts),
    artifacts,
    events,
  }) as CoordinationRunDetails;
};
