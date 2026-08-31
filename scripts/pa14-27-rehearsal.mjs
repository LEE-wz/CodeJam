#!/usr/bin/env node
/**
 * PA14-27 — live adaptive-auction rehearsal.
 *
 * Drives eight rounds through one ten-Agent Compose session and emits only
 * evidence-safe metadata: durable ids, state transitions, usage, and timing.
 * It never prints credentials, provider threads, prompts, or model output.
 *
 *   node scripts/pa14-27-rehearsal.mjs run
 *   node scripts/pa14-27-rehearsal.mjs report <run-id>
 *   node scripts/pa14-27-rehearsal.mjs cleanup
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = (() => {
  const values = {};
  try {
    for (const line of readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // Process environment remains sufficient when there is no .env file.
  }
  return { ...values, ...process.env };
})();

const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${env.PUBLIC_PORT || 3001}`;
const TOKEN = env.APP_AUTH_TOKEN ?? "";
const AGENT_PREFIX = "PA14 Bidder";
const RUN_PREFIX = "PA14-27";
const TERMINAL = new Set(["completed", "failed", "stopped"]);
const SETTLED = new Set(["awaiting_input", ...TERMINAL]);
const POLL_MS = Number(process.env.POLL_MS ?? 1_000);
const ROUND_TIMEOUT_MS = Number(process.env.ROUND_TIMEOUT_MS ?? 15 * 60_000);
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL ?? 2);
const COOLDOWN_MS = Number(process.env.ROUND_COOLDOWN_MS ?? 60_000);

const SPECIALISATIONS = [
  ["Security reviewer", ["security", "abuse"]],
  ["Payments specialist", ["payments", "fraud"]],
  ["Trust and safety", ["moderation", "policy"]],
  ["Infrastructure", ["scaling", "reliability"]],
  ["Data and privacy", ["privacy", "retention"]],
  ["Mobile client", ["ios", "android"]],
  ["Growth", ["onboarding", "retention"]],
  ["Support operations", ["support", "tooling"]],
  ["Legal and compliance", ["compliance", "contracts"]],
  ["Accessibility", ["a11y", "inclusion"]],
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, url, body) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }
  if (!response.ok) {
    throw new Error(`${method} ${url} -> ${response.status} ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function waitForServer() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      // Expected while Compose is replacing the process.
    }
    await sleep(1_000);
  }
  throw new Error("server did not become healthy within 120 seconds");
}

async function ensureAgents() {
  const { agents } = await api("GET", "/api/agents");
  const existing = new Map(agents.map((agent) => [agent.name, agent]));
  const roster = [];
  for (let index = 0; index < 10; index += 1) {
    const name = `${AGENT_PREFIX} ${String(index + 1).padStart(2, "0")}`;
    const [perspective, focusAreas] = SPECIALISATIONS[index];
    const specialization = {
      perspective,
      focusAreas,
      biddingInstructions:
        "Follow an explicitly requested single, sequential, or parallel collaboration shape exactly. " +
        "Recommend direct only for genuinely simple self-contained work; otherwise propose the smallest valid team.",
    };
    let agent = existing.get(name);
    if (agent) {
      if (agent.status !== "busy") {
        ({ agent } = await api("PATCH", `/api/agents/${agent.id}`, { specialization }));
      }
    } else {
      ({ agent } = await api("POST", "/api/agents", {
        name,
        description: perspective,
        specialization,
      }));
    }
    if (agent.status === "stopped" || agent.status === "error") {
      ({ agent } = await api("POST", `/api/agents/${agent.id}/start`));
    }
    roster.push(agent);
  }
  await waitUntilReady(new Set(roster.map(({ id }) => id)), 240_000);
  return roster;
}

async function waitUntilReady(ids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { agents } = await api("GET", "/api/agents");
    const selected = agents.filter(({ id }) => ids.has(id));
    if (selected.length === ids.size && selected.every(({ status }) => status === "ready")) {
      return selected;
    }
    await sleep(2_000);
  }
  throw new Error("participants did not all become ready before timeout");
}

async function releasePriorRuns(roster) {
  const ids = new Set(roster.map(({ id }) => id));
  const { runs } = await api("GET", "/api/coordination-runs");
  for (const run of runs.filter(
    (candidate) =>
      !TERMINAL.has(candidate.status) &&
      candidate.participants?.some(({ agentId }) => ids.has(agentId)),
  )) {
    if (!run.name.startsWith(RUN_PREFIX)) {
      throw new Error(`participant is held by unrelated run ${run.id} (${run.name})`);
    }
    if (run.status === "running" || run.status === "stop_requested") {
      await api("POST", `/api/coordination-runs/${run.id}/stop`);
    }
    await api("POST", `/api/coordination-runs/${run.id}/end`);
  }
}

const roundView = (details, userArtifactId) => {
  const userIds = new Set(
    details.artifacts.filter(({ type }) => type === "user_message").map(({ id }) => id),
  );
  const userSequence = new Map(
    details.artifacts
      .filter(({ type }) => type === "user_message")
      .map(({ id, transcriptSequence }) => [id, transcriptSequence]),
  );
  const award = details.artifacts.find(
    (artifact) =>
      artifact.type === "session_award" && artifact.payload.userArtifactId === userArtifactId,
  );
  const turns = details.turns.filter(
    (turn) => {
      const newestInputUserId = turn.inputArtifactIds
        .filter((id) => userIds.has(id))
        .sort((left, right) => (userSequence.get(right) ?? -1) - (userSequence.get(left) ?? -1))[0];
      return (
        newestInputUserId === userArtifactId ||
        Boolean(award && turn.inputArtifactIds.includes(award.id))
      );
    },
  );
  const turnIds = new Set(turns.map(({ id }) => id));
  const attempts = details.attempts.filter(({ turnId }) => turnIds.has(turnId));
  const bids = details.artifacts.filter(
    (artifact) => artifact.type === "session_bid" && turnIds.has(artifact.turnId),
  );
  const messages = details.artifacts.filter(
    (artifact) => artifact.type === "session_message" && turnIds.has(artifact.turnId),
  );
  return { award, turns, attempts, bids, messages };
};

async function waitForSettlement(runId, userArtifactId) {
  const deadline = Date.now() + ROUND_TIMEOUT_MS;
  for (;;) {
    const details = await api("GET", `/api/coordination-runs/${runId}`);
    if (SETTLED.has(details.run.status)) return details;
    if (Date.now() >= deadline) throw new Error(`round ${userArtifactId} exceeded timeout`);
    await sleep(POLL_MS);
  }
}

async function sendRound(runId, name, content, routing, during) {
  const startedMs = Date.now();
  const response = await api("POST", `/api/coordination-runs/${runId}/messages`, {
    content,
    clientMessageId: `pa14-27-${name}-${crypto.randomUUID()}`,
    ...(routing ? { routing } : {}),
  });
  const userArtifactId = response.run.lastUserArtifactId;
  console.log(`ROUND ${name} admitted user=${userArtifactId}`);
  if (during) await during(userArtifactId);
  const details = await waitForSettlement(runId, userArtifactId);
  const view = roundView(details, userArtifactId);
  const wallMs = Date.now() - startedMs;
  console.log(
    `ROUND ${name} settled status=${details.run.status} wallMs=${wallMs} ` +
      `turns=${view.turns.length} attempts=${view.attempts.length} bids=${view.bids.length} ` +
      `award=${view.award?.id ?? "none"}`,
  );
  return { name, userArtifactId, wallMs, details, ...view };
}

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`PA14-27 evidence failure: ${message}`);
}

const usage = (attempt) => ({
  inputTokens: attempt.usage?.inputTokens ?? 0,
  cachedInputTokens: attempt.usage?.cachedInputTokens ?? 0,
  outputTokens: attempt.usage?.outputTokens ?? 0,
});

function printRoundEvidence(round) {
  console.log(`\nEVIDENCE ${round.name}`);
  console.log(
    JSON.stringify({
      userArtifactId: round.userArtifactId,
      wallMs: round.wallMs,
      status: round.details.run.status,
      awardId: round.award?.id,
      awardOutcome: round.award?.payload.outcome,
      winningBidArtifactId: round.award?.payload.winningBidArtifactId,
      bidCount: round.bids.length,
      turnCount: round.turns.length,
      attemptCount: round.attempts.length,
    }),
  );
  for (const attempt of round.attempts) {
    const elapsedMs = attempt.finishedAt
      ? Date.parse(attempt.finishedAt) - Date.parse(attempt.createdAt)
      : null;
    console.log(
      JSON.stringify({
        callId: attempt.id,
        turnId: attempt.turnId,
        agentId: attempt.agentId,
        attempt: attempt.number,
        status: attempt.status,
        errorCode: attempt.errorCode,
        elapsedMs,
        usage: usage(attempt),
      }),
    );
  }
}

async function cooldown() {
  if (COOLDOWN_MS <= 0) return;
  console.log(`COOLDOWN ${COOLDOWN_MS}ms before the next provider-heavy round`);
  let remaining = COOLDOWN_MS;
  while (remaining > 0) {
    const slice = Math.min(30_000, remaining);
    await sleep(slice);
    remaining -= slice;
  }
}

function storedRoundSettlement(details, user) {
  const nextUser = details.artifacts
    .filter(
      (artifact) =>
        artifact.type === "user_message" && artifact.transcriptSequence > user.transcriptSequence,
    )
    .sort((left, right) => left.transcriptSequence - right.transcriptSequence)[0];
  const end = details.events.find(
    (event) =>
      ["run.awaiting_input", "run.failed", "run.stopped", "run.completed"].includes(event.type) &&
      Date.parse(event.createdAt) >= Date.parse(user.createdAt) &&
      (!nextUser || Date.parse(event.createdAt) < Date.parse(nextUser.createdAt)),
  );
  return {
    wallMs: end ? Date.parse(end.createdAt) - Date.parse(user.createdAt) : null,
    status:
      end?.type === "run.awaiting_input"
        ? "awaiting_input"
        : end?.type === "run.stopped"
          ? "stopped"
          : end?.type === "run.completed"
            ? "completed"
            : end?.type === "run.failed"
              ? "failed"
              : details.run.status,
  };
}

async function occupyLateBidder(agent) {
  await sleep(Number(process.env.BUSY_DELAY_MS ?? 3_000));
  await api("POST", `/api/agents/${agent.id}/messages`, {
    content:
      "Write a detailed comparison of ten distributed consensus systems, with worked examples, " +
      "operational tradeoffs, and a long migration checklist. Do not conclude early.",
  });
}

/**
 * Run beside the server inside its container. It polls the same durable JSON
 * document and SIGSTOPs the server process at the exact observable boundary:
 * all expected bid turns settled, all bid artifacts durable, no award durable.
 */
