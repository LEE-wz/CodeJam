import type {
  ArtifactProtocol,
  Clock,
  ContextBuilder,
  CoordinationAgentDirectory,
  CoordinationRepository,
  CoordinationRuntime,
  CoordinationServiceContract,
  CoordinationWorkflowDispatch,
  IdGenerator,
  SharedSessionWorkflow,
  VerifiedHandoffWorkflow,
  WorkflowDecision,
} from "./contracts.js";
import { createHash } from "node:crypto";
import { CoordinationError } from "./errors.js";
import { ARTIFACT_SCHEMA_LIMITS, SECTION_KEY_PATTERN } from "./schemas.js";
import {
  DEFAULT_COORDINATION_POLICY,
  type AppendUserMessageRequest,
  type CoordinationAttempt,
  type CoordinationErrorCode,
  type CoordinationRun,
  type CoordinationRunDetails,
  type CoordinationRunId,
  type CoordinationTurn,
  SESSION_CONTEXT_MAX_CHARS,
  SESSION_LIMITS,
  type CoordinationParticipant,
  type CreateCoordinationRunRequest,
  type CreateRunRequest,
  type CreateSessionRunRequest,
  type RequiredSection,
} from "./types.js";

const terminalStatuses = new Set(["completed", "failed", "stopped"]);

/**
 * Internal bounds on the validator/runtime feedback replayed into a retry prompt
 * (overview Section 11.3). These are prompt-construction limits, not part of the
 * frozen artifact contract: the context builder still enforces the run's context
 * cap on top of them.
 */
const RETRY_FEEDBACK_MAX_ITEMS = 10;
const RETRY_FEEDBACK_MAX_CHARS = 500;

/**
 * Keeps retry feedback concise and reflective of the most recent failure only.
 * Feedback never carries raw Agent output: validator messages are backend-authored
 * and runtime messages are already mapped to safe text by the runtime gateway.
 */
const boundedRetryFeedback = (messages: string[]): string[] =>
  messages
    .map((message) => message.trim())
    .filter((message) => message.length > 0)
    .slice(0, RETRY_FEEDBACK_MAX_ITEMS)
    .map((message) =>
      message.length > RETRY_FEEDBACK_MAX_CHARS
        ? message.slice(0, RETRY_FEEDBACK_MAX_CHARS)
        : message,
    );

const isTerminal = (status: CoordinationRun["status"]): boolean =>
  terminalStatuses.has(status);

/**
 * How many consecutive loop-exit reconciliations one run may take without
 * committing a turn before it is failed as abandoned (P11-03). Every known
 * stale path is resumable, so reaching this bound means reconciliation is not
 * making progress and the run must be failed rather than left to spin.
 */
const MAX_CONSECUTIVE_RECONCILIATIONS = 3;

/** Default period of the background reconciliation sweep (P11-06). */
export const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

/**
 * What one scheduled turn did to the run, as the loop needs to see it.
 *
 * `committed` means the turn produced a durable artifact. `settled` means a
 * terminal repository call was made, or the run is no longer `running` and some
 * other actor owns its next transition. `abandoned` is the P11-01 class: the
 * turn exited without a terminal call while the run may still be `running`, so
 * the loop must reconcile before it may continue or stop.
 */
type TurnExecutionOutcome = "committed" | "settled" | "abandoned";

/**
 * Structured coordination log fields. Only identifiers, enum values, counts, and
 * digests are permitted: never a prompt, raw output, or lease token.
 */
export interface CoordinationLogContext {
  runId: CoordinationRunId;
  turnId?: string;
  attemptId?: string;
  role?: string;
  agentId?: string;
  sequence?: number;
  attemptNumber?: number;
  status?: string;
  code?: string;
  artifactType?: string;
  promptDigest?: string;
  outputDigest?: string;
  truncated?: boolean;
}

export interface CoordinationLogger {
  info?(context: CoordinationLogContext, message: string): void;
  error(context: CoordinationLogContext, message: string): void;
}

/**
 * Digest of the raw Agent output, written to `attempt.outputDigest` on commit
 * per the confirmed handoff decision 1.3. The output itself is never stored.
 */
const digestOutput = (rawOutput: string): string =>
  "sha256:" + createHash("sha256").update(rawOutput, "utf8").digest("hex");

interface CoordinationServiceDependencies {
  agentDirectory: CoordinationAgentDirectory;
  repository: CoordinationRepository;
  workflow: VerifiedHandoffWorkflow;
  /**
   * Registered when the shared-session workflow is available. Optional so every
   * existing composition and test that only runs verified handoffs keeps
   * working unchanged.
   */
  sessionWorkflow?: SharedSessionWorkflow | undefined;
  contextBuilder: ContextBuilder;
  artifactProtocol: ArtifactProtocol;
  runtime: CoordinationRuntime;
  clock: Clock;
  ids: IdGenerator;
  logger?: CoordinationLogger | undefined;
  /**
   * Period of the background reconciliation sweep (P11-06). Omitted means
   * `DEFAULT_RECONCILE_INTERVAL_MS`; `0` disables the timer entirely, which is
   * how tests keep reconciliation deterministic — they call
   * `reconcileUnownedRuns()` directly instead of waiting for a tick.
   */
  reconcileIntervalMs?: number | undefined;
}

