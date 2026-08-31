import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import type { Agent } from "../types.js";
import {
  CoordinationArtifactProtocolDispatchV1,
  SharedSessionArtifactProtocol,
  VerifiedHandoffArtifactProtocol,
} from "./artifact-protocol.js";
import { RoleScopedContextBuilder } from "./context-builder.js";
import { DurableCoordinationRepository } from "./repository.js";
import { CoordinationService } from "./service.js";
import { SharedSessionWorkflowV1 } from "./session-workflow.js";
import { VerifiedHandoffWorkflowV1 } from "./workflow.js";
import { AdvancingClock, DeterministicIdGenerator } from "./testing/controls.js";
import {
  FakeAgentDirectory,
  ScriptedCoordinationRuntime,
  deferred,
  succeeds,
  type ScriptedRuntimeStep,
} from "./testing/fakes.js";
import {
  CREATE_FREE_CHAT_REQUEST,
  PARTICIPANT_ONE,
  PARTICIPANT_THREE,
  PARTICIPANT_TWO,
  SESSION_PARTICIPANTS,
  freeChatPayload,
} from "./testing/session-fixtures.js";
import {
  DEFAULT_COORDINATION_POLICY,
  DEFAULT_SESSION_AUCTION_POLICY,
} from "./types.js";
import type {
  AppendUserMessageInput,
  AppendUserMessageResult,
  AwardSessionBidInput,
  AwardSessionBidResult,
  BeginAttemptInput,
  BeginAttemptResult,
  CommitAcceptedArtifactInput,
  CommitAcceptedArtifactResult,
  CoordinationRepository,
  CreateRunRecordInput,
  FailTurnInput,
  FailTurnResult,
  FinishAttemptInput,
  NonTerminalRunSummary,
  RecordAwardFeedbackInput,
  RecordAwardFeedbackResult,
  ReconcileRunResult,
  ScheduleTurnInput,
  ScheduleTurnResult,
  ScheduleTurnsInput,
  ScheduleTurnsResult,
  StartRunCommitResult,
  WorkflowView,
} from "./contracts.js";
import type {
  AgentRunId,
  CoordinationArtifact,
  CoordinationArtifactId,
  CoordinationAttemptId,
  CoordinationErrorCode,
  CoordinationRun,
  CoordinationRunDetails,
  CoordinationRunId,
  CoordinationTurn,
  CoordinationTurnId,
  CreateSessionRunRequest,
  SessionAuctionPolicy,
  SessionAwardPayload,
  SessionBidPayload,
} from "./types.js";

/**
 * PA14-27 restart-reconciliation regressions.
 *
 * These run against the **durable** repository over a temporary `JsonStore`,
 * never the in-memory stand-in: `InMemoryCoordinationRepository.
 * interruptActiveRuns()` is a stub that settles nothing, so boot recovery -- the
 * behaviour under test -- only exists on the durable command.
 *
 * The boundary is reproduced by suspending the loop immediately *before* a
 * durable command is issued, so the store holds exactly what a killed process
 * leaves behind. Nothing is faked: no injected result, no clock, no sleep.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 5 }),
      ),
  );
});

const agentRow = (id: string, name: string): Agent => ({
  id,
  name,
  description: "",
  instructions: "",
  status: "ready",
  workspacePath: `/workspaces/${id}`,
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
});

/** The exact durable boundaries PA14-27 reproduced in production. */
type CrashPoint =
  /** Every bid of the round is committed; the award has not been written. */
  | "before_award"
  /** The award is committed and its execution turn is scheduled with 0 attempts. */
  | "before_execution_attempt";

/**
 * A repository that stops issuing commands at a chosen boundary.
 *
 * A killed process does not answer its own pending command differently -- it
 * never issues it. Returning a synthetic `stale`/`not_found` would send the loop
 * down a *different* code path that writes more durable state, so this suspends
 * instead: the command never reaches the durable repository, this process makes
 * no further transition, and the store is byte-identical to a `kill -9` at that
 * instant.
 */
class CrashingRepository implements CoordinationRepository {
  private crashPoint: CrashPoint | undefined;
  private announceCrash: (() => void) | undefined;

  /** Resolves once the loop has reached the configured boundary. */
  readonly crashed: Promise<void>;

