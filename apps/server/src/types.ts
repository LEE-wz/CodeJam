import type {
  CoordinationArtifact,
  CoordinationAttempt,
  CoordinationAttemptId,
  CoordinationEvent,
  CoordinationRun,
  CoordinationRunId,
  CoordinationTurn,
  CoordinationTurnId,
  AgentSpecialization,
  RunUsage,
} from "./coordination/types.js";

export type { RunUsage } from "./coordination/types.js";

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  specialization?: AgentSpecialization;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

/**
 * Additive correlation from an ordinary Agent Run back to the coordination
 * attempt that caused it (overview Section 10.1). Every field is optional so
 * that v1 records load unchanged; absent `source` is treated as "playground".
 */
export interface AgentRunCorrelation {
  source?: "playground" | "coordination";
  coordinationRunId?: CoordinationRunId;
  coordinationTurnId?: CoordinationTurnId;
  coordinationAttemptId?: CoordinationAttemptId;
}

export interface AgentRun extends AgentRunCorrelation {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** The pre-Relay database shape. Retained so migration can parse it explicitly. */
export interface DatabaseV1 {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

/**
 * Database v2 (overview Section 10.1): the v1 collections unchanged, plus the
 * five append-only coordination collections.
 */
export interface DatabaseV2 {
  version: 2;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  coordinationRuns: CoordinationRun[];
  coordinationTurns: CoordinationTurn[];
  coordinationAttempts: CoordinationAttempt[];
  coordinationArtifacts: CoordinationArtifact[];
  coordinationEvents: CoordinationEvent[];
}

/** Any version this server can parse. Only v2 is ever held in memory or written. */
export type AnyDatabase = DatabaseV1 | DatabaseV2;

/** The current in-memory and on-disk database shape. */
export type Database = DatabaseV2;

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  specialization?: AgentSpecialization | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  specialization?: AgentSpecialization | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
