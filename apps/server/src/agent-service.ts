import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  AgentExecutionControl,
  AgentExecutionHandle,
  CoordinationReservationSource,
  StartAgentExecutionRequest,
} from "./coordination/contracts.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Database,
  Message,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export class AgentService {
  private readonly activeExecutions = new Map<
    string,
    { agentId: string; completion: AgentExecutionHandle["completion"] }
  >();
  private readonly activeRunByAgent = new Map<string, string>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly reservations?: CoordinationReservationSource,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    await this.assertAgentNotReserved(id);
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      this.assertDatabaseAgentNotReserved(database, id);
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    await this.assertAgentNotReserved(id);
    await this.store.mutate((database) => this.assertDatabaseAgentNotReserved(database, id));
    const agent = this.getAgent(id);
    await this.cancelAgentExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      this.assertDatabaseAgentNotReserved(database, id);
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    await this.assertAgentNotReserved(id);
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    await this.assertAgentNotReserved(id);
    this.getAgent(id);
    await this.cancelAgentExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    const handle = await this.startExecution({
      agentId,
      prompt,
      source: "playground",
    });
    const run = this.getRun(handle.agentRunId);
    const message = this.store
      .snapshot()
      .messages.find((candidate) => candidate.id === handle.messageId);
    if (!message) {
      throw new Error("Agent execution message was not persisted");
    }
    return { run, message };
  }

  async startExecution(input: StartAgentExecutionRequest): Promise<AgentExecutionHandle> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId: input.agentId,
      status: "queued",
      prompt: input.prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
      source: input.source,
      ...(input.coordination
        ? {
            coordinationRunId: input.coordination.runId,
            coordinationTurnId: input.coordination.turnId,
            coordinationAttemptId: input.coordination.attemptId,
          }
        : {}),
    };
    const message: Message = {
      id: randomUUID(),
      agentId: input.agentId,
      runId,
      role: "user",
      content: input.prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === input.agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      const reservingRunId = database.coordinationRuns.find(
        (coordinationRun) =>
          (coordinationRun.status === "running" ||
            coordinationRun.status === "stop_requested") &&
          coordinationRun.participants.some(
            (participant) => participant.agentId === input.agentId,
          ),
      )?.id;
      if (input.source === "playground" && reservingRunId) {
        throw new HttpError(409, "Agent is reserved by coordination", "AGENT_RESERVED");
      }
      if (
        input.source === "coordination" &&
        (!input.coordination || reservingRunId !== input.coordination.runId)
      ) {
        throw new HttpError(
          409,
          "Coordination reservation does not match",
          "AGENT_RESERVED",
        );
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const completion = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(run.id, { agentId: input.agentId, completion });
    this.activeRunByAgent.set(input.agentId, run.id);
    void completion
      .finally(() => {
        if (this.activeExecutions.get(run.id)?.completion === completion) {
          this.activeExecutions.delete(run.id);
        }
        if (this.activeRunByAgent.get(input.agentId) === run.id) {
          this.activeRunByAgent.delete(input.agentId);
        }
      })
      .catch(() => undefined);
    return { agentRunId: run.id, messageId: message.id, completion };
  }

  async cancelRun(agentRunId: string): Promise<boolean> {
    const active = this.activeExecutions.get(agentRunId);
    if (!active || this.activeRunByAgent.get(active.agentId) !== agentRunId) {
      return false;
    }
    this.cancellationRequests.add(agentRunId);
    try {
      await this.runner.cancel(active.agentId);
      await active.completion;
      return true;
    } finally {
      this.cancellationRequests.delete(agentRunId);
    }
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
  ): AgentExecutionHandle["completion"] {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (this.cancellationRequests.has(run.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
      });
      if (this.cancellationRequests.has(run.id)) {
        throw new RunCancelledError();
      }
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
      return { status: "completed", output: result.output };
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
      return {
        status: cancelled ? "cancelled" : "failed",
        ...(cancelled ? {} : { error: message }),
      };
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      this.assertDatabaseAgentNotReserved(database, id);
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async assertAgentNotReserved(agentId: string): Promise<void> {
    if (await this.reservations?.getReservingRunId(agentId)) {
      throw new HttpError(409, "Agent is reserved by coordination", "AGENT_RESERVED");
    }
  }

  private assertDatabaseAgentNotReserved(database: Database, agentId: string): void {
    const reserved = database.coordinationRuns.some(
      (run) =>
        (run.status === "running" || run.status === "stop_requested") &&
        run.participants.some((participant) => participant.agentId === agentId),
    );
    if (reserved) {
      throw new HttpError(409, "Agent is reserved by coordination", "AGENT_RESERVED");
    }
  }

  private async cancelAgentExecution(agentId: string): Promise<void> {
    const runId = this.activeRunByAgent.get(agentId);
    if (runId) await this.cancelRun(runId);
  }
}
