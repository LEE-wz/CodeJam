import type {
  ArtifactProtocol,
  Clock,
  ContextBuilder,
  CoordinationAgentDirectory,
  CoordinationRepository,
  CoordinationRuntime,
  CoordinationServiceContract,
  IdGenerator,
  VerifiedHandoffWorkflow,
  WorkflowDecision,
} from "./contracts.js";
import { CoordinationError } from "./errors.js";
import { ARTIFACT_SCHEMA_LIMITS, SECTION_KEY_PATTERN } from "./schemas.js";
import {
  DEFAULT_COORDINATION_POLICY,
  type CoordinationAttempt,
  type CoordinationErrorCode,
  type CoordinationRun,
  type CoordinationRunDetails,
  type CoordinationRunId,
  type CoordinationTurn,
  type CreateCoordinationRunRequest,
  type RequiredSection,
} from "./types.js";

const terminalStatuses = new Set(["completed", "failed", "stopped"]);

const isTerminal = (status: CoordinationRun["status"]): boolean =>
  terminalStatuses.has(status);

interface CoordinationLogger {
  error(context: { runId: CoordinationRunId }, message: string): void;
}

interface CoordinationServiceDependencies {
  agentDirectory: CoordinationAgentDirectory;
  repository: CoordinationRepository;
  workflow: VerifiedHandoffWorkflow;
  contextBuilder: ContextBuilder;
  artifactProtocol: ArtifactProtocol;
  runtime: CoordinationRuntime;
  clock: Clock;
  ids: IdGenerator;
  logger?: CoordinationLogger | undefined;
}

/**
 * Owns coordination-run lifecycle and orchestration. Durable transitions belong
 * to the repository; routing, validation, context construction, and invocation
 * remain injectable components so they can be developed and tested separately.
 */
export class CoordinationService implements CoordinationServiceContract {
  private readonly activeLoops = new Map<CoordinationRunId, Promise<void>>();

  constructor(private readonly dependencies: CoordinationServiceDependencies) {}

  async initialize(): Promise<void> {
    await this.dependencies.repository.interruptActiveRuns();
  }

  async listRuns(): Promise<CoordinationRun[]> {
    return this.dependencies.repository.listRuns(50);
  }

  async getRun(id: CoordinationRunId): Promise<CoordinationRunDetails | undefined> {
    return this.dependencies.repository.getRunDetails(id);
  }

  async createRun(input: CreateCoordinationRunRequest): Promise<CoordinationRun> {
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
    const planner = run.participants.find((participant) => participant.role === "planner");
    if (!planner) {
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
          role: "planner",
          agentId: planner.agentId,
          kind: "initial_proposal",
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
          "Objective and required sections do not fit the coordination context limit",
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
    return stopped;
  }

  private startLoop(runId: CoordinationRunId): void {
    const loop = this.runLoop(runId).catch(async () => {
      this.dependencies.logger?.error({ runId }, "Coordination run loop failed");
      try {
        await this.dependencies.repository.failRun({
          runId,
          code: "INTERNAL_ERROR",
          message: "Coordination run stopped because of an internal error",
        });
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

  private async runLoop(runId: CoordinationRunId): Promise<void> {
    while (true) {
      const details = await this.dependencies.repository.getRunDetails(runId);
      if (!details || details.run.status !== "running") {
        return;
      }

      const decision = this.dependencies.workflow.decideNext({
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
        return;
      }
      if (scheduled.kind === "stale") {
        continue;
      }

      const committed = await this.executeTurnWithRetries(scheduled.run, scheduled.turn);
      if (!committed) {
        return;
      }
    }
  }

  private makeTurn(run: CoordinationRun, decision: Extract<WorkflowDecision, { kind: "schedule" }>): CoordinationTurn {
    const participant = run.participants.find(
      (candidate) => candidate.role === decision.role,
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

  private async executeTurnWithRetries(
    scheduledRun: CoordinationRun,
    scheduledTurn: CoordinationTurn,
  ): Promise<boolean> {
    let validationErrors: string[] = [];
    let lastErrorCode: CoordinationErrorCode = "AGENT_EXECUTION_FAILED";
    let lastErrorMessage = "Agent execution failed";

    for (let number = 1; number <= scheduledRun.policy.maxAttemptsPerTurn; number += 1) {
      const details = await this.dependencies.repository.getRunDetails(scheduledRun.id);
      if (!details || details.run.status !== "running") {
        return false;
      }
      const currentTurn = details.turns.find((turn) => turn.id === scheduledTurn.id);
      if (!currentTurn || currentTurn.status !== "scheduled") {
        return false;
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
      });
      if (begun.kind !== "started") {
        return false;
      }

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
        if (!(await this.finishAttempt(attempt, "failed", lastErrorCode, lastErrorMessage))) {
          return false;
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
        return false;
      }

      let outcome;
      try {
        outcome = await runtimeStart.handle.completion;
      } catch {
        outcome = { kind: "failed" as const, message: "Agent execution failed" };
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
          });
          return committed.kind === "committed";
        }
        validationErrors = validation.errors.map((error) => error.message);
        lastErrorCode = validation.code;
        lastErrorMessage = "Agent output did not satisfy the handoff contract";
        if (
          !(await this.finishAttempt(
            attempt,
            "invalid_output",
            lastErrorCode,
            lastErrorMessage,
            validationErrors,
          ))
        ) {
          return false;
        }
        continue;
      }

      if (outcome.kind === "cancelled") {
        if (!(await this.finishAttempt(attempt, "cancelled", "STOPPED_BY_USER", outcome.message))) {
          return false;
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
        return false;
      }
      lastErrorCode =
        outcome.kind === "timed_out" ? "ATTEMPT_TIMED_OUT" : "AGENT_EXECUTION_FAILED";
      lastErrorMessage = outcome.message;
      const status = outcome.kind === "timed_out" ? "timed_out" : "failed";
      if (!(await this.finishAttempt(attempt, status, lastErrorCode, lastErrorMessage))) {
        return false;
      }
    }

    await this.dependencies.repository.failRun({
      runId: scheduledRun.id,
      code: "MAX_ATTEMPTS_EXCEEDED",
      message: "Agent could not complete its turn: " + lastErrorMessage,
    });
    return false;
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