async function armPostBidPause(runId, userArtifactId, expectedBids) {
  const source = String.raw`
const fs=require('node:fs');
const [runId,userId,expectedRaw]=process.argv.slice(1);
const expected=Number(expectedRaw);
const serverPid=fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x)).map(Number).find(pid=>{
  try{return fs.readFileSync('/proc/'+pid+'/cmdline','utf8').includes('apps/server/dist/index.js')}catch{return false}
});
if(!serverPid)process.exit(3);
const deadline=Date.now()+900000;
for(;;){
  try{
    const db=JSON.parse(fs.readFileSync('/app/data/launchpad.json','utf8'));
    const turns=db.coordinationTurns.filter(t=>t.runId===runId&&t.kind==='session_bid'&&t.inputArtifactIds.includes(userId));
    const ids=new Set(turns.map(t=>t.id));
    const bids=db.coordinationArtifacts.filter(a=>a.runId===runId&&a.type==='session_bid'&&ids.has(a.turnId));
    const award=db.coordinationArtifacts.some(a=>a.runId===runId&&a.type==='session_award'&&a.payload.userArtifactId===userId);
    if(turns.length===expected&&turns.every(t=>t.status!=='scheduled'&&t.status!=='running')&&bids.length===expected&&!award){
      process.kill(serverPid,'SIGSTOP');
      process.stdout.write('PAUSED '+serverPid+' '+turns.length+' '+bids.length+'\n');
      process.exit(0);
    }
    if(award){process.stderr.write('award committed before pause\n');process.exit(4)}
  }catch{}
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);
  if(Date.now()>deadline)process.exit(5);
}
`;
  return execFileAsync(
    "docker",
    ["compose", "exec", "-T", "launchpad", "node", "-e", source, runId, userArtifactId, String(expectedBids)],
    { cwd: root, timeout: ROUND_TIMEOUT_MS },
  );
}

