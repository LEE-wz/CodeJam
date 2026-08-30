import { describe, expect, it } from "vitest";
import type {
  ArtifactProtocol,
  Clock,
  ContextBuilder,
  CoordinationAgentDirectory,
  CoordinationRepository,
  CoordinationRuntime,
  IdGenerator,
  VerifiedHandoffWorkflow,
} from "./contracts.js";
import { RoleScopedContextBuilder } from "./context-builder.js";
import { CoordinationService } from "./service.js";
import type {
  CoordinationArtifact,
  CoordinationAttempt,
  CoordinationRun,
  CoordinationRunDetails,
  CoordinationTurn,
  CreateCoordinationRunRequest,
} from "./types.js";

const request: CreateCoordinationRunRequest = {
  name: "Launch review",
  objective: "Prepare a launch plan",
  requiredSections: [
    { key: "users", title: "Target users" },
    { key: "risks", title: "Risks" },
  ],
  agents: {
    plannerAgentId: "planner-agent",
    criticAgentId: "critic-agent",
    finalizerAgentId: "finalizer-agent",
  },
};

class TestIds implements IdGenerator {
  private count = 0;

  private next(prefix: string): string {
    this.count += 1;
    return prefix + "-" + this.count;
  }

  runId(): string {
    return this.next("run");
  }

  turnId(): string {
    return this.next("turn");
  }

  attemptId(): string {
    return this.next("attempt");
  }

  artifactId(): string {
    return this.next("artifact");
  }

  eventId(): string {
    return this.next("event");
  }

  leaseToken(): string {
    return this.next("lease");
  }
}

const clock: Clock = { nowIso: () => "2026-08-29T00:00:00.000Z" };

class MemoryRepository implements CoordinationRepository {
  private readonly runs = new Map<string, CoordinationRun>();
  private readonly turns: CoordinationTurn[] = [];
  private readonly attempts: CoordinationAttempt[] = [];
  private readonly artifacts: CoordinationArtifact[] = [];

  async listRuns(): Promise<CoordinationRun[]> {
    return [...this.runs.values()].map((run) => structuredClone(run));
  }