  constructor(
    private readonly inner: DurableCoordinationRepository,
    private readonly store: JsonStore,
  ) {
    this.crashed = new Promise<void>((resolve) => {
      this.announceCrash = resolve;
    });
  }

  crashAt(point: CrashPoint): void {
    this.crashPoint = point;
  }

  private die<T>(): Promise<T> {
    this.crashPoint = undefined;
    this.announceCrash?.();
    // The process is gone from here on. Nothing resolves this.
    return new Promise<T>(() => undefined);
  }

  private turnKind(turnId: CoordinationTurnId): CoordinationTurn["kind"] | undefined {
    return this.store.snapshot().coordinationTurns.find(({ id }) => id === turnId)?.kind;
  }

  async awardSessionBid(input: AwardSessionBidInput): Promise<AwardSessionBidResult> {
    if (this.crashPoint === "before_award") return this.die<AwardSessionBidResult>();
    return this.inner.awardSessionBid(input);
  }

  async beginAttempt(input: BeginAttemptInput): Promise<BeginAttemptResult> {
    if (
      this.crashPoint === "before_execution_attempt" &&
      this.turnKind(input.turnId) === "session_turn"
    ) {
      return this.die<BeginAttemptResult>();
    }
    return this.inner.beginAttempt(input);
  }

  // ------------------------------------------------------- plain delegation
  listRuns(limit?: number): Promise<CoordinationRun[]> {
    return this.inner.listRuns(limit);
  }
  getRunDetails(id: CoordinationRunId): Promise<CoordinationRunDetails | undefined> {
    return this.inner.getRunDetails(id);
  }
  createRun(input: CreateRunRecordInput): Promise<CoordinationRun> {
    return this.inner.createRun(input);
  }
  startRun(id: CoordinationRunId): Promise<StartRunCommitResult> {
    return this.inner.startRun(id);
  }
  appendUserMessage(input: AppendUserMessageInput): Promise<AppendUserMessageResult> {
    return this.inner.appendUserMessage(input);
  }
  awaitInput(id: CoordinationRunId): Promise<CoordinationRun | undefined> {
    return this.inner.awaitInput(id);
  }
  endSession(id: CoordinationRunId) {
    return this.inner.endSession(id);
  }
  scheduleTurn(input: ScheduleTurnInput): Promise<ScheduleTurnResult> {
    return this.inner.scheduleTurn(input);
  }
  scheduleTurns(input: ScheduleTurnsInput): Promise<ScheduleTurnsResult> {
    return this.inner.scheduleTurns(input);
  }
  attachAgentRun(input: {
    attemptId: CoordinationAttemptId;
    leaseToken: string;
    agentRunId: AgentRunId;
  }): Promise<"attached" | "stale"> {
    return this.inner.attachAgentRun(input);
  }
  commitAcceptedArtifact(
    input: CommitAcceptedArtifactInput,
  ): Promise<CommitAcceptedArtifactResult> {
    return this.inner.commitAcceptedArtifact(input);
  }
  recordAwardFeedback(input: RecordAwardFeedbackInput): Promise<RecordAwardFeedbackResult> {
    return this.inner.recordAwardFeedback(input);
  }
  finishAttempt(input: FinishAttemptInput): Promise<"finished" | "stale"> {
    return this.inner.finishAttempt(input);
  }
  requestStop(id: CoordinationRunId): Promise<CoordinationRun | undefined> {
    return this.inner.requestStop(id);
  }
  finishStopped(id: CoordinationRunId): Promise<CoordinationRun | undefined> {
    return this.inner.finishStopped(id);
  }
  completeRun(input: {
    runId: CoordinationRunId;
    finalArtifactId: CoordinationArtifactId;
  }): Promise<CoordinationRun | undefined> {
    return this.inner.completeRun(input);
  }
  failRun(input: {
    runId: CoordinationRunId;
    code: CoordinationErrorCode;
    message: string;
  }): Promise<CoordinationRun | undefined> {
    return this.inner.failRun(input);
  }
  interruptActiveRuns(): Promise<CoordinationRunId[]> {
    return this.inner.interruptActiveRuns();
  }
  listNonTerminalRuns(): Promise<NonTerminalRunSummary[]> {
    return this.inner.listNonTerminalRuns();
  }
  reconcileRun(input: { runId: CoordinationRunId; reason: string }): Promise<ReconcileRunResult> {
    return this.inner.reconcileRun(input);
  }
  failTurn(input: FailTurnInput): Promise<FailTurnResult> {
    return this.inner.failTurn(input);
  }
}