async function restartAfterBidSettlement(runId, userArtifactId) {
  const paused = await armPostBidPause(runId, userArtifactId, 10);
  console.log(`RESTART boundary=${paused.stdout.trim()}`);
  await execFileAsync("docker", ["compose", "kill", "-s", "SIGKILL", "launchpad"], { cwd: root });
  await execFileAsync("docker", ["compose", "up", "-d", "launchpad"], { cwd: root });
  await waitForServer();
}

async function createSession(roster) {
  const created = await api("POST", "/api/coordination-runs", {
    workflow: "shared_session_v1",
    name: `${RUN_PREFIX} live adaptive-auction rehearsal`,
    objective: "Exercise every PA14-27 adaptive-auction path with durable evidence.",
    agents: roster.map(({ id }) => id),
    policy: {
      sessionProtocol: "free_chat",
      maxTurns: 500,
      maxParallelTurns: MAX_PARALLEL,
      perAttemptTimeoutMs: 180_000,
      auctionPolicy: {
        routingMode: "auto",
        defaultAgentId: roster[0].id,
        directConfidenceThresholdBps: 5_000,
        directOutputTokenBudget: 2_000,
        minimumValidBids: 2,
        maxBidOutputTokens: 2_048,
        maxBidAttempts: 2,
        auctionExecutionTokenBudget: 4_000,
        auctionOnDirectFailure: false,
        fallback: "round_robin",
        scoringVersion: "confidence_cost_v1",
      },
    },
  });
  return created.run.id;
}

