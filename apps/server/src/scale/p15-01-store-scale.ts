/**
 * P15-01 - measure the JSON store honestly.
 *
 * `JsonStore.mutate` deep-clones the whole database, serialises it, writes a
 * temp file, and renames - on every mutation - and one committed turn costs
 * roughly four of those. This harness drives a real session through the real
 * service, repository, workflow, and artifact protocol against a real
 * `JsonStore`, and records what that actually costs at 100, 500, 2,000, and
 * 10,000 committed turns.
 *
 * Nothing here is extrapolated: every reported row is measured at its own size
 * on one continuously growing session, which is the shape a long-lived session
 * actually has.
 *
 * The store lives in a fresh `mkdtemp` directory and the harness refuses to run
 * anywhere else, so it can never touch real runtime data.
 *
 * Usage:
 *   npm run scale:p15-01
 *   npm run scale:p15-01 -- --sizes=100,500 --participants=10 --keep
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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

/* ------------------------------------------------------------------ *
 * Instrumentation
 * ------------------------------------------------------------------ */

/**
 * Times every `mutate` without changing what it does.
 *
 * The post-mutation hook reads the already-cloned `next` database the store is
 * about to persist, so watching for a status change costs no extra snapshot -
 * which matters, because a snapshot is one of the things being measured.
 */