  async getRunDetails(id: string): Promise<CoordinationRunDetails | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    return {
      run: structuredClone(run),
      turns: this.turns.filter((turn) => turn.runId === id).map((turn) => structuredClone(turn)),
      attempts: this.attempts
        .filter((attempt) => attempt.runId === id)
        .map((attempt) => structuredClone(attempt)),
      artifacts: this.artifacts
        .filter((artifact) => artifact.runId === id)
        .map((artifact) => structuredClone(artifact)),
      events: [],
    };
  }

  async createRun(input: { run: CoordinationRun }): Promise<CoordinationRun> {
    this.runs.set(input.run.id, structuredClone(input.run));
    return structuredClone(input.run);
  }

  async startRun(id: string) {
    const run = this.runs.get(id);
    if (!run) return { kind: "not_found" as const };
    if (run.status !== "created") {
      return {
        kind: "conflict" as const,
        code: "INVALID_STATE" as const,
        message: "Coordination run is already active",
      };
    }
    run.status = "running";
    run.startedAt = clock.nowIso();
    run.updatedAt = clock.nowIso();
    return { kind: "started" as const, run: structuredClone(run) };
  }

  async scheduleTurn(input: {
    runId: string;
    expectedRunVersion: number;
    turn: CoordinationTurn;
    nextPhase: CoordinationRun["phase"];
    nextRevision: number;
  }) {
    const run = this.runs.get(input.runId);
    if (!run) return { kind: "not_found" as const };
    if (run.status !== "running" || run.version !== input.expectedRunVersion) {
      return { kind: "stale" as const, currentRun: structuredClone(run) };
    }
    const turn = structuredClone(input.turn);
    this.turns.push(turn);
    run.activeTurnId = turn.id;
    run.nextTurnSequence += 1;
    run.phase = input.nextPhase;
    run.revision = input.nextRevision;
    run.version += 1;
    return { kind: "scheduled" as const, run: structuredClone(run), turn: structuredClone(turn) };
  }

  async beginAttempt(input: { runId: string; turnId: string; attempt: CoordinationAttempt }) {
    const run = this.runs.get(input.runId);
    const turn = this.turns.find((item) => item.id === input.turnId);
    if (!run || !turn) return { kind: "not_found" as const };
    if (run.status !== "running" || turn.status !== "scheduled") {
      return { kind: "stale" as const };
    }
    const attempt = structuredClone(input.attempt);
    this.attempts.push(attempt);
    turn.status = "running";
    turn.activeAttemptId = attempt.id;
    turn.attemptCount += 1;
    return { kind: "started" as const, run: structuredClone(run), turn: structuredClone(turn) };
  }

  async attachAgentRun(): Promise<"attached" | "stale"> {
    return "attached";
  }

  async commitAcceptedArtifact(input: {
    runId: string;
    turnId: string;
    attemptId: string;
    leaseToken: string;
    artifact: CoordinationArtifact;
  }) {
    const run = this.runs.get(input.runId);
    const turn = this.turns.find((item) => item.id === input.turnId);
    const attempt = this.attempts.find((item) => item.id === input.attemptId);
    if (!run || !turn || !attempt) return { kind: "not_found" as const };
    if (
      run.status !== "running" ||
      turn.activeAttemptId !== input.attemptId ||
      attempt.leaseToken !== input.leaseToken
    ) {
      return { kind: "stale" as const };
    }
    attempt.status = "succeeded";
    turn.status = "committed";
    turn.activeAttemptId = undefined;
    turn.outputArtifactId = input.artifact.id;
    run.activeTurnId = undefined;
    run.version += 1;
    this.artifacts.push(structuredClone(input.artifact));
    return {
      kind: "committed" as const,
      run: structuredClone(run),
      turn: structuredClone(turn),
      artifact: structuredClone(input.artifact),
    };
  }

  async finishAttempt(input: {
    runId: string;
    turnId: string;
    attemptId: string;
    leaseToken: string;
    status: "invalid_output" | "timed_out" | "failed" | "cancelled";
    errorCode: CoordinationAttempt["errorCode"];
    errorMessage: string;
    validationErrors?: string[];
  }): Promise<"finished" | "stale"> {
    const run = this.runs.get(input.runId);
    const turn = this.turns.find((item) => item.id === input.turnId);
    const attempt = this.attempts.find((item) => item.id === input.attemptId);
    if (
      !run ||
      !turn ||
      !attempt ||
      run.status !== "running" ||
      turn.activeAttemptId !== input.attemptId ||
      attempt.leaseToken !== input.leaseToken
    ) {
      return "stale";
    }
    attempt.status = input.status;
    attempt.errorCode = input.errorCode;
    attempt.errorMessage = input.errorMessage;
    turn.activeAttemptId = undefined;
    turn.lastValidationErrors = input.validationErrors ?? [];
    turn.status = input.status === "cancelled" ? "cancelled" : "scheduled";
    if (input.status === "cancelled") run.activeTurnId = undefined;
    return "finished";
  }

  async requestStop(id: string): Promise<CoordinationRun | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    if (run.status === "running") run.status = "stop_requested";
    return structuredClone(run);
  }

  async finishStopped(id: string): Promise<CoordinationRun | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    run.status = "stopped";
    run.stoppedAt = clock.nowIso();
    run.activeTurnId = undefined;
    return structuredClone(run);
  }

  async completeRun(input: { runId: string; finalArtifactId: string }): Promise<CoordinationRun | undefined> {
    const run = this.runs.get(input.runId);
    if (!run || run.status !== "running") return undefined;
    run.status = "completed";
    run.phase = "done";
    run.finalArtifactId = input.finalArtifactId;
    run.completedAt = clock.nowIso();
    return structuredClone(run);
  }

  async failRun(input: { runId: string; code: NonNullable<CoordinationRun["errorCode"]>; message: string }) {
    const run = this.runs.get(input.runId);
    if (!run) return undefined;
    run.status = "failed";
    run.errorCode = input.code;
    run.errorMessage = input.message;
    return structuredClone(run);
  }

  async interruptActiveRuns(): Promise<string[]> {
    return [];
  }

  async listNonTerminalRuns() {
    return [...this.runs.values()]
      .filter((run) => run.status === "running" || run.status === "stop_requested")
      .map((run) => ({
        runId: run.id,
        status: run.status as "running" | "stop_requested",
        ...(run.activeTurnId === undefined ? {} : { activeTurnId: run.activeTurnId }),
        hasRunningAttempt: this.attempts.some(
          (attempt) => attempt.runId === run.id && attempt.status === "running",
        ),
      }));
  }

  async reconcileRun(input: { runId: string; reason: string }) {
    const run = this.runs.get(input.runId);
    if (!run) return { kind: "not_found" as const };
    if (run.status === "completed" || run.status === "failed" || run.status === "stopped") {
      return { kind: "terminal" as const, run: structuredClone(run) };
    }
    if (run.status !== "running") {
      return { kind: "owned" as const, run: structuredClone(run) };
    }
    if (run.activeTurnId === undefined) {
      return { kind: "noop" as const, run: structuredClone(run) };
    }
    const turn = this.turns.find((candidate) => candidate.id === run.activeTurnId);
    if (turn) {
      const attempt = this.attempts.find((candidate) => candidate.id === turn.activeAttemptId);
      if (attempt && attempt.status === "running") attempt.status = "cancelled";
      turn.status = "failed";
      delete turn.activeAttemptId;
    }
    delete run.activeTurnId;
    return { kind: "reconciled" as const, run: structuredClone(run) };
  }
}

