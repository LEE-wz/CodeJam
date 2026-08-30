import type {
  ArtifactProtocol,
  Clock,
  ContextBuilder,
  CoordinationAgentDirectory,
  CoordinationRepository,
  CoordinationRuntime,
  CoordinationServiceContract,
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
  type CoordinationAttempt,
  type CoordinationErrorCode,
  type CoordinationRun,
  type CoordinationRunDetails,
  type CoordinationRunId,
  type CoordinationTurn,
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

  /**
   * Selects the decision source for a run from its durable policy. An Agent
   * cannot reach this: the workflow is fixed at create time and read from the
   * stored run, never from model output.
   */
  private workflowFor(run: CoordinationRun): {
    decideNext(view: Parameters<VerifiedHandoffWorkflow["decideNext"]>[0]): WorkflowDecision;
  } {
    if (run.policy.workflow === "shared_session_v1") {
      const sessionWorkflow = this.dependencies.sessionWorkflow;
      if (!sessionWorkflow) {
        throw new CoordinationError(
          500,
          "INTERNAL_ERROR",
          "Shared session workflow is not registered",
        );
      }
      return sessionWorkflow;
    }
    return this.dependencies.workflow;
  }

  async createRun(input: CreateRunRequest): Promise<CoordinationRun> {
    return input.workflow === "shared_session_v1"
      ? this.createSessionRun(input)
      : this.createVerifiedRun(input);
  }

  /**
   * Minimal shared-session create (P5-07). Enough to prove the contracts hold
   * and the dispatch resolves; P6-10 owns full create validation, the policy
   * range checks, and the create-time context probe with a session turn shape.
   */
  private async createSessionRun(
    input: CreateSessionRunRequest,
  ): Promise<CoordinationRun> {
    const agentIds = input.agents;
    if (
      agentIds.length < SESSION_LIMITS.minParticipants ||
      agentIds.length > SESSION_LIMITS.maxParticipants
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
    const startValue =
      protocol === "countdown"
        ? (input.policy?.sessionStartValue ?? SESSION_LIMITS.defaultStartValue)
        : undefined;
    const maxTurns =
      input.policy?.maxTurns ??
      (protocol === "countdown"
        ? (startValue ?? SESSION_LIMITS.defaultStartValue)
        : SESSION_LIMITS.defaultFreeChatTurns);

    const policy = {
      ...DEFAULT_COORDINATION_POLICY,
      workflow: "shared_session_v1" as const,
      // A session turn produces one bounded message, never a revised document.
      maxRevisions: 0,
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
    return stopped;
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
    const loop = this.runLoop(runId).catch(async (error: unknown) => {
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

  private async runLoop(runId: CoordinationRunId): Promise<void> {
    while (true) {
      const details = await this.dependencies.repository.getRunDetails(runId);
      if (!details || details.run.status !== "running") {
        return;
      }

      const decision = this.workflowFor(details.run).decideNext({
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

      this.log({
        runId,
        turnId: scheduled.turn.id,
        sequence: scheduled.turn.sequence,
        role: scheduled.turn.role,
        agentId: scheduled.turn.agentId,
        status: decision.turnKind,
      }, "Coordination turn scheduled");

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
        truncated: envelope.truncated,
      });
      if (begun.kind !== "started") {
        return false;
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
            outputDigest: digestOutput(outcome.rawOutput),
          });
          this.log({
            runId: scheduledRun.id,
            turnId: scheduledTurn.id,
            attemptId: attempt.id,
            artifactType: validation.artifact.type,
            status: committed.kind,
          }, "Coordination commit settled");
          return committed.kind === "committed";
        }
        validationErrors = boundedRetryFeedback(
          validation.errors.map((error) => error.message),
        );
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
      validationErrors = boundedRetryFeedback([lastErrorMessage]);
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