const buildService = (
  repository: CoordinationRepository,
  runtime: ScriptedCoordinationRuntime,
  clock: AdvancingClock,
  ids: DeterministicIdGenerator,
): CoordinationService =>
  new CoordinationService({
    agentDirectory: new FakeAgentDirectory(SESSION_PARTICIPANTS),
    repository,
    workflow: new VerifiedHandoffWorkflowV1(),
    sessionWorkflow: new SharedSessionWorkflowV1(),
    contextBuilder: new RoleScopedContextBuilder(),
    artifactProtocol: new CoordinationArtifactProtocolDispatchV1(
      new VerifiedHandoffArtifactProtocol({ clock, ids }),
      new SharedSessionArtifactProtocol({ clock, ids }),
    ),
    runtime,
    clock,
    ids,
    // Every sweep in these tests is driven explicitly, never by a wall clock.
    reconcileIntervalMs: 0,
  });

const createHarness = async (steps: ScriptedRuntimeStep[]) => {
  const root = await mkdtemp(path.join(tmpdir(), "relay-auction-restart-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.agents.push(
      agentRow(PARTICIPANT_ONE.id, PARTICIPANT_ONE.name),
      agentRow(PARTICIPANT_TWO.id, PARTICIPANT_TWO.name),
      agentRow(PARTICIPANT_THREE.id, PARTICIPANT_THREE.name),
    );
  });

  // One clock and one id generator for the whole process, exactly as `index.ts`
  // composes them: the repository mints event ids while the artifact protocol
  // mints artifact ids, and two generators would mint the same id twice.
  const clock = new AdvancingClock();
  const ids = new DeterministicIdGenerator();
  const durable = new DurableCoordinationRepository({ store, clock, ids });
  const crashing = new CrashingRepository(durable, store);
  const runtime = new ScriptedCoordinationRuntime(steps);
  const service = buildService(crashing, runtime, clock, ids);
  return { store, durable, crashing, runtime, service, clock, ids };
};

/**
 * A restart: a fresh service over the same durable state, exactly as `index.ts`
 * boots. The id generator carries on rather than restarting, because a real
 * restart never reissues an id the previous process already committed.
 */
const restart = (
  durable: DurableCoordinationRepository,
  clock: AdvancingClock,
  ids: DeterministicIdGenerator,
  steps: ScriptedRuntimeStep[],
) => {
  const runtime = new ScriptedCoordinationRuntime(steps);
  return { service: buildService(durable, runtime, clock, ids), runtime };
};

/**
 * Yields one turn of the event loop. The durable store performs real file I/O,
 * which resolves on the macrotask queue, so draining microtasks alone spins
 * forever. This waits for the queue to drain, never for a duration.
 */
const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

const SETTLED = new Set(["awaiting_input", "completed", "failed", "stopped"]);

const settle = async (
  service: CoordinationService,
  runId: CoordinationRunId,
  ticks = 4_000,
): Promise<CoordinationRunDetails> => {
  for (let index = 0; index < ticks; index += 1) {
    const details = await service.getRun(runId);
    if (details && SETTLED.has(details.run.status)) return details;
    await tick();
  }
  throw new Error("session run did not settle");
};

const auctionRequest = (
  auctionPolicy: Partial<SessionAuctionPolicy> = {},
): CreateSessionRunRequest => ({
  ...CREATE_FREE_CHAT_REQUEST,
  policy: {
    sessionProtocol: "free_chat",
    maxTurns: 20,
    auctionPolicy: {
      ...DEFAULT_SESSION_AUCTION_POLICY,
      routingMode: "auction",
      ...auctionPolicy,
    },
  },
});

const bidOutput = (
  mode: SessionBidPayload["plan"]["mode"],
  agentIds: readonly string[],
  confidenceBps = 7_000,
): string =>
  JSON.stringify({
    schemaVersion: 1,
    type: "session_bid",
    recommendation: "auction",
    plan: {
      summary: `Coordinate ${agentIds.length} participant(s).`,
      mode,
      assignments: agentIds.map((agentId, index) => ({
        agentId,
        position: index + 1,
        instruction: `Publish step ${index + 1}.`,
      })),
      risks: [],
      assumptions: [],
    },
    confidenceBps,
    estimatedOutputTokens: 900,
  } satisfies SessionBidPayload);

