/**
 * Shared measurement scaffolding for the Phase 15 scale tasks.
 *
 * Extracted from the `P15-01` harness so `P15-02` measures the same thing the
 * same way: one growing session driven through the real service, repository,
 * workflow, and artifact protocol against a real `JsonStore`. Only the Agent
 * runtime is a double.
 *
 * The store always lives in a fresh `mkdtemp` directory and the builder refuses
 * to run anywhere else, so a measurement can never touch real runtime data.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  CoordinationArtifactProtocolDispatchV1,
  SharedSessionArtifactProtocol,
  VerifiedHandoffArtifactProtocol,
} from "../coordination/artifact-protocol.js";
import { RoleScopedContextBuilder } from "../coordination/context-builder.js";
import type {
  Clock,
  CoordinationAgentDirectory,
  CoordinationAgentView,
  CoordinationRuntime,
  IdGenerator,
  RuntimeExecutionInput,
  RuntimeStartResult,
} from "../coordination/contracts.js";
import { DurableCoordinationRepository } from "../coordination/repository.js";
import { CoordinationService } from "../coordination/service.js";
import { SharedSessionWorkflowV1 } from "../coordination/session-workflow.js";
import { VerifiedHandoffWorkflowV1 } from "../coordination/workflow.js";
import { JsonStore } from "../store.js";
import { SESSION_LIMITS } from "../coordination/types.js";
import type { CoordinationRunId, CreateSessionRunRequest } from "../coordination/types.js";
import type { Database } from "../types.js";

/**
 * A realistic session message rather than a one-word stub: file size and clone
 * cost are dominated by stored content, so an unrealistically short message
 * would understate every measurement built on it.
 */
export const MESSAGE_CONTENT =
  "Seller verification should land before any listing goes live, with an escrow " +
  "hold that releases payment only on confirmed delivery, and a reporting route " +
  "a moderator reads daily so disputes never sit unattended over a weekend.";

/**
 * Times every `mutate` without changing what it does.
 *
 * The post-mutation hook reads the already-cloned `next` database the store is
 * about to persist, so watching for a status change costs no extra snapshot -
 * which matters, because a snapshot is one of the things being measured.
 */
export class MeasuredJsonStore extends JsonStore {
  readonly durations: number[] = [];
  onMutation: ((database: Database) => void) | undefined;

  override async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    const started = performance.now();
    const result = await super.mutate(async (database) => {
      const value = await mutation(database);
      this.onMutation?.(database);
      return value;
    });
    this.durations.push(performance.now() - started);
    return result;
  }
}

/**
 * Every attempt succeeds with one valid session message that signals `done`.
 *
 * Unanimous `done` ends a round-robin wave after exactly one message per
 * participant, so one user prompt costs exactly `participants` committed turns
 * and a harness knows its size without counting the ledger.
 */
export class AlwaysCommittingRuntime implements CoordinationRuntime {
  constructor(private readonly content: string = MESSAGE_CONTENT) {}

  async start(input: RuntimeExecutionInput): Promise<RuntimeStartResult> {
    const rawOutput = JSON.stringify({
      schemaVersion: 1,
      type: "session_message",
      content: this.content,
      done: true,
    });
    return {
      kind: "started",
      handle: {
        agentRunId: `agent-run-${input.attemptId}`,
        completion: Promise.resolve({ kind: "succeeded" as const, rawOutput }),
      },
    };
  }