class ScriptedRuntime implements CoordinationRuntime {
  readonly inputs: Array<{ agentId: string; prompt: string }> = [];

  constructor(private readonly outputs: string[], private readonly pending = false) {}

  async start(input: { agentId: string; prompt: string }): Promise<
    | { kind: "started"; handle: { agentRunId: string; completion: Promise<{ kind: "succeeded"; rawOutput: string }> } }
    | { kind: "failed"; message: string }
  > {
    this.inputs.push({ agentId: input.agentId, prompt: input.prompt });
    const output = this.outputs.shift() ?? "final";
    return {
      kind: "started",
      handle: {
        agentRunId: "agent-run-" + this.inputs.length,
        completion: this.pending
          ? new Promise(() => undefined)
          : Promise.resolve({ kind: "succeeded", rawOutput: output }),
      },
    };
  }

  async cancelAttempt(): Promise<boolean> {
    return true;
  }
}

const agents: CoordinationAgentDirectory = {
  async getAgentsByIds(ids) {
    return ids.map((id) => ({ id, name: id + " name", status: "ready" as const }));
  },
};

const workflow: VerifiedHandoffWorkflow = {
  decideNext({ artifacts }) {
    if (!artifacts.some((artifact) => artifact.type === "proposal")) {
      return {
        kind: "schedule",
        role: "planner",
        turnKind: "initial_proposal",
        phase: "drafting",
        revision: 0,
        inputArtifactIds: [],
        expectedArtifactType: "proposal",
      };
    }
    if (!artifacts.some((artifact) => artifact.type === "review")) {
      return {
        kind: "schedule",
        role: "critic",
        turnKind: "proposal_review",
        phase: "reviewing",
        revision: 0,
        inputArtifactIds: [],
        expectedArtifactType: "review",
      };
    }
    if (!artifacts.some((artifact) => artifact.type === "final")) {
      return {
        kind: "schedule",
        role: "finalizer",
        turnKind: "finalization",
        phase: "finalizing",
        revision: 0,
        inputArtifactIds: [],
        expectedArtifactType: "final",
      };
    }
    const final = artifacts.find((artifact) => artifact.type === "final");
    if (!final) throw new Error("final artifact is missing");
    return { kind: "complete", finalArtifactId: final.id };
  },
};

const contextBuilder: ContextBuilder = {
  build({ turn, retryValidationErrors }) {
    return {
      prompt: turn.role + (retryValidationErrors.length ? " retry" : ""),
      promptDigest: "digest-" + turn.id,
      truncated: false,
    };
  },
};