async function run() {
  await waitForServer();
  const roster = await ensureAgents();
  await releasePriorRuns(roster);
  const runId = await createSession(roster);
  console.log(`PA14-27 RUN ${runId}`);
  const rounds = [];

  const autoDirect = await sendRound(
    runId,
    "auto-direct",
    "This is a simple self-contained question. Answer directly in one short sentence: what is 2 + 2?",
  );
  requireEvidence(autoDirect.attempts.length === 1, "Auto Direct did not use exactly one call");
  requireEvidence(autoDirect.award?.payload.outcome === "publish_candidate", "Auto Direct candidate was not published");
  rounds.push(autoDirect);

  const explicit = await sendRound(
    runId,
    "explicit-auction",
    "Choose the single most important control for a student marketplace launch and explain it briefly. Propose a single-agent plan.",
    { routingMode: "auction", coordinationPreference: "single" },
  );
  requireEvidence(explicit.award?.payload.outcome === "execute_plan", "explicit Auction did not produce one executing award");
  requireEvidence(explicit.bids.length >= 2, "explicit Auction had too few durable bids");
  rounds.push(explicit);
  await cooldown();

  const escalated = await sendRound(
    runId,
    "auto-escalation",
    "This high-risk marketplace launch decision needs competing specialist review. Recommend an auction and propose the smallest justified team.",
    { riskLevel: "high", coordinationPreference: "team" },
  );
  requireEvidence(escalated.turns.filter(({ kind }) => kind === "session_bid").length === 10, "Auto did not escalate from its primary across the roster");
  requireEvidence(escalated.award?.payload.outcome === "execute_plan", "Auto escalation did not award a plan");
  rounds.push(escalated);
  await cooldown();

  const sequential = await sendRound(
    runId,
    "sequential-countdown",
    "Use exactly a sequential three-agent plan. Assign positions 1, 2, and 3; their execution instructions must publish 3, then 2, then 1 respectively. Do not propose single or parallel mode.",
    { routingMode: "auction", coordinationPreference: "team" },
  );
  const sequentialWinner = sequential.bids.find(({ id }) => id === sequential.award?.payload.winningBidArtifactId);
  requireEvidence(sequentialWinner?.payload.plan.mode === "sequential", "countdown was not awarded as a sequential plan");
  requireEvidence(sequential.messages.length === sequentialWinner.payload.plan.assignments.length, "sequential award did not execute every assignment");
  rounds.push(sequential);
  await cooldown();

  const parallel = await sendRound(
    runId,
    "parallel-fanout",
    "Use exactly a parallel three-agent plan to assess security, privacy, and accessibility independently. Do not propose single or sequential mode.",
    { routingMode: "auction", coordinationPreference: "team" },
  );
  const parallelWinner = parallel.bids.find(({ id }) => id === parallel.award?.payload.winningBidArtifactId);
  requireEvidence(parallelWinner?.payload.plan.mode === "parallel", "fan-out was not awarded as a parallel plan");
  requireEvidence(parallel.messages.length === parallelWinner.payload.plan.assignments.length, "parallel award did not execute every assignment");
  rounds.push(parallel);
  await cooldown();

  await waitUntilReady(new Set(roster.map(({ id }) => id)), 240_000);
  const held = roster.at(-1);
  const partial = await sendRound(
    runId,
    "partial-bidder-failure",
    "Auction a single-owner plan for reducing payment fraud in a marketplace. Keep the proposed execution compact.",
    { routingMode: "auction", coordinationPreference: "single" },
    () => occupyLateBidder(held).catch((error) => console.log(`BUSY injection=${error.message}`)),
  );
  requireEvidence(partial.award !== undefined, "partial bidder failure prevented an award");
  requireEvidence(
    partial.details.events.some(
      (event) => event.type === "turn.failed" && partial.turns.some(({ id }) => id === event.turnId),
    ),
    "partial bidder failure did not durably retire a bidder",
  );
  rounds.push(partial);
  await cooldown();

  await waitUntilReady(new Set(roster.map(({ id }) => id)), 300_000);
  const stopPromise = sendRound(
    runId,
    "stop",
    "Run a full auction for a comprehensive cross-specialist launch review.",
    { routingMode: "auction", coordinationPreference: "team" },
    async () => {
      for (;;) {
        const details = await api("GET", `/api/coordination-runs/${runId}`);
        if (details.attempts.some(({ status }) => status === "running")) break;
        await sleep(100);
      }
      await api("POST", `/api/coordination-runs/${runId}/stop`);
    },
  );
  const stopped = await stopPromise;
  requireEvidence(stopped.details.run.status === "awaiting_input", "Stop did not settle the session to awaiting_input");
  requireEvidence(stopped.attempts.some(({ status }) => status === "cancelled"), "Stop cancelled no live call");
  rounds.push(stopped);

  const resumed = await sendRound(
    runId,
    "resume",
    "Resume with a direct one-sentence confirmation that the session is usable.",
    { routingMode: "direct", selectedAgentId: roster[0].id },
  );
  requireEvidence(resumed.details.run.status === "awaiting_input", "session did not resume after Stop");
  requireEvidence(resumed.messages.length === 1, "resumed Direct round did not publish once");
  rounds.push(resumed);

  await waitUntilReady(new Set(roster.map(({ id }) => id)), 240_000);
  const restarted = await sendRound(
    runId,
    "restart-after-bids",
    "Auction a single-owner plan for a final launch readiness check.",
    { routingMode: "auction", coordinationPreference: "single" },
    (userArtifactId) => restartAfterBidSettlement(runId, userArtifactId),
  );
  requireEvidence(restarted.bids.length === 10, "restart boundary did not preserve all ten settled bids");
  requireEvidence(restarted.award === undefined, "an award committed before the deliberate boundary restart");
  requireEvidence(restarted.attempts.every(({ status }) => status !== "running"), "restart left a call running");
  requireEvidence(
    restarted.details.events.some(
      (event) => event.type === "run.interrupted" && Date.parse(event.createdAt) >= Date.parse(restarted.details.artifacts.find(({ id }) => id === restarted.userArtifactId).createdAt),
    ),
    "restart interruption was not durably recorded",
  );
  rounds.push(restarted);

  for (const round of rounds) printRoundEvidence(round);
  const final = await api("GET", `/api/coordination-runs/${runId}`);
  const recomputed = final.attempts.reduce(
    (total, attempt) => ({
      inputTokens: total.inputTokens + usage(attempt).inputTokens,
      cachedInputTokens: total.cachedInputTokens + usage(attempt).cachedInputTokens,
      outputTokens: total.outputTokens + usage(attempt).outputTokens,
    }),
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  );
  requireEvidence(JSON.stringify(recomputed) === JSON.stringify(final.usageTotals), "aggregate usage does not equal every-call usage");
  const firstSequence = final.events[0]?.sequence ?? 0;
  requireEvidence(
    final.events.every((event, index) => event.sequence === firstSequence + index),
    "event sequence is not gapless",
  );
  console.log(`\nPA14-27 PASS run=${runId} rounds=${rounds.length} attempts=${final.attempts.length}`);
  console.log(`TOTAL_USAGE ${JSON.stringify(final.usageTotals)}`);
  console.log(`REPORT node scripts/pa14-27-rehearsal.mjs report ${runId}`);
}

async function report(runId) {
  const details = await api("GET", `/api/coordination-runs/${runId}`);
  for (const user of details.artifacts.filter(({ type }) => type === "user_message")) {
    const view = roundView(details, user.id);
    const settlement = storedRoundSettlement(details, user);
    printRoundEvidence({
      name: user.clientMessageId ?? `round-${user.transcriptSequence}`,
      userArtifactId: user.id,
      wallMs: settlement.wallMs,
      details: { ...details, run: { ...details.run, status: settlement.status } },
      ...view,
    });
  }
  console.log(`TOTAL_USAGE ${JSON.stringify(details.usageTotals)}`);
}

async function cleanup() {
  const roster = await ensureAgents();
  await releasePriorRuns(roster);
  console.log("PA14-27 sessions ended; Agents retained for reproducibility.");
}

const [command = "run", argument] = process.argv.slice(2);
if (command === "run") await run();
else if (command === "report" && argument) await report(argument);
else if (command === "cleanup") await cleanup();
else throw new Error("usage: pa14-27-rehearsal.mjs run | report <run-id> | cleanup");