/**
 * The three bids of a round. Participant One bids highest with a single-Agent
 * plan naming itself, so the award and its one assignment are deterministic.
 */
const ROUND_BIDS: ScriptedRuntimeStep[] = [
  succeeds(bidOutput("single", [PARTICIPANT_ONE.id], 9_000)),
  succeeds(bidOutput("single", [PARTICIPANT_TWO.id], 6_000)),
  succeeds(bidOutput("single", [PARTICIPANT_THREE.id], 6_000)),
];

const startRound = async (steps: ScriptedRuntimeStep[], request = auctionRequest()) => {
  const context = await createHarness(steps);
  const run = await context.service.createRun(request);
  await context.service.resumeRun(run.id, { content: "Review the deployment plan." });
  return { ...context, runId: run.id };
};

/** Drives one auction round to the chosen boundary and stops the process there. */
const crashAtBoundary = async (point: CrashPoint, steps: ScriptedRuntimeStep[]) => {
  const context = await startRound(steps);
  context.crashing.crashAt(point);
  await context.crashing.crashed;
  return context;
};

const detailsOf = async (
  durable: DurableCoordinationRepository,
  runId: CoordinationRunId,
): Promise<CoordinationRunDetails> => {
  const details = await durable.getRunDetails(runId);
  if (!details) throw new Error("expected durable run details");
  return details;
};

const typeCounts = (details: CoordinationRunDetails, type: CoordinationArtifact["type"]): number =>
  details.artifacts.filter((artifact) => artifact.type === type).length;

describe("PA14-27 recovery at the pre-award boundary", () => {
  it("keeps an auction round with settled bids and no award resumable", async () => {
    const context = await crashAtBoundary("before_award", ROUND_BIDS);

    // The exact production boundary: every bid committed, no award, no active
    // turn, run still running.
    const boundary = await detailsOf(context.durable, context.runId);
    expect(boundary.run.status).toBe("running");
    expect(boundary.run.activeTurnIds).toEqual([]);
    expect(boundary.turns.filter(({ kind }) => kind === "session_bid")).toHaveLength(3);
    expect(boundary.turns.every(({ status }) => status === "committed")).toBe(true);
    expect(typeCounts(boundary, "session_award")).toBe(0);

    expect(await context.durable.interruptActiveRuns()).toEqual([context.runId]);

    const after = await detailsOf(context.durable, context.runId);
    // The round still has work to do, so boot recovery must not park it in
    // `awaiting_input`, where nothing ever re-derives the award.
    expect(after.run.status).toBe("running");
    expect(after.events.map(({ type }) => type)).toContain("run.interrupted");
    expect(after.events.map(({ type }) => type)).not.toContain("run.awaiting_input");
    expect(after.run.errorCode).toBeUndefined();
    // The settled bids are evidence and are never disturbed by recovery.
    expect(after.turns.filter(({ status }) => status === "committed")).toHaveLength(3);
    expect(typeCounts(after, "session_bid")).toBe(3);
    expect(await context.durable.listReservedAgentIds()).toEqual([]);
  });

  it("awards and executes the interrupted round after a restart", async () => {
    const context = await crashAtBoundary("before_award", ROUND_BIDS);

    // The restarted process scripts only the awarded execution. Any bid it
    // reran would consume this step and fail validation instead.
    const resumed = restart(context.durable, context.clock, context.ids, [
      succeeds(JSON.stringify(freeChatPayload("Deployment plan reviewed."))),
    ]);
    await resumed.service.initialize();
    const after = await settle(resumed.service, context.runId);

    expect(after.run.status).toBe("awaiting_input");
    expect(typeCounts(after, "session_bid")).toBe(3);
    expect(typeCounts(after, "session_award")).toBe(1);
    const award = after.artifacts.find(({ type }) => type === "session_award");
    expect(award?.type === "session_award" ? award.payload.outcome : undefined).toBe(
      "execute_plan",
    );
    expect(award?.type === "session_award" ? award.payload.selectedAgentId : undefined).toBe(
      PARTICIPANT_ONE.id,
    );
    expect(typeCounts(after, "session_message")).toBe(1);
    // Exactly one execution turn ran, and it committed.
    const executions = after.turns.filter(({ kind }) => kind === "session_turn");
    expect(executions).toHaveLength(1);
    expect(executions[0]?.status).toBe("committed");
    expect(resumed.runtime.starts).toHaveLength(1);
    await resumed.service.shutdown();
  });

  it("changes nothing on a second initialize once the recovered round has settled", async () => {
    const context = await crashAtBoundary("before_award", ROUND_BIDS);
    const resumed = restart(context.durable, context.clock, context.ids, [
      succeeds(JSON.stringify(freeChatPayload("Deployment plan reviewed."))),
    ]);
    await resumed.service.initialize();
    await settle(resumed.service, context.runId);

    const before = JSON.stringify(await resumed.service.getRun(context.runId));
    await resumed.service.initialize();
    await tick();
    expect(JSON.stringify(await resumed.service.getRun(context.runId))).toBe(before);
    await resumed.service.shutdown();
  });
});