function protocol(ids: IdGenerator): ArtifactProtocol {
  return {
    validate({ attempt, rawOutput, run, turn }) {
      if (rawOutput === "invalid") {
        return {
          ok: false,
          code: "INVALID_AGENT_OUTPUT",
          errors: [{ path: "type", code: "invalid_type", message: "Expected role artifact" }],
        };
      }
      if (turn.role === "planner") {
        return {
          ok: true,
          artifact: {
            id: ids.artifactId(),
            runId: run.id,
            turnId: turn.id,
            createdByRole: turn.role,
            createdByAgentId: attempt.agentId,
            sizeChars: 1,
            createdAt: clock.nowIso(),
            type: "proposal",
            payload: { schemaVersion: 1, type: "proposal", summary: "p", sections: [] },
          },
        };
      }
      if (turn.role === "critic") {
        return {
          ok: true,
          artifact: {
            id: ids.artifactId(),
            runId: run.id,
            turnId: turn.id,
            createdByRole: turn.role,
            createdByAgentId: attempt.agentId,
            sizeChars: 1,
            createdAt: clock.nowIso(),
            type: "review",
            payload: {
              schemaVersion: 1,
              type: "review",
              decision: "approve",
              issues: [],
              feedback: "approved",
            },
          },
        };
      }
      return {
        ok: true,
        artifact: {
          id: ids.artifactId(),
          runId: run.id,
          turnId: turn.id,
          createdByRole: turn.role,
          createdByAgentId: attempt.agentId,
          sizeChars: 1,
          createdAt: clock.nowIso(),
          type: "final",
          payload: { schemaVersion: 1, type: "final", title: "Final", content: "done" },
        },
      };
    },
  };
}

function makeService(
  outputs: string[] = ["proposal", "review", "final"],
  overrides: { contextBuilder?: ContextBuilder } = {},
) {
  const ids = new TestIds();
  const repository = new MemoryRepository();
  const runtime = new ScriptedRuntime(outputs);
  const service = new CoordinationService({
    agentDirectory: agents,
    repository,
    workflow,
    contextBuilder: overrides.contextBuilder ?? contextBuilder,
    artifactProtocol: protocol(ids),
    runtime,
    clock,
    ids,
  });
  return { service, repository, runtime };
}

