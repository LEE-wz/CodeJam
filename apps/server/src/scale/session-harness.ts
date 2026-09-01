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
import type {
  CoordinationArtifact,
  CoordinationRunId,
  CreateSessionRunRequest,
} from "../coordination/types.js";
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
  /**
   * Materialises a valid, realistic ledger at an exact committed-turn count.
   *
   * One real wave is driven first and used as the template. Repeating that
   * already-validated shape in a single setup mutation avoids spending hours
   * rewriting intermediate databases while preserving the bytes and linked
   * records the measured final prompt must read and rewrite. Setup time is not
   * included in mutation statistics.
   */
  seedCommittedTurns(committedTurns: number): Promise<void>;
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
      // The legacy execution-wave policy keeps every committed turn an ordinary
      // participant message and avoids private auction artifacts in the scale
      // corpus, so "committed turns" means exactly what the sheet says.
      sessionWaveMode: "parallel",
      maxParallelTurns: participants,
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

  const seedCommittedTurns = async (committedTurns: number): Promise<void> => {
    if (committedTurns < participants || committedTurns % participants !== 0) {
      throw new Error(
        `Seed size ${committedTurns} must be a positive multiple of ${participants}`,
      );
    }

    await prompt("Template wave");
    if (committedTurns === participants) {
      store.durations.length = 0;
      return;
    }

    const template = store.snapshot();
    const templateRun = template.coordinationRuns.find(({ id }) => id === runId);
    if (!templateRun) throw new Error("Template run disappeared");
    const templateTurns = template.coordinationTurns.filter(({ runId: id }) => id === runId);
    const templateAttempts = template.coordinationAttempts.filter(({ runId: id }) => id === runId);
    const templateArtifacts = template.coordinationArtifacts.filter(({ runId: id }) => id === runId);
    const templateEvents = template.coordinationEvents.filter(({ runId: id }) => id === runId);
    const user = templateArtifacts.find(
      (artifact): artifact is Extract<CoordinationArtifact, { type: "user_message" }> =>
        artifact.type === "user_message",
    );
    const messages = templateArtifacts.filter(
      (artifact): artifact is Extract<CoordinationArtifact, { type: "session_message" }> =>
        artifact.type === "session_message",
    );
    if (!user || templateTurns.length !== participants || messages.length !== participants) {
      throw new Error("Template wave does not contain the expected durable shape");
    }

    const waves = committedTurns / participants;
    await store.mutate((database) => {
      database.coordinationTurns = [];
      database.coordinationAttempts = [];
      database.coordinationArtifacts = [];
      database.coordinationEvents = [];

      let eventSequence = 1;
      let lastUserArtifactId = "";
      for (let wave = 0; wave < waves; wave += 1) {
        const userId = `seed-user-${wave + 1}`;
        const transcriptBase = wave * (participants + 1);
        lastUserArtifactId = userId;
        database.coordinationArtifacts.push({
          ...structuredClone(user),
          id: userId,
          transcriptSequence: transcriptBase + 1,
          payload: {
            schemaVersion: 1,
            type: "user_message",
            content: `Seed prompt ${wave + 1}: continue the shared objective.`,
          },
        });

        const turnMap = new Map<string, string>();
        const attemptMap = new Map<string, string>();
        const artifactMap = new Map<string, string>([[user.id, userId]]);
        templateTurns.forEach((source, index) => {
          const { activeAttemptId: _activeAttemptId, ...settledSource } = source;
          const turnId = `seed-turn-${wave + 1}-${index + 1}`;
          const outputArtifactId = `seed-message-${wave + 1}-${index + 1}`;
          turnMap.set(source.id, turnId);
          if (source.outputArtifactId) artifactMap.set(source.outputArtifactId, outputArtifactId);
          database.coordinationTurns.push({
            ...structuredClone(settledSource),
            id: turnId,
            sequence: wave * participants + index + 1,
            inputArtifactIds: [userId],
            inputThroughSequence: transcriptBase + 1,
            outputArtifactId,
          });
        });
        templateAttempts.forEach((source, index) => {
          const attemptId = `seed-attempt-${wave + 1}-${index + 1}`;
          attemptMap.set(source.id, attemptId);
          database.coordinationAttempts.push({
            ...structuredClone(source),
            id: attemptId,
            turnId: turnMap.get(source.turnId) ?? source.turnId,
            leaseToken: `seed-lease-${wave + 1}-${index + 1}`,
            agentRunId: `seed-agent-run-${wave + 1}-${index + 1}`,
          });
        });
        messages.forEach((source, index) => {
          const sourceTurnId = source.turnId;
          database.coordinationArtifacts.push({
            ...structuredClone(source),
            id: sourceTurnId
              ? (artifactMap.get(source.id) ?? `seed-message-${wave + 1}-${index + 1}`)
              : `seed-message-${wave + 1}-${index + 1}`,
            turnId: turnMap.get(sourceTurnId) ?? sourceTurnId,
            transcriptSequence: transcriptBase + index + 2,
          });
        });

        for (const source of templateEvents) {
          if (wave > 0 && source.type === "run.created") continue;
          database.coordinationEvents.push({
            ...structuredClone(source),
            id: `seed-event-${wave + 1}-${eventSequence}`,
            sequence: eventSequence,
            ...(source.turnId === undefined
              ? {}
              : { turnId: turnMap.get(source.turnId) ?? source.turnId }),
            ...(source.attemptId === undefined
              ? {}
              : { attemptId: attemptMap.get(source.attemptId) ?? source.attemptId }),
            ...(source.artifactId === undefined
              ? {}
              : { artifactId: artifactMap.get(source.artifactId) ?? source.artifactId }),
          });
          eventSequence += 1;
        }
      }

      const current = database.coordinationRuns.find(({ id }) => id === runId);
      if (!current) throw new Error("Seed run disappeared");
      Object.assign(current, structuredClone(templateRun), {
        id: runId,
        status: "awaiting_input",
        activeTurnIds: [],
        nextTurnSequence: committedTurns + 1,
        lastUserArtifactId,
        version: Math.max(templateRun.version, committedTurns * 3),
      });
    });
    store.durations.length = 0;
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
    seedCommittedTurns,
  };
};