describe("PA14-27 recovery at the post-award boundary", () => {
  it("cancels rather than fails the interrupted awarded execution turn", async () => {
    const context = await crashAtBoundary("before_execution_attempt", ROUND_BIDS);

    const boundary = await detailsOf(context.durable, context.runId);
    const scheduled = boundary.turns.find(({ kind }) => kind === "session_turn");
    expect(scheduled).toMatchObject({ status: "scheduled", attemptCount: 0 });
    expect(boundary.run.activeTurnIds).toEqual([scheduled?.id]);
    expect(typeCounts(boundary, "session_award")).toBe(1);

    expect(await context.durable.interruptActiveRuns()).toEqual([context.runId]);

    const after = await detailsOf(context.durable, context.runId);
    // `failed` is the bug: the award branch reads a failed award-execution turn
    // as a genuine Agent failure and refuses to re-schedule the assignment.
    expect(after.turns.find(({ id }) => id === scheduled?.id)?.status).toBe("cancelled");
    expect(after.run.activeTurnIds).toEqual([]);
    expect(after.run.status).toBe("running");
    expect(after.events.map(({ type }) => type)).not.toContain("run.awaiting_input");
    expect(typeCounts(after, "session_award")).toBe(1);
  });

  it("executes the committed award after a restart without re-awarding it", async () => {
    const context = await crashAtBoundary("before_execution_attempt", ROUND_BIDS);
    const awardBefore = (await detailsOf(context.durable, context.runId)).artifacts.find(
      ({ type }) => type === "session_award",
    );

    const resumed = restart(context.durable, context.clock, context.ids, [
      succeeds(JSON.stringify(freeChatPayload("Deployment plan reviewed."))),
    ]);
    await resumed.service.initialize();
    const after = await settle(resumed.service, context.runId);

    expect(after.run.status).toBe("awaiting_input");
    expect(typeCounts(after, "session_award")).toBe(1);
    expect(after.artifacts.find(({ type }) => type === "session_award")).toEqual(awardBefore);
    expect(typeCounts(after, "session_message")).toBe(1);
    expect(typeCounts(after, "session_bid")).toBe(3);
    const committedExecutions = after.turns.filter(
      ({ kind, status }) => kind === "session_turn" && status === "committed",
    );
    expect(committedExecutions).toHaveLength(1);
    expect(committedExecutions[0]?.agentId).toBe(PARTICIPANT_ONE.id);
    await resumed.service.shutdown();
  });
});