  async cancelAttempt(): Promise<boolean> {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Statistics
 * ------------------------------------------------------------------ */

/** Nearest-rank percentile over a copy, so the caller's array keeps its order. */
export const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
};

export const median = (values: number[]): number => percentile(values, 0.5);

export const round = (value: number, places = 2): number =>
  Number.isFinite(value) ? Number(value.toFixed(places)) : Number.NaN;

export const mib = (bytes: number): number => round(bytes / 1024 / 1024);

export const parseFlag = (name: string, fallback: string): string => {
  const hit = process.argv.slice(2).find((argument) => argument.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

export const hasFlag = (name: string): boolean =>
  process.argv.slice(2).includes(`--${name}`);

export const parseSizes = (fallback: string, participants: number): number[] => {
  const sizes = parseFlag("sizes", fallback)
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (sizes.length === 0) throw new Error("No valid --sizes given");
  for (const size of sizes) {
    if (size % participants !== 0) {
      throw new Error(
        `Size ${size} is not a whole number of waves; it must divide by --participants=${participants}`,
      );
    }
  }
  return sizes;
};

/* ------------------------------------------------------------------ *
 * Session construction
 * ------------------------------------------------------------------ */

export interface ScaleSession {
  directory: string;
  databasePath: string;
  store: MeasuredJsonStore;
  repository: DurableCoordinationRepository;
  service: CoordinationService;
  runId: CoordinationRunId;
  participants: number;
  /** Sends one prompt and resolves with its end-to-end milliseconds. */
  prompt(label: string): Promise<number>;
}

export const buildScaleSession = async (participants: number): Promise<ScaleSession> => {
  if (!Number.isFinite(participants) || participants < SESSION_LIMITS.minParticipants) {
    throw new Error(`participants must be at least ${SESSION_LIMITS.minParticipants}`);
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "p15-scale-"));
  if (!directory.startsWith(os.tmpdir())) {
    throw new Error(`Refusing to run outside the system temp directory: ${directory}`);
  }
  const databasePath = path.join(directory, "launchpad.json");

  const store = new MeasuredJsonStore(databasePath);
  await store.initialize();

  const clock: Clock = { nowIso: () => new Date().toISOString() };
  const ids: IdGenerator = {
    runId: () => randomUUID(),
    turnId: () => randomUUID(),
    attemptId: () => randomUUID(),
    artifactId: () => randomUUID(),
    eventId: () => randomUUID(),
    leaseToken: () => randomUUID(),
  };

  const roster: CoordinationAgentView[] = Array.from(
    { length: participants },
    (_unused, index) => ({
      id: `agent-scale-${index + 1}`,
      name: `Scale ${index + 1}`,
      status: "ready" as const,
    }),
  );
  const agentDirectory: CoordinationAgentDirectory = {
    getAgentsByIds: async (wanted) => {
      const set = new Set(wanted);
      return roster.filter((agent) => set.has(agent.id)).map((agent) => ({ ...agent }));
    },
  };

  // Participant readiness and reservations are checked against the Agent records
  // in the store, not against the coordination directory, so the roster has to
  // exist there too. The setup mutation is excluded from recorded latencies.
  const now = clock.nowIso();
  await store.mutate((database) => {
    for (const agent of roster) {
      database.agents.push({
        id: agent.id,
        name: agent.name,
        description: `Phase 15 scale participant ${agent.name}`,
        instructions: "Reply with one short session message.",
        status: "ready",
        workspacePath: path.join(directory, "workspaces", agent.id),
        codexThreadId: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  });
  store.durations.length = 0;

  const repository = new DurableCoordinationRepository({ store, clock, ids });
  const service = new CoordinationService({
    agentDirectory,
    repository,
    workflow: new VerifiedHandoffWorkflowV1(),
    sessionWorkflow: new SharedSessionWorkflowV1(),
    contextBuilder: new RoleScopedContextBuilder(),
    artifactProtocol: new CoordinationArtifactProtocolDispatchV1(
      new VerifiedHandoffArtifactProtocol({ clock, ids }),
      new SharedSessionArtifactProtocol({ clock, ids }),
    ),
    runtime: new AlwaysCommittingRuntime(),
    clock,
    ids,
  });

  const request: CreateSessionRunRequest = {
    workflow: "shared_session_v1",
    name: "Phase 15 scale measurement",
    objective: "Measure durable store cost as one session grows.",
    agents: roster.map((agent) => agent.id),
    policy: {
      // round_robin keeps every committed turn an ordinary participant message:
      // no coordinator plan turns, so "committed turns" means what the sheet says.
      sessionPlanning: "round_robin",
      sessionProtocol: "free_chat",
      maxTurns: SESSION_LIMITS.maxSessionTurns,
    },
  };

  const run = await service.createRun(request);
  const runId = run.id;

  /** Resolves when the wave started by the next prompt has settled. */
  const settled = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      store.onMutation = (database) => {
        const current = database.coordinationRuns.find((candidate) => candidate.id === runId);
        if (!current) return;
        if (current.status === "awaiting_input") {
          store.onMutation = undefined;
          resolve();
        } else if (["completed", "failed", "stopped"].includes(current.status)) {
          store.onMutation = undefined;
          reject(new Error(`Session became ${current.status} before the wave finished`));
        }
      };
    });

  const prompt = async (label: string): Promise<number> => {
    const finished = settled();
    const started = performance.now();
    await service.resumeRun(runId, { content: `${label}: continue the shared objective.` });
    await finished;
    return performance.now() - started;
  };

  return {
    directory,
    databasePath,
    store,
    repository,
    service,
    runId,
    participants,
    prompt,
  };
};
