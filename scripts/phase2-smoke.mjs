const base = "http://127.0.0.1:3999";
const auth = { authorization: "Bearer phase2-smoke-token" };
// Fastify rejects a JSON content-type with an empty body, so the header is only
// sent when there actually is one. A UI client must do the same.
const headersFor = (body) =>
  body ? { ...auth, "content-type": "application/json" } : auth;
const mode = process.argv[2];

const call = async (method, path, body) => {
  const response = await fetch(base + path, {
    method,
    headers: headersFor(body),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

for (let i = 0; i < 200; i += 1) {
  try {
    if ((await fetch(base + "/api/health")).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 50));
}

if (mode === "first") {
  console.log("1. database version on disk:", JSON.parse(
    await (await import("node:fs/promises")).readFile("/workspace/tmp-data/launchpad.json", "utf8"),
  ).version);

  const agents = {};
  for (const role of ["Planner", "Critic", "Finaliser"]) {
    const created = await call("POST", "/api/agents", { name: role });
    agents[role] = created.body.agent;
    console.log(`2. created Agent ${role}:`, created.status, created.body.agent.status);
  }

  const run = await call("POST", "/api/coordination-runs", {
    name: "Phase 2 smoke",
    objective: "Produce a practical launch plan for a student marketplace.",
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
  console.log("3. create run:", run.status, run.body.run.status);
  const runId = run.body.run.id;

  const bad = await call("POST", "/api/coordination-runs", {
    name: "Duplicate Agents",
    objective: "x".repeat(20),
    requiredSections: [{ key: "users", title: "Target Users" }],
    agents: {
      plannerAgentId: agents.Planner.id,
      criticAgentId: agents.Planner.id,
      finalizerAgentId: agents.Finaliser.id,
    },
  });
  console.log("4. duplicate Agents rejected:", bad.status, bad.body.error.code);

  const started = await call("POST", `/api/coordination-runs/${runId}/start`);
  console.log("5. start run:", started.status, started.body.run.status);

  const second = await call("POST", `/api/coordination-runs/${runId}/start`);
  console.log("6. double start rejected:", second.status, second.body.error.code);

  let details;
  for (let i = 0; i < 200; i += 1) {
    details = (await call("GET", `/api/coordination-runs/${runId}`)).body;
    if (["completed", "failed", "stopped"].includes(details.run.status)) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  console.log("7. terminal state:", details.run.status, details.run.errorCode);
  console.log("8. evidence timeline:");
  for (const event of details.events) {
    console.log(`     ${String(event.sequence).padStart(2)} ${event.type.padEnd(24)} ${event.message}`);
  }
  console.log("9. turns/attempts persisted:", details.turns.length, "turn(s),", details.attempts.length, "attempt(s)");
  console.log("10. events carry no lease token:", !JSON.stringify(details.events).includes("leaseToken"));
  console.log("    events carry no prompt/objective text:", !JSON.stringify(details.events).includes("student marketplace"));
  console.log("    NOTE: attempts[] do expose leaseToken - it is a required field of the",
    "\n          frozen CoordinationAttempt type, so the frozen detail response carries it.",
    "\n          No route consumes a lease token, so it is not exploitable, but Phase 4",
    "\n          would ship it to the browser. Needs a decision before the UI lands.");

  await (await import("node:fs/promises")).writeFile("/workspace/run-id", runId);
} else {
  const runId = await (await import("node:fs/promises")).readFile("/workspace/run-id", "utf8");
  const details = (await call("GET", `/api/coordination-runs/${runId}`)).body;
  console.log("11. run survived the restart:", details.run.status, "with", details.events.length, "events");
  const list = await call("GET", "/api/coordination-runs");
  console.log("12. list still returns it:", list.status, list.body.runs.length, "run(s)");
}