describe("CoordinationService", () => {
  it("snapshots selected Agents and rejects duplicate participant IDs", async () => {
    const { service } = makeService();
    const run = await service.createRun(request);

    expect(run.status).toBe("created");
    expect(run.participants).toEqual([
      { role: "planner", agentId: "planner-agent", agentNameSnapshot: "planner-agent name" },
      { role: "critic", agentId: "critic-agent", agentNameSnapshot: "critic-agent name" },
      {
        role: "finalizer",
        agentId: "finalizer-agent",
        agentNameSnapshot: "finalizer-agent name",
      },
    ]);
    await expect(
      service.createRun({
        ...request,
        agents: { ...request.agents, criticAgentId: request.agents.plannerAgentId },
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "DUPLICATE_AGENT" });
  });

  it("runs a Planner → Critic → Finalizer sequence in one background loop", async () => {
    const { service, runtime } = makeService();
    const run = await service.createRun(request);
    await service.startRun(run.id);

    await expect.poll(async () => (await service.getRun(run.id))?.run.status).toBe("completed");
    const details = await service.getRun(run.id);
    expect(runtime.inputs.map((input) => input.agentId)).toEqual([
      "planner-agent",
      "critic-agent",
      "finalizer-agent",
    ]);
    expect(details?.artifacts.map((artifact) => artifact.type)).toEqual([
      "proposal",
      "review",
      "final",
    ]);
  });

  it("retries invalid output on the same logical turn", async () => {
    const { service, runtime } = makeService(["invalid", "proposal", "review", "final"]);
    const run = await service.createRun(request);
    await service.startRun(run.id);

    await expect.poll(async () => (await service.getRun(run.id))?.run.status).toBe("completed");
    expect(runtime.inputs.map((input) => input.agentId)).toEqual([
      "planner-agent",
      "planner-agent",
      "critic-agent",
      "finalizer-agent",
    ]);
    expect(runtime.inputs[1]?.prompt).toContain("retry");
  });

  it("settles a stop request and prevents a second local loop", async () => {
    const ids = new TestIds();
    const repository = new MemoryRepository();
    const service = new CoordinationService({
      agentDirectory: agents,
      repository,
      workflow,
      contextBuilder,
      artifactProtocol: protocol(ids),
      runtime: new ScriptedRuntime(["proposal"], true),
      clock,
      ids,
    });
    const run = await service.createRun(request);
    await service.startRun(run.id);

    await expect.poll(async () => (await service.getRun(run.id))?.attempts.length).toBe(1);
    await expect(service.startRun(run.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.stopRun(run.id)).resolves.toMatchObject({ status: "stopped" });
  });
});

describe("CoordinationService create validation", () => {
  it("normalises required section keys to the frozen slug format", async () => {
    const { service } = makeService();
    const run = await service.createRun({
      ...request,
      requiredSections: [
        { key: "  Users  ", title: "  Target Users  " },
        { key: "RISKS", title: "Risks" },
      ],
    });

    expect(run.requiredSections).toEqual([
      { key: "users", title: "Target Users" },
      { key: "risks", title: "Risks" },
    ]);
  });

  it("rejects a required section key no Agent output could ever match", async () => {
    const { service } = makeService();

    await expect(
      service.createRun({
        ...request,
        requiredSections: [{ key: "target users", title: "Target Users" }],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });

    await expect(
      service.createRun({
        ...request,
        requiredSections: [{ key: "-leading-dash", title: "Bad" }],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });
  });

  it("rejects required section keys that collide only after normalisation", async () => {
    const { service } = makeService();

    await expect(
      service.createRun({
        ...request,
        requiredSections: [
          { key: "users", title: "Target Users" },
          { key: " Users ", title: "Duplicate" },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });
  });

  it("rejects a required section title beyond the frozen artifact limit", async () => {
    const { service } = makeService();

    await expect(
      service.createRun({
        ...request,
        requiredSections: [{ key: "users", title: "T".repeat(121) }],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });
  });

  it("refuses a run whose objective cannot fit the context limit", async () => {
    const { service } = makeService(undefined, {
      contextBuilder: new RoleScopedContextBuilder(),
    });

    await expect(
      service.createRun({ ...request, objective: "o".repeat(20_000) }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });

    await expect(
      service.createRun({ ...request, objective: "A short, buildable objective." }),
    ).resolves.toMatchObject({ status: "created" });
  });

  it("rejects an unknown Agent before creating anything", async () => {
    const directory: CoordinationAgentDirectory = { async getAgentsByIds() { return []; } };
    const ids = new TestIds();
    const repository = new MemoryRepository();
    const service = new CoordinationService({
      agentDirectory: directory,
      repository,
      workflow,
      contextBuilder,
      artifactProtocol: protocol(ids),
      runtime: new ScriptedRuntime([]),
      clock,
      ids,
    });

    await expect(service.createRun(request)).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
    await expect(repository.listRuns()).resolves.toEqual([]);
  });

  it("rejects a policy outside the frozen ranges", async () => {
    const { service } = makeService();

    await expect(
      service.createRun({ ...request, policy: { maxRevisions: 9 } }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });
    await expect(
      service.createRun({ ...request, policy: { maxTurns: 2 } }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });
    await expect(
      service.createRun({ ...request, policy: { perAttemptTimeoutMs: 1_000 } }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });
  });

  it("lists newest runs and returns run detail by id", async () => {
    const { service } = makeService();
    const first = await service.createRun(request);
    const second = await service.createRun({ ...request, name: "Second review" });

    const listed = await service.listRuns();
    expect(listed.map((run) => run.id)).toContain(first.id);
    expect(listed.map((run) => run.id)).toContain(second.id);

    const detail = await service.getRun(second.id);
    expect(detail?.run.name).toBe("Second review");
    expect(detail?.turns).toEqual([]);
    expect(await service.getRun("run-missing")).toBeUndefined();
  });
});