describe("PA14-27 recovery gates that must not move", () => {
  it("returns a legacy free-chat session interrupted mid-attempt to awaiting_input", async () => {
    // No `auctionPolicy`: absence is the legacy marker, and Phase 11/12
    // semantics are unchanged -- the interrupted wave is failed and the session
    // goes idle for the user to re-ask.
    const context = await startRound([deferred()], {
      ...CREATE_FREE_CHAT_REQUEST,
      policy: { sessionProtocol: "free_chat", maxTurns: 9 },
    });
    await context.runtime.waitForStarts(1);

    expect(await context.durable.interruptActiveRuns()).toEqual([context.runId]);

    const after = await detailsOf(context.durable, context.runId);
    expect(after.run.policy.auctionPolicy).toBeUndefined();
    expect(after.run.status).toBe("awaiting_input");
    expect(after.run.activeTurnIds).toEqual([]);
    expect(after.turns.every(({ status }) => status === "failed")).toBe(true);
    expect(after.events.map(({ type }) => type)).toContain("run.awaiting_input");
    expect(await context.durable.listReservedAgentIds()).toEqual([]);
  });

  it("returns a direct round interrupted mid-execution to awaiting_input", async () => {
    // A direct round schedules an execution turn and never a bid, so a restart
    // leaves no settled evidence to re-derive from. Direct rounds deliberately
    // keep today's semantics: the session goes idle for the user to re-ask.
    const context = await startRound([deferred()], auctionRequest({ routingMode: "direct" }));
    await context.runtime.waitForStarts(1);

    expect(await context.durable.interruptActiveRuns()).toEqual([context.runId]);

    const after = await detailsOf(context.durable, context.runId);
    expect(after.run.status).toBe("awaiting_input");
    expect(after.events.map(({ type }) => type)).toContain("run.awaiting_input");
    expect(after.turns.filter(({ kind }) => kind === "session_bid")).toHaveLength(0);
    expect(after.turns.every(({ status }) => status === "failed")).toBe(true);
    expect(typeCounts(after, "session_award")).toBe(0);
  });

  it("keeps an auction round interrupted mid-bid-wave running on its settled evidence", async () => {
    // Only the first bidder started. The round still resolves from whatever
    // settles, so recovery keeps it resumable rather than discarding the wave.
    const context = await startRound([deferred()]);
    await context.runtime.waitForStarts(1);

    expect(await context.durable.interruptActiveRuns()).toEqual([context.runId]);

    const after = await detailsOf(context.durable, context.runId);
    expect(after.run.status).toBe("running");
    expect(after.run.activeTurnIds).toEqual([]);
    expect(after.events.map(({ type }) => type)).not.toContain("run.awaiting_input");
    expect(after.turns.filter(({ kind }) => kind === "session_bid")).toHaveLength(3);
    expect(await context.durable.listReservedAgentIds()).toEqual([]);
  });
});

// ------------------------------------------------- workflow-level derivation

const NOW = "2026-08-31T00:00:00.000Z";
const RUN_ID = "run-session";
const USER_ID = "user-artifact-1";
const AWARD_ID = "award-artifact-1";
const BID_ID = "artifact-bid-1";
const BID_TURN_ID = "turn-bid-1";

const workflow = new SharedSessionWorkflowV1();

const awardedRun = (): CoordinationRun => ({
  id: RUN_ID,
  name: "Session",
  objective: "Work together",
  requiredSections: [],
  participants: SESSION_PARTICIPANTS.map((agent) => ({
    role: "participant" as const,
    agentId: agent.id,
    agentNameSnapshot: agent.name,
  })),
  policy: {
    ...DEFAULT_COORDINATION_POLICY,
    workflow: "shared_session_v1",
    sessionProtocol: "free_chat",
    maxTurns: 20,
    auctionPolicy: { ...DEFAULT_SESSION_AUCTION_POLICY, routingMode: "auction" },
  },
  status: "running",
  phase: "sessioning",
  revision: 0,
  nextTurnSequence: 1,
  activeTurnIds: [],
  lastUserArtifactId: USER_ID,
  version: 5,
  createdAt: NOW,
  updatedAt: NOW,
});

const userArtifact = (): CoordinationArtifact => ({
  id: USER_ID,
  runId: RUN_ID,
  type: "user_message",
  payload: { schemaVersion: 1, type: "user_message", content: "Review the deployment plan" },
  createdBy: { kind: "user" },
  transcriptSequence: 1,
  sizeChars: 27,
  createdAt: NOW,
});

const winningBidTurn = (): CoordinationTurn => ({
  id: BID_TURN_ID,
  runId: RUN_ID,
  sequence: 1,
  role: "participant",
  agentId: PARTICIPANT_ONE.id,
  kind: "session_bid",
  wavePurpose: "session_bidding",
  status: "committed",
  attemptCount: 1,
  inputArtifactIds: [USER_ID],
  outputArtifactId: BID_ID,
  lastValidationErrors: [],
  createdAt: NOW,
  completedAt: NOW,
});

