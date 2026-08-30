import { createHash, randomUUID } from "node:crypto";

const mode = process.argv[2];
const base = "http://127.0.0.1:3999";
const authToken = process.env.APP_AUTH_TOKEN ?? "";
const auth = { authorization: `Bearer ${authToken}` };
const safeId = (value) => createHash("sha256").update(value).digest("hex").slice(0, 8);

const call = async (method, route, body) => {
  const response = await fetch(base + route, {
    method,
    headers: body ? { ...auth, "content-type": "application/json" } : auth,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

if (mode === "gateway") {
  const { AgentService } = await import("file:///workspace/apps/server/dist/agent-service.js");
  const { loadConfig, writeCodexConfig } = await import("file:///workspace/apps/server/dist/config.js");
  const { DurableCoordinationRepository } = await import(
    "file:///workspace/apps/server/dist/coordination/repository.js"
  );
  const { AgentServiceCoordinationRuntime } = await import(
    "file:///workspace/apps/server/dist/coordination/runtime-gateway.js"
  );
  const { createRunner } = await import("file:///workspace/apps/server/dist/runner-factory.js");
  const { JsonStore } = await import("file:///workspace/apps/server/dist/store.js");
  const { WorkspaceManager } = await import("file:///workspace/apps/server/dist/workspace.js");

  const config = loadConfig();
  await writeCodexConfig(config);
  const store = new JsonStore("/workspace/gateway-data/db.json");
  const clock = { nowIso: () => new Date().toISOString() };
  const ids = {
    runId: randomUUID,
    turnId: randomUUID,
    attemptId: randomUUID,
    artifactId: randomUUID,
    eventId: randomUUID,
    leaseToken: randomUUID,
  };
  const repository = new DurableCoordinationRepository({ store, clock, ids });
  const agents = new AgentService(
    config,
    store,
    new WorkspaceManager("/workspace/gateway-workspaces"),
    createRunner(config),
    repository,
  );
  await agents.initialize();
  const agent = await agents.createAgent({
    name: "Phase 3 gateway probe",
    instructions: "Answer concisely and follow the user request exactly.",
  });
  const runId = randomUUID();
  const now = new Date().toISOString();
  await store.mutate((database) => database.coordinationRuns.push({
    id: runId,
    name: "Gateway probe reservation",
    objective: "Verify the real execution boundary.",
    requiredSections: [{ key: "result", title: "Result" }],
    participants: [
      { role: "planner", agentId: agent.id, agentNameSnapshot: agent.name },
      { role: "critic", agentId: randomUUID(), agentNameSnapshot: "unused" },
      { role: "finalizer", agentId: randomUUID(), agentNameSnapshot: "unused" },
    ],
    policy: {
      workflow: "verified_handoff_v1",
      maxRevisions: 2,
      maxTurns: 8,
      maxAttemptsPerTurn: 2,
      perAttemptTimeoutMs: 120000,
      contextMaxChars: 12000,
      outputMaxChars: 20000,
    },
    status: "running",
    phase: "drafting",
    revision: 0,
    nextTurnSequence: 1,
    version: 1,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  }));
  const attemptId = randomUUID();
  const startedAt = Date.now();
  const runtime = new AgentServiceCoordinationRuntime(agents);
  const started = await runtime.start({
    runId,
    turnId: randomUUID(),
    attemptId,
    leaseToken: randomUUID(),
    agentId: agent.id,
    prompt: "Reply with one short sentence confirming the runtime is available.",
    timeoutMs: 120000,
  });
  if (started.kind !== "started") throw new Error("real gateway did not start");
  const outcome = await started.handle.completion;
  const persistedRun = agents.getRun(started.handle.agentRunId);
  const messages = agents.getMessages(agent.id);
  console.log(JSON.stringify({
    check: "one-agent-real-gateway",
    status: outcome.kind,
    elapsedMs: Date.now() - startedAt,
    agentRunVisible: persistedRun.source === "coordination",
    messageRoles: messages.map((message) => message.role),
    threadPersisted: Boolean(agents.getAgent(agent.id).codexThreadId),
    correlationPersisted: persistedRun.coordinationAttemptId === attemptId,
  }));
  if (outcome.kind !== "succeeded") process.exitCode = 1;
} else if (mode === "rehearsals") {
  if (!authToken || authToken.includes("replace-with")) {
    throw new Error("A configured APP_AUTH_TOKEN is required for the rehearsal");
  }
  for (let probe = 0; probe < 300; probe += 1) {
    try {
      if ((await fetch(base + "/api/health")).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const totals = [];
  const allTurnTimes = [];
  for (let rehearsal = 1; rehearsal <= 3; rehearsal += 1) {
    const agents = {};
    for (const role of ["Planner", "Critic", "Finaliser"]) {
      const created = await call("POST", "/api/agents", {
        name: `Phase 3 ${role} ${rehearsal}`,
        instructions: "Follow the structured handoff contract exactly and return only the requested JSON.",
      });
      if (created.status !== 201) throw new Error(`Agent creation failed: ${created.status}`);
      agents[role] = created.body.agent;
    }
    const created = await call("POST", "/api/coordination-runs", {
      name: `Phase 3 rehearsal ${rehearsal}`,
      objective: "Produce a concise, practical launch plan for a student skill-sharing service.",
      requiredSections: [
        { key: "users", title: "Target Users" },
        { key: "risks", title: "Risks and Mitigations" },
      ],
      agents: {
        plannerAgentId: agents.Planner.id,
        criticAgentId: agents.Critic.id,
        finalizerAgentId: agents.Finaliser.id,
      },
    });
    if (created.status !== 201) throw new Error(`Run creation failed: ${created.status}`);
    const runId = created.body.run.id;
    const wallStart = Date.now();
    const started = await call("POST", `/api/coordination-runs/${runId}/start`);
    if (started.status !== 202) throw new Error(`Run start failed: ${started.status}`);

    const conflict = await call(
      "POST",
      `/api/agents/${agents.Critic.id}/messages`,
      { content: "This competing Playground turn must be rejected." },
    );

    let details;
    for (let poll = 0; poll < 1800; poll += 1) {
      details = (await call("GET", `/api/coordination-runs/${runId}`)).body;
      if (["completed", "failed", "stopped"].includes(details.run.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!details || details.run.status !== "completed") {
      console.log(JSON.stringify({
        check: "rehearsal-failed",
        rehearsal,
        run: safeId(runId),
        status: details?.run?.status ?? "poll-timeout",
        code: details?.run?.errorCode ?? null,
        attemptStatuses: details?.attempts?.map((attempt) => attempt.status) ?? [],
        attemptErrorCodes: details?.attempts?.map((attempt) => attempt.errorCode ?? null) ?? [],
      }));
      process.exit(1);
    }

    const elapsedMs = Date.now() - wallStart;
    totals.push(elapsedMs);
    const perTurnMs = details.turns.map((turn) =>
      turn.startedAt && turn.completedAt
        ? Date.parse(turn.completedAt) - Date.parse(turn.startedAt)
        : null,
    );
    allTurnTimes.push(...perTurnMs.filter((value) => value !== null));
    const release = await call("PATCH", `/api/agents/${agents.Planner.id}`, {
      description: "Released after completed coordination rehearsal.",
    });
    const records = [];
    for (const agent of Object.values(agents)) {
      const agentRuns = await call("GET", `/api/agents/${agent.id}/runs`);
      const refreshedAgent = await call("GET", `/api/agents/${agent.id}`);
      records.push({
        runVisible: agentRuns.body.runs.length === 1,
        source: agentRuns.body.runs[0]?.source,
        correlated: agentRuns.body.runs[0]?.coordinationRunId === runId,
        threadPersisted: Boolean(refreshedAgent.body.agent.codexThreadId),
      });
    }
    console.log(JSON.stringify({
      check: "full-real-rehearsal",
      rehearsal,
      run: safeId(runId),
      elapsedMs,
      perTurnMs,
      attempts: details.attempts.length,
      reservationConflict: conflict.status === 409 && conflict.body.code === "AGENT_RESERVED",
      terminalReservationReleased: release.status === 200,
      leaseExcluded: details.attempts.every((attempt) => !("leaseToken" in attempt)),
      records,
    }));
  }
  console.log(JSON.stringify({
    check: "timing-summary",
    successfulRehearsals: totals.length,
    totalMsRange: [Math.min(...totals), Math.max(...totals)],
    perTurnMsRange: [Math.min(...allTurnTimes), Math.max(...allTurnTimes)],
    defaultAttemptTimeoutMs: 120000,
    timeoutConclusion: Math.max(...allTurnTimes) < 120000 ? "feasible" : "review-required",
  }));
} else {
  throw new Error("Expected gateway or rehearsals mode");
}