/** Durable workflow selector shared by the service loop and pure dispatch tests. */
export class CoordinationWorkflowDispatchV1 implements CoordinationWorkflowDispatch {
  constructor(
    private readonly verifiedWorkflow: VerifiedHandoffWorkflow,
    private readonly sessionWorkflow?: SharedSessionWorkflow | undefined,
  ) {}

  forRun(run: CoordinationRun): ReturnType<CoordinationWorkflowDispatch["forRun"]> {
    if (run.policy.workflow === "shared_session_v1") {
      if (!this.sessionWorkflow) {
        throw new CoordinationError(
          500,
          "INTERNAL_ERROR",
          "Shared session workflow is not registered",
        );
      }
      return this.sessionWorkflow;
    }
    return this.verifiedWorkflow;
  }
}

/**
 * Owns coordination-run lifecycle and orchestration. Durable transitions belong
 * to the repository; routing, validation, context construction, and invocation
 * remain injectable components so they can be developed and tested separately.
 */
export class CoordinationService implements CoordinationServiceContract {
  private readonly activeLoops = new Map<CoordinationRunId, Promise<void>>();
  private readonly loopEpochs = new Map<CoordinationRunId, number>();
  private readonly workflowDispatch: CoordinationWorkflowDispatch;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly dependencies: CoordinationServiceDependencies) {
    this.workflowDispatch = new CoordinationWorkflowDispatchV1(
      dependencies.workflow,
      dependencies.sessionWorkflow,
    );
  }

  async initialize(): Promise<void> {
    await this.dependencies.repository.interruptActiveRuns();
    // Interruption settles everything it finds, so on a healthy boot this pass
    // is a no-op. It exists so a run left non-terminal by any path — now or
    // later — still ends up owned rather than stranded with its Agents held.
    await this.reconcileUnownedRuns();
    this.startReconcileSweep();
  }

  /** Stops the background sweep. Safe to call more than once. */
  async shutdown(): Promise<void> {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /**
   * Reconcile every non-terminal run that no live loop owns (P11-06).
   *
   * Ownership is decided by the `activeLoops` map plus durable attempt status,
   * never by elapsed time: a run with a live loop is skipped outright, so the
   * sweep can never settle work that is actually in flight. On a healthy system
   * every `running` run has a loop, and this returns an empty list.
   */
  async reconcileUnownedRuns(): Promise<CoordinationRunId[]> {
    const candidates = await this.dependencies.repository.listNonTerminalRuns();
    const reconciled: CoordinationRunId[] = [];

    for (const candidate of candidates) {
      if (this.activeLoops.has(candidate.runId)) {
        continue;
      }
      try {
        if (candidate.status === "stop_requested") {
          // The stop path owns this run, but no loop and no in-flight request
          // is left to finish it. `finishStopped` is idempotent and is exactly
          // the transition `stopRun` makes next, so completing it here is safe
          // even if a stop request is still in flight.
          await this.dependencies.repository.finishStopped(candidate.runId);
          reconciled.push(candidate.runId);
          continue;
        }

        const result = await this.dependencies.repository.reconcileRun({
          runId: candidate.runId,
          reason: candidate.hasRunningAttempt
            ? "no orchestration loop owned this run while an attempt was running"
            : "no orchestration loop owned this run",
        });
        if (result.kind !== "reconciled" && result.kind !== "noop") {
          continue;
        }
        reconciled.push(candidate.runId);
        this.log({ runId: candidate.runId, status: result.kind }, "Coordination run reconciled");
        // The run is schedulable again but nothing is driving it. Give it a
        // loop; the decision source re-derives the next turn from durable state.
        this.startLoop(candidate.runId);
      } catch {
        // One unreconcilable run must not stop the sweep for the others.
        this.dependencies.logger?.error(
          { runId: candidate.runId },
          "Coordination reconciliation failed",
        );
      }
    }
    return reconciled;
  }

  private startReconcileSweep(): void {
    const intervalMs = this.dependencies.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || this.sweepTimer !== undefined) {
      return;
    }
    const timer = setInterval(() => {
      void this.reconcileUnownedRuns().catch(() => undefined);
    }, intervalMs);
    // The sweep must never be the reason a process refuses to exit.
    timer.unref?.();
    this.sweepTimer = timer;
  }

  async listRuns(): Promise<CoordinationRun[]> {
    return this.dependencies.repository.listRuns(50);
  }

  async getRun(id: CoordinationRunId): Promise<CoordinationRunDetails | undefined> {
    return this.dependencies.repository.getRunDetails(id);
  }

  async createRun(input: CreateRunRequest): Promise<CoordinationRun> {
    return input.workflow === "shared_session_v1"
      ? this.createSessionRun(input)
      : this.createVerifiedRun(input);
  }

  /** Validates and snapshots the complete shared-session create contract. */
  private async createSessionRun(
    input: CreateSessionRunRequest,
  ): Promise<CoordinationRun> {
    const agentIds = input.agents;
    const raw = input as CreateSessionRunRequest & {
      requiredSections?: unknown;
      policy?: (NonNullable<CreateSessionRunRequest["policy"]> & { maxRevisions?: unknown }) | undefined;
    };
    if (
      input.name.trim().length < 1 ||
      input.name.trim().length > 80 ||
      input.objective.trim().length < 1 ||
      input.objective.trim().length > 4_000 ||
      raw.requiredSections !== undefined ||
      raw.policy?.maxRevisions !== undefined
    ) {
      throw new CoordinationError(400, "VALIDATION_FAILED", "Session create input is invalid");
    }
    if (
      agentIds.length < SESSION_LIMITS.minParticipants ||
      agentIds.length > SESSION_LIMITS.maxParticipants ||
      agentIds.some((id) => id.trim().length === 0)
    ) {
      throw new CoordinationError(
        400,
        "VALIDATION_FAILED",
        `A session needs between ${SESSION_LIMITS.minParticipants} and ${SESSION_LIMITS.maxParticipants} Agents`,
      );
    }
    if (new Set(agentIds).size !== agentIds.length) {
      throw new CoordinationError(400, "DUPLICATE_AGENT", "Each participant must be distinct");
    }

    const agents = await this.dependencies.agentDirectory.getAgentsByIds(agentIds);
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    if (agentIds.some((id) => !agentsById.has(id))) {
      throw new CoordinationError(404, "NOT_FOUND", "Selected Agent was not found");
    }

    const protocol = input.policy?.sessionProtocol ?? "countdown";
    if (protocol !== "countdown" && protocol !== "free_chat") {
      throw new CoordinationError(400, "VALIDATION_FAILED", "Session protocol is invalid");
    }
    if (protocol === "free_chat" && input.policy?.sessionStartValue !== undefined) {
      throw new CoordinationError(
        400,
        "VALIDATION_FAILED",
        "Free-chat sessions do not accept a start value",
      );
    }
    const startValue =
      protocol === "countdown"
        ? (input.policy?.sessionStartValue ?? SESSION_LIMITS.defaultStartValue)
        : undefined;
    const maxTurns =
      input.policy?.maxTurns ??
      (protocol === "countdown"
        ? (startValue ?? SESSION_LIMITS.defaultStartValue)
        : SESSION_LIMITS.defaultSessionTurns);

    if (
      (protocol === "countdown" &&
        (!Number.isInteger(startValue) ||
          startValue! < SESSION_LIMITS.minStartValue ||
          startValue! > SESSION_LIMITS.maxStartValue ||
          !Number.isInteger(maxTurns) ||
          maxTurns < startValue! ||
          maxTurns > SESSION_LIMITS.maxSessionTurns)) ||
      (protocol === "free_chat" &&
        (!Number.isInteger(maxTurns) ||
          maxTurns < SESSION_LIMITS.minSessionTurns ||
          maxTurns > SESSION_LIMITS.maxSessionTurns)) ||
      (input.policy?.perAttemptTimeoutMs !== undefined &&
        (!Number.isInteger(input.policy.perAttemptTimeoutMs) ||
          input.policy.perAttemptTimeoutMs < 10_000 ||
          input.policy.perAttemptTimeoutMs > 180_000))
    ) {
      throw new CoordinationError(400, "VALIDATION_FAILED", "Session policy is invalid");
    }

    const policy = {
      ...DEFAULT_COORDINATION_POLICY,
      workflow: "shared_session_v1" as const,
      // A session turn produces one bounded message, never a revised document.
      maxRevisions: 0,
      // A transcript across up to ten participants needs more room than one
      // verified-handoff document (P10-05).
      contextMaxChars: SESSION_CONTEXT_MAX_CHARS,
      maxTurns,
      sessionProtocol: protocol,
      ...(startValue !== undefined ? { sessionStartValue: startValue } : {}),
      ...(input.policy?.perAttemptTimeoutMs !== undefined
        ? { perAttemptTimeoutMs: input.policy.perAttemptTimeoutMs }
        : {}),
    };

    // Selection order is the turn order (overview-sessions.md Section 7).
    const participants: CoordinationParticipant[] = agentIds.map((agentId) => {
      const agent = agentsById.get(agentId);
      if (!agent) {
        throw new CoordinationError(404, "NOT_FOUND", "Selected Agent was not found");
      }
      return { role: "participant" as const, agentId, agentNameSnapshot: agent.name };
    });

    const timestamp = this.dependencies.clock.nowIso();
    const run: CoordinationRun = {
      id: this.dependencies.ids.runId(),
      name: input.name.trim(),
      objective: input.objective.trim(),
      requiredSections: [],
      participants,
      policy,
      status: "created",
      phase: "sessioning",
      revision: 0,
      nextTurnSequence: 1,
      ...(startValue !== undefined ? { sharedState: { nextExpectedNumber: startValue } } : {}),
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.assertContextFits(run, timestamp);
    return this.dependencies.repository.createRun({ run });
  }

  private async createVerifiedRun(
    input: CreateCoordinationRunRequest,
  ): Promise<CoordinationRun> {
    const requiredSections = this.normalizeRequiredSections(input.requiredSections);
    this.validateCreateInput(input, requiredSections);
    const agentIds = [
      input.agents.plannerAgentId,
      input.agents.criticAgentId,
      input.agents.finalizerAgentId,
    ];
    const agents = await this.dependencies.agentDirectory.getAgentsByIds(agentIds);
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    const missingAgentId = agentIds.find((id) => !agentsById.has(id));
    if (missingAgentId) {
      throw new CoordinationError(404, "NOT_FOUND", "Selected Agent was not found");
    }

    const timestamp = this.dependencies.clock.nowIso();
    const policy = {
      ...DEFAULT_COORDINATION_POLICY,
      ...(input.policy?.maxRevisions !== undefined
        ? { maxRevisions: input.policy.maxRevisions }
        : {}),
      ...(input.policy?.maxTurns !== undefined ? { maxTurns: input.policy.maxTurns } : {}),
      ...(input.policy?.perAttemptTimeoutMs !== undefined
        ? { perAttemptTimeoutMs: input.policy.perAttemptTimeoutMs }
        : {}),
    };
    this.validatePolicy(policy);
    const participants = [
      { role: "planner" as const, agentId: input.agents.plannerAgentId },
      { role: "critic" as const, agentId: input.agents.criticAgentId },
      { role: "finalizer" as const, agentId: input.agents.finalizerAgentId },
    ].map(({ role, agentId }) => {
      const agent = agentsById.get(agentId);
      if (!agent) {
        throw new CoordinationError(404, "NOT_FOUND", "Selected Agent was not found");
      }
      return { role, agentId, agentNameSnapshot: agent.name };
    });

    const run: CoordinationRun = {
      id: this.dependencies.ids.runId(),
      name: input.name.trim(),
      objective: input.objective.trim(),
      requiredSections,
      participants,
      policy,
      status: "created",
      phase: "drafting",
      revision: 0,
      nextTurnSequence: 1,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.assertContextFits(run, timestamp);

    return this.dependencies.repository.createRun({ run });
  }

  /**
   * Refuses a run whose objective and required sections cannot fit the context
   * cap on their own (overview Section 11.6). The real builder performs the
   * check, so creation cannot succeed for a run whose very first prompt would be
   * impossible to build.
   */
  private assertContextFits(run: CoordinationRun, timestamp: string): void {
    const participant = run.policy.workflow === "shared_session_v1"
      ? run.participants[0]
      : run.participants.find((candidate) => candidate.role === "planner");
    if (!participant) {
      throw new CoordinationError(
        500,
        "INTERNAL_ERROR",
        "Coordination run is missing a required participant",
      );
    }

    try {
      this.dependencies.contextBuilder.build({
        run,
        turn: {
          id: `${run.id}-context-probe`,
          runId: run.id,
          sequence: 1,
          role: run.policy.workflow === "shared_session_v1" ? "participant" : "planner",
          agentId: participant.agentId,
          kind: run.policy.workflow === "shared_session_v1" ? "session_turn" : "initial_proposal",
          status: "scheduled",
          attemptCount: 0,
          inputArtifactIds: [],
          lastValidationErrors: [],
          createdAt: timestamp,
        },
        artifacts: [],
        retryValidationErrors: [],
      });
    } catch (error) {
      if (error instanceof CoordinationError) {
        throw new CoordinationError(
          400,
          "VALIDATION_FAILED",
          "Run objective does not fit the coordination context limit",
        );
      }
      throw error;
    }
  }

  /**
   * Normalises required section keys to the frozen slug format (overview
   * Sections 7.1 and 25.1) before duplicates are rejected, so keys that differ
   * only by case or surrounding whitespace cannot both be accepted.
   */
  private normalizeRequiredSections(sections: RequiredSection[]): RequiredSection[] {
    return sections.map((section) => ({
      key: section.key.trim().toLowerCase(),
      title: section.title.trim(),
    }));
  }

  async startRun(id: CoordinationRunId): Promise<CoordinationRun> {
    if (this.activeLoops.has(id)) {
      throw new CoordinationError(
        409,
        "INVALID_STATE",
        "Coordination run is already running",
      );
    }
    const result = await this.dependencies.repository.startRun(id);
    if (result.kind === "not_found") {
      throw new CoordinationError(404, "NOT_FOUND", "Coordination run not found");
    }
    if (result.kind === "conflict") {
      throw new CoordinationError(409, result.code, result.message);
    }

    this.log({ runId: result.run.id, status: result.run.status }, "Coordination run started");
    this.startLoop(result.run.id);
    return result.run;
  }

  async stopRun(id: CoordinationRunId): Promise<CoordinationRun> {
    const requested = await this.dependencies.repository.requestStop(id);
    if (!requested) {
      throw new CoordinationError(404, "NOT_FOUND", "Coordination run not found");
    }
    if (isTerminal(requested.status)) {
      return requested;
    }

    const details = await this.dependencies.repository.getRunDetails(id);
    const activeAttempt = details?.attempts.find((attempt) => attempt.status === "running");
    if (activeAttempt) {
      try {
        await this.dependencies.runtime.cancelAttempt(activeAttempt.id);
      } catch {
        // The stop transition is durable before cancellation is attempted. A
        // gateway-side cancellation failure must not leave it stranded.
      }
    }
    const stopped = await this.dependencies.repository.finishStopped(id);
    if (!stopped) {
      throw new CoordinationError(404, "NOT_FOUND", "Coordination run not found");
    }
    this.log(
      { runId: id, status: stopped.status, code: stopped.errorCode ?? "STOPPED_BY_USER" },
      "Coordination run stopped",
    );
    // Runtime cancellation is cooperative and a late completion may remain
    // pending. Retire this loop immediately: durable lease fencing already
    // settled its attempt, and the epoch prevents it from touching a later wave.
    this.retireLoop(id);
    return stopped;
  }

  async resumeRun(
    id: CoordinationRunId,
    input: AppendUserMessageRequest,
  ): Promise<CoordinationRun> {
    const result = await this.dependencies.repository.appendUserMessage({ runId: id, ...input });
    if (result.kind === "not_found") {
      throw new CoordinationError(404, "NOT_FOUND", "Session not found");
    }
    if (result.kind === "terminal") {
      throw new CoordinationError(409, "INVALID_STATE", "This session has ended");
    }
    if (result.kind === "conflict") {
      throw new CoordinationError(
        409,
        result.code ?? "INVALID_STATE",
        result.message ?? "Agents are already working",
      );
    }
    if (result.kind === "duplicate") {
      return result.run;
    }
    // `awaitInput` is durable before the previous loop's promise reaches its
    // `finally`. A prompt arriving in that narrow window must replace that
    // exiting owner instead of observing it and leaving the resumed run idle.
    if (this.activeLoops.has(id)) {
      this.retireLoop(id);
    }
    this.startLoop(id);
    return result.run;
  }

  async endRun(id: CoordinationRunId): Promise<CoordinationRun> {
    const details = await this.dependencies.repository.getRunDetails(id);
    if (!details) {
      throw new CoordinationError(404, "NOT_FOUND", "Session not found");
    }
    if (details.run.status === "running" || details.run.status === "stop_requested") {
      throw new CoordinationError(409, "INVALID_STATE", "Stop the current wave before ending the session");
    }
    const result = await this.dependencies.repository.endSession(id);
    if (result.kind === "not_found") {
      throw new CoordinationError(404, "NOT_FOUND", "Session not found");
    }
    if (result.kind === "conflict") {
      throw new CoordinationError(409, "INVALID_STATE", "Only an idle session can be ended");
    }
    // An idle loop may still be unwinding after its durable `awaiting_input`
    // transition. Ending the session fences that stale owner immediately.
    if (this.activeLoops.has(id)) {
      this.retireLoop(id);
    }
    return result.run;
  }

  /**
   * Structured log line. The context type admits only identifiers, enum values,
   * counts, and digests, so a prompt, raw output, or lease token cannot be
   * logged even by mistake.
   */
  private log(context: CoordinationLogContext, message: string): void {
    this.dependencies.logger?.info?.(context, message);
  }

  private startLoop(runId: CoordinationRunId): void {
    // Ownership is single: a run never gets a second loop, whether the caller
    // is `startRun` or the reconciliation sweep.
    if (this.activeLoops.has(runId)) {
      return;
    }
    const epoch = (this.loopEpochs.get(runId) ?? 0) + 1;
    this.loopEpochs.set(runId, epoch);
    const loop = this.runLoop(runId, epoch).catch(async (error: unknown) => {
      if (!this.ownsLoop(runId, epoch)) return;
      this.dependencies.logger?.error({ runId }, "Coordination run loop failed");
      const failure =
        error instanceof CoordinationError
          ? { code: error.code, message: error.message }
          : {
              code: "INTERNAL_ERROR" as const,
              message: "Coordination run stopped because of an internal error",
            };
      try {
        await this.dependencies.repository.failRun({ runId, ...failure });
      } catch {
        // The original failure is already logged safely. Never leave a rejected
        // background promise for an HTTP request to observe.
      }
    });
    this.activeLoops.set(runId, loop);
    void loop
      .finally(() => {
        if (this.activeLoops.get(runId) === loop) {
          this.activeLoops.delete(runId);
        }
      })
      .catch(() => undefined);
  }

  private retireLoop(runId: CoordinationRunId): void {
    this.loopEpochs.set(runId, (this.loopEpochs.get(runId) ?? 0) + 1);
    this.activeLoops.delete(runId);
  }

  private ownsLoop(runId: CoordinationRunId, epoch: number): boolean {
    return this.loopEpochs.get(runId) === epoch;
  }

  private async runLoop(runId: CoordinationRunId, epoch: number): Promise<void> {
    let reconciliations = 0;
    while (true) {
      if (!this.ownsLoop(runId, epoch)) return;
      const details = await this.dependencies.repository.getRunDetails(runId);
      if (!details || details.run.status !== "running") {
        return;
      }

      const decision = this.workflowDispatch.forRun(details.run).decideNext({
        run: details.run,
        turns: details.turns,
        artifacts: details.artifacts,
      });
      if (decision.kind === "complete") {
        await this.dependencies.repository.completeRun({
          runId,
          finalArtifactId: decision.finalArtifactId,
        });
        return;
      }
      if (decision.kind === "await_input") {
        await this.dependencies.repository.awaitInput(runId);
        return;
      }
      if (decision.kind === "fail") {
        await this.dependencies.repository.failRun({
          runId,
          code: decision.code,
          message: decision.message,
        });
        return;
      }

      const scheduled = await this.dependencies.repository.scheduleTurn({
        runId,
        expectedRunVersion: details.run.version,
        turn: this.makeTurn(details.run, decision),
        nextPhase: decision.phase,
        nextRevision: decision.revision,
      });
      if (scheduled.kind === "not_found") {
        // The run was deleted between the reload and the schedule. Nothing is
        // left to settle, and a deleted run reserves nobody.
        return;
      }
      if (scheduled.kind === "stale") {
        continue;
      }

      this.log({
        runId,
        turnId: scheduled.turn.id,
        sequence: scheduled.turn.sequence,
        role: scheduled.turn.role,
        agentId: scheduled.turn.agentId,
        status: decision.turnKind,
      }, "Coordination turn scheduled");

      const outcome = await this.executeTurnWithRetries(
        scheduled.run,
        scheduled.turn,
        () => this.ownsLoop(runId, epoch),
      );
      if (!this.ownsLoop(runId, epoch)) return;
      if (outcome === "committed") {
        // Progress resets the reconciliation budget: the bound exists to catch
        // a run that cannot advance, not one that occasionally loses a lease.
        reconciliations = 0;
        continue;
      }
      if (outcome === "settled") {
        return;
      }

      reconciliations += 1;
      if (!(await this.reconcileAbandonedLoop(runId, reconciliations))) {
        return;
      }
    }
  }

  /**
   * Decide what an abandoned turn means for the run (P11-01 classification,
   * P11-03).
   *
   * Returns `true` when the loop may continue — the run is still `running` and
   * either nothing was stranded (`noop`) or the stranded turn and attempt have
   * been settled (`reconciled`). Returns `false` when the loop must stop:
   * the run is gone, some other actor owns its next transition, or it has been
   * failed as abandoned because reconciliation stopped making progress.
   */
  private async reconcileAbandonedLoop(
    runId: CoordinationRunId,
    consecutive: number,
  ): Promise<boolean> {
    const details = await this.dependencies.repository.getRunDetails(runId);
    if (!details) {
      return false;
    }
    if (details.run.status !== "running") {
      // `stop_requested` belongs to the stop path; a terminal run is settled.
      return false;
    }

    if (consecutive > MAX_CONSECUTIVE_RECONCILIATIONS) {
      await this.dependencies.repository.failRun({
        runId,
        code: "RUN_ABANDONED",
        message: "Coordination run could not be resumed after repeated reconciliation",
      });
      this.dependencies.logger?.error(
        { runId, code: "RUN_ABANDONED" },
        "Coordination run failed as abandoned",
      );
      return false;
    }

    const result = await this.dependencies.repository.reconcileRun({
      runId,
      reason: "orchestration loop exited without settling the run",
    });
    if (result.kind === "reconciled" || result.kind === "noop") {
      this.log({ runId, status: result.kind }, "Coordination run reconciled");
      return true;
    }
    // `terminal`, `owned`, and `not_found` all mean another actor settled the
    // run between the reload and this call. Stopping is the safe response.
    return false;
  }

  private makeTurn(run: CoordinationRun, decision: Extract<WorkflowDecision, { kind: "schedule" }>): CoordinationTurn {
    const participant = run.participants.find(
      (candidate) =>
        candidate.role === decision.role &&
        (decision.agentId === undefined || candidate.agentId === decision.agentId),
    );
    if (!participant) {
      throw new CoordinationError(
        500,
        "INTERNAL_ERROR",
        "Coordination run is missing a required participant",
      );
    }
    return {
      id: this.dependencies.ids.turnId(),
      runId: run.id,
      sequence: run.nextTurnSequence,
      role: decision.role,
      agentId: participant.agentId,
      kind: decision.turnKind,
      status: "scheduled",
      attemptCount: 0,
      inputArtifactIds: [...decision.inputArtifactIds],
      lastValidationErrors: [],
      createdAt: this.dependencies.clock.nowIso(),
    };
  }

  /**
   * Run one scheduled turn, retrying within `maxAttemptsPerTurn`.
   *
   * Every exit is classified for the loop (P11-01). The rule is simple: an exit
   * that made a terminal repository call, or that observed the run is no longer
   * `running`, is `settled`; an exit that lost a lease or found its turn
   * superseded while the run may still be `running` is `abandoned` and must be
   * reconciled before the loop continues or stops.
   */
  private async executeTurnWithRetries(
    scheduledRun: CoordinationRun,
    scheduledTurn: CoordinationTurn,
    ownsLoop: () => boolean,
  ): Promise<TurnExecutionOutcome> {
    let validationErrors: string[] = [];
    let lastErrorCode: CoordinationErrorCode = "AGENT_EXECUTION_FAILED";
    let lastErrorMessage = "Agent execution failed";

    for (let number = 1; number <= scheduledRun.policy.maxAttemptsPerTurn; number += 1) {
      const details = await this.dependencies.repository.getRunDetails(scheduledRun.id);
      if (!details || details.run.status !== "running") {
        // The run is gone, terminal, or stopping. Its next transition belongs
        // to whoever made it non-running.
        return "settled";
      }
      const currentTurn = details.turns.find((turn) => turn.id === scheduledTurn.id);
      if (!currentTurn || currentTurn.status !== "scheduled") {
        // The turn was superseded while the run stayed running: resumable.
        return "abandoned";
      }
      const envelope = this.dependencies.contextBuilder.build({
        run: details.run,
        turn: currentTurn,
        artifacts: details.artifacts,
        retryValidationErrors: validationErrors,
      });
      const attempt: CoordinationAttempt = {
        id: this.dependencies.ids.attemptId(),
        runId: scheduledRun.id,
        turnId: scheduledTurn.id,
        number,
        agentId: currentTurn.agentId,
        leaseToken: this.dependencies.ids.leaseToken(),
        status: "running",
        promptDigest: envelope.promptDigest,
        createdAt: this.dependencies.clock.nowIso(),
      };
      const begun = await this.dependencies.repository.beginAttempt({
        runId: scheduledRun.id,
        turnId: scheduledTurn.id,
        attempt,
        truncated: envelope.truncated,
      });
      if (begun.kind !== "started") {
        // `stale` covers both "run stopped" and "turn superseded"; the
        // reconciler reloads and tells the two apart.
        return "abandoned";
      }
      this.log({
        runId: scheduledRun.id,
        turnId: scheduledTurn.id,
        attemptId: attempt.id,
        attemptNumber: number,
        role: currentTurn.role,
        agentId: currentTurn.agentId,
        promptDigest: envelope.promptDigest,
        truncated: envelope.truncated,
      }, "Coordination attempt started");

      let runtimeStart;
      try {
        runtimeStart = await this.dependencies.runtime.start({
          runId: scheduledRun.id,
          turnId: scheduledTurn.id,
          attemptId: attempt.id,
          leaseToken: attempt.leaseToken,
          agentId: currentTurn.agentId,
          prompt: envelope.prompt,
          timeoutMs: details.run.policy.perAttemptTimeoutMs,
        });
      } catch {
        runtimeStart = { kind: "failed" as const, message: "Agent execution could not start" };
      }

      if (runtimeStart.kind === "failed") {
        lastErrorCode = "AGENT_EXECUTION_FAILED";
        lastErrorMessage = runtimeStart.message;
        validationErrors = boundedRetryFeedback([lastErrorMessage]);
        if (!(await this.finishAttempt(attempt, "failed", lastErrorCode, lastErrorMessage))) {
          return "abandoned";
        }
        continue;
      }

      const attached = await this.dependencies.repository.attachAgentRun({
        attemptId: attempt.id,
        leaseToken: attempt.leaseToken,
        agentRunId: runtimeStart.handle.agentRunId,
      });
      if (attached === "stale") {
        await this.dependencies.runtime.cancelAttempt(attempt.id);
        void runtimeStart.handle.completion.catch(() => undefined);
        return "abandoned";
      }

      let outcome;
      try {
        outcome = await runtimeStart.handle.completion;
      } catch {
        outcome = { kind: "failed" as const, message: "Agent execution failed" };
      }
      if (!ownsLoop()) {
        return "settled";
      }
      if (outcome.kind === "succeeded") {
        const validation = this.dependencies.artifactProtocol.validate({
          run: details.run,
          turn: currentTurn,
          attempt,
          rawOutput: outcome.rawOutput,
        });
        if (validation.ok) {
          const committed = await this.dependencies.repository.commitAcceptedArtifact({
            runId: scheduledRun.id,
            turnId: scheduledTurn.id,
            attemptId: attempt.id,
            leaseToken: attempt.leaseToken,
            artifact: validation.artifact,
            outputDigest: digestOutput(outcome.rawOutput),
          });
          this.log({
            runId: scheduledRun.id,
            turnId: scheduledTurn.id,
            attemptId: attempt.id,
            artifactType: validation.artifact.type,
            status: committed.kind,
          }, "Coordination commit settled");
          // A commit that lost its lease leaves the turn and attempt exactly as
          // the reconciler expects to find them.
          return committed.kind === "committed" ? "committed" : "abandoned";
        }
        validationErrors = boundedRetryFeedback(
          validation.errors.map((error) => error.message),
        );
        lastErrorCode = validation.code;
        lastErrorMessage = "Agent output did not satisfy the coordination contract";
        if (
          !(await this.finishAttempt(
            attempt,
            "invalid_output",
            lastErrorCode,
            lastErrorMessage,
            validationErrors,
          ))
        ) {
          return "abandoned";
        }
        continue;
      }

      if (outcome.kind === "cancelled") {
        if (!(await this.finishAttempt(attempt, "cancelled", "STOPPED_BY_USER", outcome.message))) {
          return "abandoned";
        }
        const afterCancellation = await this.dependencies.repository.getRunDetails(
          scheduledRun.id,
        );
        if (afterCancellation?.run.status === "running") {
          await this.dependencies.repository.failRun({
            runId: scheduledRun.id,
            code: "AGENT_EXECUTION_FAILED",
            message: "Agent execution was cancelled unexpectedly",
          });
        }
        return "settled";
      }
      lastErrorCode =
        outcome.kind === "timed_out" ? "ATTEMPT_TIMED_OUT" : "AGENT_EXECUTION_FAILED";
      lastErrorMessage = outcome.message;
      validationErrors = boundedRetryFeedback([lastErrorMessage]);
      const status = outcome.kind === "timed_out" ? "timed_out" : "failed";
      if (!(await this.finishAttempt(attempt, status, lastErrorCode, lastErrorMessage))) {
        return "abandoned";
      }
    }

    await this.dependencies.repository.failRun({
      runId: scheduledRun.id,
      code: "MAX_ATTEMPTS_EXCEEDED",
      message: "Agent could not complete its turn: " + lastErrorMessage,
    });
    return "settled";
  }

  private async finishAttempt(
    attempt: CoordinationAttempt,
    status: "invalid_output" | "timed_out" | "failed" | "cancelled",
    errorCode: CoordinationErrorCode,
    errorMessage: string,
    validationErrors?: string[],
  ): Promise<boolean> {
    const result = await this.dependencies.repository.finishAttempt({
      runId: attempt.runId,
      turnId: attempt.turnId,
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken,
      status,
      errorCode,
      errorMessage,
      ...(validationErrors ? { validationErrors } : {}),
    });
    return result === "finished";
  }

  private validateCreateInput(
    input: CreateCoordinationRunRequest,
    requiredSections: RequiredSection[],
  ): void {
    const agents = Object.values(input.agents);
    if (agents.some((agentId) => agentId.trim().length === 0)) {
      throw new CoordinationError(400, "VALIDATION_FAILED", "Each role requires an Agent");
    }
    if (new Set(agents).size !== agents.length) {
      throw new CoordinationError(
        400,
        "DUPLICATE_AGENT",
        "Planner, Critic, and Finalizer must be different Agents",
      );
    }
    const keys = requiredSections.map((section) => section.key);
    if (new Set(keys).size !== keys.length) {
      throw new CoordinationError(
        400,
        "VALIDATION_FAILED",
        "Required section keys must be unique",
      );
    }
    if (!input.name.trim() || !input.objective.trim() || requiredSections.length === 0) {
      throw new CoordinationError(
        400,
        "VALIDATION_FAILED",
        "Name, objective, and at least one required section are required",
      );
    }
    const invalidSection = requiredSections.find(
      (section) =>
        !SECTION_KEY_PATTERN.test(section.key) ||
        section.key.length > ARTIFACT_SCHEMA_LIMITS.keyChars ||
        section.title.length === 0 ||
        section.title.length > ARTIFACT_SCHEMA_LIMITS.titleChars,
    );
    if (invalidSection) {
      throw new CoordinationError(
        400,
        "VALIDATION_FAILED",
        "Each required section needs a lower-case slug key and a bounded title",
      );
    }
  }

  private validatePolicy(policy: CoordinationRun["policy"]): void {
    if (
      !Number.isInteger(policy.maxRevisions) ||
      policy.maxRevisions < 0 ||
      policy.maxRevisions > 3 ||
      !Number.isInteger(policy.maxTurns) ||
      policy.maxTurns < 3 ||
      policy.maxTurns > 12 ||
      !Number.isInteger(policy.perAttemptTimeoutMs) ||
      policy.perAttemptTimeoutMs < 10_000 ||
      policy.perAttemptTimeoutMs > 180_000
    ) {
      throw new CoordinationError(400, "VALIDATION_FAILED", "Coordination policy is invalid");
    }
  }
}