const winningBidArtifact = (): CoordinationArtifact => ({
  id: BID_ID,
  runId: RUN_ID,
  turnId: BID_TURN_ID,
  createdByRole: "participant",
  createdByAgentId: PARTICIPANT_ONE.id,
  type: "session_bid",
  payload: {
    schemaVersion: 1,
    type: "session_bid",
    recommendation: "auction",
    plan: {
      summary: "Answer directly.",
      mode: "single",
      assignments: [
        { agentId: PARTICIPANT_ONE.id, position: 1, instruction: "Publish the review." },
      ],
      risks: [],
      assumptions: [],
    },
    confidenceBps: 9_000,
    estimatedOutputTokens: 900,
  },
  sizeChars: 200,
  createdAt: NOW,
});

const awardArtifact = (): CoordinationArtifact => ({
  id: AWARD_ID,
  runId: RUN_ID,
  type: "session_award",
  createdBy: { kind: "system" },
  payload: {
    schemaVersion: 1,
    type: "session_award",
    userArtifactId: USER_ID,
    winningBidArtifactId: BID_ID,
    selectedAgentId: PARTICIPANT_ONE.id,
    outcome: "execute_plan",
    scoringVersion: "confidence_cost_v1",
    scoreBps: 5_000,
    components: {
      calibratedConfidenceBps: 6_500,
      normalizedProjectedCostBps: 500,
      reliabilityPenaltyBps: 0,
    },
    estimatedExecution: { inputTokens: 1_000, outputTokens: 900 },
  } satisfies SessionAwardPayload,
  sizeChars: 256,
  createdAt: NOW,
});

const EXECUTION_TURN_ID = "turn-exec-1";
const EXECUTION_MESSAGE_ID = "artifact-msg-1";

const awardExecutionTurn = (status: CoordinationTurn["status"]): CoordinationTurn => ({
  id: EXECUTION_TURN_ID,
  runId: RUN_ID,
  sequence: 2,
  role: "participant",
  agentId: PARTICIPANT_ONE.id,
  kind: "session_turn",
  wavePurpose: "session_execution",
  status,
  attemptCount: status === "cancelled" ? 0 : 2,
  inputArtifactIds: [USER_ID, AWARD_ID],
  threadPolicy: "fresh",
  ...(status === "committed" ? { outputArtifactId: EXECUTION_MESSAGE_ID } : {}),
  lastValidationErrors: [],
  createdAt: NOW,
  completedAt: NOW,
});

const executionMessage = (): CoordinationArtifact => ({
  id: EXECUTION_MESSAGE_ID,
  runId: RUN_ID,
  turnId: EXECUTION_TURN_ID,
  createdByRole: "participant",
  createdByAgentId: PARTICIPANT_ONE.id,
  type: "session_message",
  payload: { schemaVersion: 1, type: "session_message", content: "Deployment plan reviewed." },
  transcriptSequence: 2,
  sizeChars: 25,
  createdAt: NOW,
});

const awardedView = (executionStatus: CoordinationTurn["status"]): WorkflowView => {
  const turns = [winningBidTurn(), awardExecutionTurn(executionStatus)];
  return {
    run: {
      ...awardedRun(),
      nextTurnSequence: Math.max(...turns.map(({ sequence }) => sequence)) + 1,
    },
    turns,
    artifacts: [
      userArtifact(),
      winningBidArtifact(),
      awardArtifact(),
      ...(executionStatus === "committed" ? [executionMessage()] : []),
    ],
  };
};

describe("PA14-27 awarded-execution derivation", () => {
  it("re-schedules the assignment of a recovery-cancelled award-execution turn", () => {
    expect(workflow.decideNext(awardedView("cancelled"))).toMatchObject({
      kind: "schedule",
      role: "participant",
      agentId: PARTICIPANT_ONE.id,
      turnKind: "session_turn",
      expectedArtifactType: "session_message",
      threadPolicy: "fresh",
    });
  });

  it("still fails the round when the awarded execution genuinely failed", () => {
    // PA14-13: a real awarded-execution failure fails the round and never
    // promotes a runner-up.
    expect(workflow.decideNext(awardedView("failed"))).toMatchObject({
      kind: "fail",
      code: "MAX_ATTEMPTS_EXCEEDED",
    });
  });

  it("awaits input once the assignment has a committed award-execution turn", () => {
    expect(workflow.decideNext(awardedView("committed"))).toEqual({ kind: "await_input" });
  });
});