class MeasuredJsonStore extends JsonStore {
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
 * and the harness knows the size it is at without counting the ledger.
 */
class AlwaysCommittingRuntime implements CoordinationRuntime {
  constructor(private readonly content: string) {}

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
const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
};

const median = (values: number[]): number => percentile(values, 0.5);

const round = (value: number, places = 2): number =>
  Number.isFinite(value) ? Number(value.toFixed(places)) : Number.NaN;

const mib = (bytes: number): number => round(bytes / 1024 / 1024);

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

interface Measurement {
  committedTurns: number;
  prompts: number;
  /** Mutations of the final prompt, which all ran at this exact size. */
  mutations: number;
  mutationMedianMs: number;
  mutationP95Ms: number;
  mutationMaxMs: number;
  /** Every mutation since the previous row, spanning the growth between sizes. */
  growthMutations: number;
  growthMedianMs: number;
  growthP95Ms: number;
  databaseBytes: number;
  databaseMib: number;
  snapshotMs: number;
  snapshotHeapDeltaMib: number;
  rssAfterSnapshotMib: number;
  getRunDetailsMs: number;
  lastPromptMs: number;
}

const parseFlag = (name: string, fallback: string): string => {
  const hit = process.argv.slice(2).find((argument) => argument.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const hasFlag = (name: string): boolean => process.argv.slice(2).includes(`--${name}`);

/**
 * A realistic session message rather than a one-word stub: the file size and
 * clone cost being measured are dominated by stored content, so an unrealistically
 * short message would understate every number in the table.
 */
const MESSAGE_CONTENT =
  "Seller verification should land before any listing goes live, with an escrow " +
  "hold that releases payment only on confirmed delivery, and a reporting route " +
  "a moderator reads daily so disputes never sit unattended over a weekend.";

const main = async (): Promise<void> => {
  const sizes = parseFlag("sizes", "100,500,2000,10000")
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  const participants = Number.parseInt(parseFlag("participants", "10"), 10);

  if (sizes.length === 0) throw new Error("No valid --sizes given");
  if (!Number.isFinite(participants) || participants < SESSION_LIMITS.minParticipants) {
    throw new Error(`--participants must be at least ${SESSION_LIMITS.minParticipants}`);
  }
  for (const size of sizes) {
    if (size % participants !== 0) {
      throw new Error(
        `Size ${size} is not a whole number of waves; it must divide by --participants=${participants}`,
      );
    }
  }

  // Never against real runtime data (P15-01).
  const directory = await mkdtemp(path.join(os.tmpdir(), "p15-01-store-scale-"));
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

  const roster: CoordinationAgentView[] = Array.from({ length: participants }, (_unused, index) => ({
    id: `agent-scale-${index + 1}`,
    name: `Scale ${index + 1}`,
    status: "ready" as const,
  }));
  const agentDirectory: CoordinationAgentDirectory = {
    getAgentsByIds: async (wanted) => {
      const set = new Set(wanted);
      return roster.filter((agent) => set.has(agent.id)).map((agent) => ({ ...agent }));
    },
  };

  // Participant readiness and reservations are checked against the Agent
  // records in the store, not against the coordination directory, so the roster
  // has to exist there too. Seeded before measurement starts; the setup
  // mutation is excluded from the recorded latencies below.
  const now = clock.nowIso();
  await store.mutate((database) => {
    for (const agent of roster) {
      database.agents.push({
        id: agent.id,
        name: agent.name,
        description: `P15-01 scale participant ${agent.name}`,
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
  const verifiedProtocol = new VerifiedHandoffArtifactProtocol({ clock, ids });
  const sessionProtocol = new SharedSessionArtifactProtocol({ clock, ids });
  const service = new CoordinationService({
    agentDirectory,
    repository,
    workflow: new VerifiedHandoffWorkflowV1(),
    sessionWorkflow: new SharedSessionWorkflowV1(),
    contextBuilder: new RoleScopedContextBuilder(),
    artifactProtocol: new CoordinationArtifactProtocolDispatchV1(
      verifiedProtocol,
      sessionProtocol,
    ),
    runtime: new AlwaysCommittingRuntime(MESSAGE_CONTENT),
    clock,
    ids,
  });

  const request: CreateSessionRunRequest = {
    workflow: "shared_session_v1",
    name: "P15-01 scale measurement",
    objective: "Measure durable store cost as one session grows.",
    agents: roster.map((agent) => agent.id),
    policy: {
      // round_robin keeps every committed turn an ordinary participant message:
      // no coordinator plan turns, so `committed turns` means what the sheet says.
      sessionPlanning: "round_robin",
      sessionProtocol: "free_chat",
      maxTurns: SESSION_LIMITS.maxSessionTurns,
    },
  };

  const run = await service.createRun(request);
  const runId: CoordinationRunId = run.id;

  /** Resolves when the wave started by the next prompt has settled. */
  const settled = (): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      store.onMutation = (database) => {
        const current = database.coordinationRuns.find((candidate) => candidate.id === runId);
        if (!current) return;
        if (current.status === "awaiting_input") {
          store.onMutation = undefined;
          resolve(current.status);
        } else if (["completed", "failed", "stopped"].includes(current.status)) {
          store.onMutation = undefined;
          reject(new Error(`Session became ${current.status} before the wave finished`));
        }
      };
    });

  const prompt = async (index: number): Promise<number> => {
    const finished = settled();
    const started = performance.now();
    await service.resumeRun(runId, { content: `Prompt ${index}: continue the shared objective.` });
    await finished;
    return performance.now() - started;
  };

  const measurements: Measurement[] = [];
  let prompts = 0;
  let committed = 0;
  let mutationCursor = 0;
  let lastPromptMs = Number.NaN;

  const startedAt = performance.now();
  console.log(
    `P15-01 store scale: ${participants} participants, sizes ${sizes.join(", ")}\n` +
      `store: ${databasePath}\n`,
  );

  for (const size of sizes) {
    // Grow to one wave short of the target, so the final prompt below lands
    // exactly on `size` and every mutation it makes is measured at that size.
    while (committed < size - participants) {
      prompts += 1;
      lastPromptMs = await prompt(prompts);
      committed += participants;
    }

    // The growth window spans the sizes between the previous row and this one,
    // so it is reported separately rather than being read as a cost "at" a size.
    const growthWindow = store.durations.slice(mutationCursor);

    const atSizeCursor = store.durations.length;
    prompts += 1;
    lastPromptMs = await prompt(prompts);
    committed += participants;
    const window = store.durations.slice(atSizeCursor);
    mutationCursor = store.durations.length;

    const fileStat = await stat(databasePath);

    const heapBefore = process.memoryUsage().heapUsed;
    const snapshotStarted = performance.now();
    const snapshot = store.snapshot();
    const snapshotMs = performance.now() - snapshotStarted;
    const afterSnapshot = process.memoryUsage();
    // Referenced after the reading so the clone cannot be collected early.
    const retained = snapshot.coordinationTurns.length;

    const detailsStarted = performance.now();
    const details = await repository.getRunDetails(runId);
    const getRunDetailsMs = performance.now() - detailsStarted;

    const actual = details?.turns.filter((turn) => turn.status === "committed").length ?? 0;
    if (actual !== committed || retained !== committed) {
      throw new Error(`Expected ${committed} committed turns, ledger holds ${actual}/${retained}`);
    }

    const measurement: Measurement = {
      committedTurns: committed,
      prompts,
      mutations: window.length,
      mutationMedianMs: round(median(window)),
      mutationP95Ms: round(percentile(window, 0.95)),
      mutationMaxMs: round(Math.max(...window)),
      growthMutations: growthWindow.length,
      growthMedianMs: round(median(growthWindow)),
      growthP95Ms: round(percentile(growthWindow, 0.95)),
      databaseBytes: fileStat.size,
      databaseMib: mib(fileStat.size),
      snapshotMs: round(snapshotMs),
      snapshotHeapDeltaMib: mib(afterSnapshot.heapUsed - heapBefore),
      rssAfterSnapshotMib: mib(afterSnapshot.rss),
      getRunDetailsMs: round(getRunDetailsMs),
      lastPromptMs: round(lastPromptMs),
    };
    measurements.push(measurement);
    console.log(
      `${String(committed).padStart(6)} turns | ` +
        `mutate p50 ${measurement.mutationMedianMs}ms p95 ${measurement.mutationP95Ms}ms ` +
        `(${measurement.mutations} at size; growth p50 ${measurement.growthMedianMs}ms over ` +
        `${measurement.growthMutations}) | db ${measurement.databaseMib}MiB | ` +
        `snapshot ${measurement.snapshotMs}ms | getRunDetails ${measurement.getRunDetailsMs}ms | ` +
        `prompt ${round(measurement.lastPromptMs / 1000)}s`,
    );
  }

  const header =
    "| Committed turns | DB file | Mutation p50 | Mutation p95 | Mutation max | " +
    "`snapshot()` | Snapshot heap | RSS | `getRunDetails` | Last prompt end-to-end |";
  const divider = `|${"---|".repeat(10)}`;
  const rows = measurements.map(
    (row) =>
      `| ${row.committedTurns} | ${row.databaseMib} MiB | ${row.mutationMedianMs} ms | ` +
      `${row.mutationP95Ms} ms | ${row.mutationMaxMs} ms | ${row.snapshotMs} ms | ` +
      `${row.snapshotHeapDeltaMib} MiB | ${row.rssAfterSnapshotMib} MiB | ` +
      `${row.getRunDetailsMs} ms | ${round(row.lastPromptMs / 1000)} s |`,
  );
  const table = [header, divider, ...rows].join("\n");
  console.log(`\n${table}\n`);

  const report = {
    task: "P15-01",
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    participants,
    messageContentChars: MESSAGE_CONTENT.length,
    totalWallClockSeconds: round((performance.now() - startedAt) / 1000),
    measurements,
  };
  const reportPath = path.join(process.cwd(), "p15-01-store-scale.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`report: ${reportPath}`);
  console.log(`total wall clock: ${report.totalWallClockSeconds}s`);

  if (hasFlag("keep")) {
    console.log(`kept store directory: ${directory}`);
  } else {
    await rm(directory, { recursive: true, force: true });
  }
};

await main();
