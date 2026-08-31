#!/usr/bin/env node
/**
 * PA13-20 — real ten-participant bid-shaped wave rehearsal.
 *
 * Drives a running Compose deployment through the HTTP API and prints the
 * evidence the phase sheet asks for: per-attempt and total usage, observed
 * concurrency, wall-clock latency, partial-failure behaviour, and whether
 * provider rate limits engaged.
 *
 * No dependencies: Node 22 built-in fetch only. Reads .env for the port and
 * auth token; never prints a secret.
 *
 *   node scripts/pa13-20-rehearsal.mjs agents      # create 10 specialised Agents
 *   node scripts/pa13-20-rehearsal.mjs run         # scenario A: healthy wave
 *   node scripts/pa13-20-rehearsal.mjs run --busy  # scenario B: hold one Agent busy
 *   node scripts/pa13-20-rehearsal.mjs run --restart # scenario C: restart mid-wave
 *   node scripts/pa13-20-rehearsal.mjs report <runId>
 *   node scripts/pa13-20-rehearsal.mjs cleanup
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
    // No .env: fall back to the process environment.
  }
  return { ...values, ...process.env };
})();

// 127.0.0.1, not localhost: on macOS `localhost` can resolve to ::1 first while
// Docker publishes on IPv4 only, which looks exactly like a dead server.
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${env.PUBLIC_PORT || 3001}`;
const TOKEN = env.APP_AUTH_TOKEN ?? "";
const PARTICIPANTS = Number(process.env.PARTICIPANTS ?? 10);
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL ?? 4);
const PROMPT =
  process.env.PROMPT ??
  "We are launching a student marketplace next month. Name the single risk you would fix first, and say why in two sentences.";

const AGENT_PREFIX = "PA13 Bidder";

const SPECIALISATIONS = [
  ["Security reviewer", ["security", "abuse"], "Bid only when a concrete attack path exists."],
  ["Payments specialist", ["payments", "fraud"], "Bid when money movement or chargebacks are involved."],
  ["Trust and safety", ["moderation", "policy"], "Bid on user-harm and reporting flows."],
  ["Infrastructure", ["scaling", "reliability"], "Bid when load, uptime, or capacity dominate."],
  ["Data and privacy", ["privacy", "retention"], "Bid when personal data handling is at stake."],
  ["Mobile client", ["ios", "android"], "Bid on device-side constraints and release cadence."],
  ["Growth", ["onboarding", "retention"], "Bid when the funnel or activation is the constraint."],
  ["Support operations", ["support", "tooling"], "Bid when human operations cost is the risk."],
  ["Legal and compliance", ["compliance", "contracts"], "Bid on regulatory exposure only."],
  ["Accessibility", ["a11y", "inclusion"], "Bid when access barriers exclude real users."],
];

/**
 * Fastify rejects a request that declares `application/json` and then sends no
 * body, so the content-type is set only when there is one. Several coordination
 * routes -- `/start`, `/stop`, `/end` -- take no body at all.
 */
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
    parsed = { raw: text.slice(0, 400) };
  }
  if (!response.ok) {
    throw new Error(`${method} ${url} -> ${response.status} ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ agents */

async function ensureAgents() {
  const { agents } = await api("GET", "/api/agents");
  const existing = new Map(agents.map((agent) => [agent.name, agent]));
  const roster = [];

  for (let index = 0; index < PARTICIPANTS; index += 1) {
    const name = `${AGENT_PREFIX} ${String(index + 1).padStart(2, "0")}`;
    const [perspective, focusAreas, biddingInstructions] =
      SPECIALISATIONS[index % SPECIALISATIONS.length];
    // Every single-Agent route wraps its payload as `{ agent }`; only
    // `GET /api/agents` returns `{ agents }`. Unwrapping is not optional --
    // reading the envelope as the Agent yields `undefined` everywhere.
    let agent = existing.get(name);
    if (agent) {
      // An Agent that is mid-Playground-run refuses edits. That is correct, and
      // it is transient: keep the record we already have and let the readiness
      // wait below decide whether the rehearsal can proceed.
      try {
        ({ agent } = await api("PATCH", `/api/agents/${agent.id}`, {
          specialization: { perspective, focusAreas, biddingInstructions },
        }));
      } catch (error) {
        console.log(`  note: could not re-apply specialisation to ${name} (${String(error.message).slice(0, 80)})`);
      }
      console.log(`reused  ${name}  (${agent.status})`);
    } else {
      ({ agent } = await api("POST", "/api/agents", {
        name,
        description: perspective,
        specialization: { perspective, focusAreas, biddingInstructions },
      }));
      console.log(`created ${name}  (${agent.status})`);
    }
    if (agent.status === "stopped" || agent.status === "error") {
      ({ agent } = await api("POST", `/api/agents/${agent.id}/start`));
      console.log(`  started -> ${agent.status}`);
    }
    roster.push(agent);
  }

  // A `busy` Agent is almost always a Playground run from an earlier scenario
  // that has not finished yet. The server refuses to admit a wave while any
  // participant is busy, so wait rather than failing the rehearsal outright.
  const READY_WAIT_SECONDS = Number(process.env.READY_WAIT_SECONDS ?? 180);
  const ids = new Set(roster.map((agent) => agent.id));
  let current = roster;
  for (let waited = 0; ; waited += 3) {
    const notReady = current.filter((agent) => agent.status !== "ready");
    if (notReady.length === 0) break;
    if (waited === 0) {
      console.log(
        `\nwaiting for ${notReady.length} Agent(s) to become ready: ` +
          notReady.map((agent) => `${agent.name} (${agent.status})`).join(", "),
      );
    }
    if (waited >= READY_WAIT_SECONDS) {
      console.error(`\n${notReady.length} Agent(s) are still not ready after ${READY_WAIT_SECONDS}s:`);
      for (const agent of notReady) console.error(`  ${agent.name}: ${agent.status}`);
      console.error("\nA busy Agent is finishing an earlier run. Wait, or reset with:");
      console.error("  docker compose restart launchpad");
      process.exit(1);
    }
    process.stdout.write(".");
    await sleep(3_000);
    const refreshed = await api("GET", "/api/agents");
    current = refreshed.agents.filter((agent) => ids.has(agent.id));
  }
  console.log(`\n${current.length} specialised Agents ready.`);
  return current;
}

/* ------------------------------------------------------------ run release */

const TERMINAL = new Set(["completed", "failed", "stopped"]);
const RUN_NAME_PREFIX = "PA13-20";

/**
 * End any earlier rehearsal session that still holds our participants.
 *
 * A session that settled to `awaiting_input` is idle but **live**: it keeps its
 * participants enrolled so the user can send another prompt at any time, and
 * End is the only thing that releases them (P12-07). So each rehearsal scenario
 * must retire the previous one before it can admit a new wave. Only sessions
 * this script created are touched; anything else is reported and left alone.
 */
async function releaseParticipants(roster) {
  const { runs } = await api("GET", "/api/coordination-runs");
  const ids = new Set(roster.map((agent) => agent.id));
  const blocking = runs.filter(
    (run) =>
      !TERMINAL.has(run.status) &&
      (run.participants ?? []).some((participant) => ids.has(participant.agentId)),
  );
  if (blocking.length === 0) return;

  for (const run of blocking) {
    if (!run.name.startsWith(RUN_NAME_PREFIX)) {
      console.log(
        `  WARNING: run "${run.name}" (${run.status}) holds a participant and was not ` +
          "created by this script. Leaving it alone -- end it yourself if the wave is refused.",
      );
      continue;
    }
    try {
      if (run.status === "running" || run.status === "stop_requested") {
        await api("POST", `/api/coordination-runs/${run.id}/stop`);
        for (let waited = 0; waited < 60; waited += 2) {
          const details = await api("GET", `/api/coordination-runs/${run.id}`);
          if (details.run.status !== "running" && details.run.status !== "stop_requested") break;
          await sleep(2_000);
        }
      }
      await api("POST", `/api/coordination-runs/${run.id}/end`);
      console.log(`  ended prior rehearsal session ${run.id} (was ${run.status})`);
    } catch (error) {
      console.log(`  could not end ${run.id}: ${String(error.message).slice(0, 120)}`);
    }
  }
}

/* --------------------------------------------------------------- the wave */

/**
 * Restart the deployment from inside the poll loop.
 *
 * Doing this by hand means racing a 20-second window with a second terminal,
 * which is how the first Scenario C attempt silently became a third healthy
 * wave. Triggering it the moment an attempt is genuinely in flight makes the
 * scenario deterministic.
 */
async function restartServer() {
  console.log("\n  restarting the server mid-wave...");
  await execFileAsync("docker", ["compose", "restart", "launchpad"], { cwd: root });
  console.log("  restart issued; waiting for the server to come back");
}

async function runWave({ busy, restart }) {
  const roster = await ensureAgents();

  // Contention has to be created AFTER the round is admitted.
  //
  // The server refuses to admit a wave at all while any participant is busy
  // (`409 AGENT_NOT_READY` from the message route), which is the correct and
  // stricter behaviour: it declines a doomed round rather than starting one.
  // So the only way an Agent can be busy *inside* a live wave is if it goes
  // busy after admission. The realistic shape of that is a user opening the
  // Playground mid-wave, which is exactly what PA13-13 is about.
  //
  // The target is the LAST participant: with a cap of 4 it does not start until
  // roughly two thirds of the way through the wave, leaving a wide window.
  const heldAgent = busy ? roster[roster.length - 1] : undefined;

  await releaseParticipants(roster);

  const created = await api("POST", "/api/coordination-runs", {
    workflow: "shared_session_v1",
    name: busy ? "PA13-20 bid wave (contention)" : "PA13-20 bid wave",
    objective: "Collect one independent bid from every specialised participant.",
    agents: roster.map((agent) => agent.id),
    policy: {
      sessionProtocol: "free_chat",
      sessionWaveMode: "parallel",
      sessionWavePurpose: "session_bidding",
      maxParallelTurns: MAX_PARALLEL,
      maxTurns: 500,
      perAttemptTimeoutMs: 180_000,
    },
  });
  const runId = created.run.id;
  console.log(`\nrun ${runId}`);
  console.log(`participants ${roster.length}  cap ${MAX_PARALLEL}\n`);

  const startedAt = Date.now();
  await api("POST", `/api/coordination-runs/${runId}/messages`, { content: PROMPT });

  if (heldAgent) {
    const delayMs = Number(process.env.BUSY_DELAY_MS ?? 4_000);
    console.log(
      `Will occupy "${heldAgent.name}" in the Playground ${delayMs}ms into the wave ` +
        "to force mid-wave contention...",
    );
    void sleep(delayMs).then(() =>
      api("POST", `/api/agents/${heldAgent.id}/messages`, {
        content:
          "Write a long, thorough essay about the tradeoffs between strong and eventual " +
          "consistency in distributed systems. Cover at least eight named systems, give " +
          "worked examples, and do not summarise early.",
      })
        .then(() => console.log(`\n  occupied "${heldAgent.name}" in the Playground`))
        .catch((error) =>
          console.log(`\n  could not occupy "${heldAgent.name}": ${String(error.message).slice(0, 100)}`),
        ),
    );
  }

  let details;
  let restarted = false;
  let inFlightAtRestart = 0;
  for (;;) {
    await sleep(2_000);
    try {
      details = await api("GET", `/api/coordination-runs/${runId}`);
    } catch {
      // Expected while the server is down during a deliberate restart.
      process.stdout.write("\r  server unavailable (restarting)...              ");
      if (Date.now() - startedAt > 20 * 60_000) break;
      continue;
    }
    const committed = details.turns.filter((turn) => turn.status === "committed").length;
    const retired = details.turns.filter((turn) => turn.status === "failed").length;
    const running = details.attempts.filter((attempt) => attempt.status === "running").length;
    process.stdout.write(
      `\r  ${details.run.status}  committed ${committed}  retired ${retired}  in flight ${running}   `,
    );

    if (restart && !restarted && running > 0) {
      restarted = true;
      inFlightAtRestart = running;
      await restartServer();
      continue;
    }

    if (["awaiting_input", "completed", "failed", "stopped"].includes(details.run.status)) break;
    if (Date.now() - startedAt > 20 * 60_000) {
      console.error("\nrehearsal exceeded 20 minutes; aborting");
      break;
    }
  }
  console.log("\n");
  report(details);

  if (restart) {
    console.log("\nRESTART EVIDENCE");
    if (!restarted) {
      console.log("  the wave settled before any attempt was in flight — re-run");
    } else {
      const interrupted = details.events.filter((event) => event.type === "run.interrupted");
      const cancelled = details.attempts.filter(
        (attempt) => attempt.status === "cancelled" && attempt.errorCode === "SERVER_RESTARTED",
      );
      const stillRunning = details.attempts.filter((a) => a.status === "running");
      console.log(`  attempts in flight when restarted   ${inFlightAtRestart}`);
      console.log(`  run.interrupted events              ${interrupted.length}`);
      console.log(`  attempts cancelled SERVER_RESTARTED ${cancelled.length}`);
      console.log(`  run.awaiting_input after restart    ${details.events.filter((e) => e.type === "run.awaiting_input").length}`);
      console.log(`  final status                        ${details.run.status}`);
      console.log(`  errorCode                           ${details.run.errorCode ?? "none (expected)"}`);
      console.log(`  attempts left running               ${stillRunning.length}  ${stillRunning.length === 0 ? "(clean)" : "— INVESTIGATE: a participant is reserved forever"}`);
      console.log(`  activeTurnIds                       ${JSON.stringify(details.run.activeTurnIds)}`);

      console.log("\n  proving every participant was released: sending another prompt...");
      try {
        await api("POST", `/api/coordination-runs/${runId}/messages`, {
          content: "Post-restart round: are we still here?",
        });
        for (;;) {
          await sleep(2_000);
          details = await api("GET", `/api/coordination-runs/${runId}`);
          if (!["running", "stop_requested"].includes(details.run.status)) break;
        }
        console.log(`  accepted: YES  status ${details.run.status}  total turns ${details.turns.length}`);
      } catch (error) {
        console.log(`  accepted: NO — ${error.message}`);
        console.log("  INVESTIGATE: restart must leave every participant usable.");
      }
    }
  }

  if (busy) {
    // The point of scenario B is that a retired bidder does not strand the
    // session. Proving that means the session must still take another prompt.
    console.log("\nFOLLOW-UP: sending a second prompt to prove the session is not stranded...");
    try {
      await api("POST", `/api/coordination-runs/${runId}/messages`, {
        content: "Second round: name the one thing you would measure to know the fix worked.",
      });
      for (;;) {
        await sleep(2_000);
        details = await api("GET", `/api/coordination-runs/${runId}`);
        if (!["running", "stop_requested"].includes(details.run.status)) break;
      }
      const secondRound = details.turns.length - roster.length;
      console.log(`  accepted: YES  status ${details.run.status}  turns in round 2: ${secondRound}`);
      console.log(`  the previously retired bidder was re-scheduled: ${
        details.turns.filter((turn) => turn.agentId === heldAgent.id).length > 1 ? "YES" : "NO"
      }`);
    } catch (error) {
      console.log(`  accepted: NO — ${error.message}`);
      console.log("  INVESTIGATE: a retired bidder must not strand the session (PA13-12).");
    }
  }

  console.log(`\nRe-read later with:\n  node scripts/pa13-20-rehearsal.mjs report ${runId}`);
  return runId;
}

/* ------------------------------------------------------------------ report */

function report(details) {
  const { run, turns, attempts, events, usageTotals } = details;
  const at = (type) => events.find((event) => event.type === type)?.createdAt;
  const ms = (from, to) =>
    from && to ? ((Date.parse(to) - Date.parse(from)) / 1_000).toFixed(3) : "n/a";

  console.log("=".repeat(72));
  console.log(`PA13-20 REHEARSAL EVIDENCE — run ${run.id}`);
  console.log("=".repeat(72));
  console.log(`status              ${run.status}${run.errorCode ? ` (${run.errorCode})` : ""}`);
  console.log(`participants        ${run.participants.length}`);
  console.log(`wave mode/purpose   ${run.policy.sessionWaveMode} / ${run.policy.sessionWavePurpose}`);
  console.log(`configured cap      ${run.policy.maxParallelTurns}`);
  console.log(`version             ${run.version}`);

  // --- wall clock
  const waveStart = at("user.message_appended");
  const waveEnd = at("run.awaiting_input") ?? at("run.failed") ?? at("run.completed");
  console.log(`\nWALL CLOCK`);
  console.log(`  user.message_appended -> settled   ${ms(waveStart, waveEnd)} s`);
  if (events.some((event) => event.type === "run.interrupted")) {
    console.log("  (not a latency figure: this wave was cut short by a restart)");
  }

  // --- concurrency, from attempt intervals
  const spans = attempts
    .filter((attempt) => attempt.createdAt && attempt.finishedAt)
    .map((attempt) => [Date.parse(attempt.createdAt), Date.parse(attempt.finishedAt)]);
  let observed = 0;
  for (const [start] of spans) {
    const overlapping = spans.filter(([from, to]) => from <= start && to > start).length;
    observed = Math.max(observed, overlapping);
  }
  console.log(`\nCONCURRENCY`);
  console.log(`  observed peak overlapping attempts  ${observed}`);
  console.log(`  configured cap                      ${run.policy.maxParallelTurns}`);
  console.log(`  within cap                          ${observed <= run.policy.maxParallelTurns ? "YES" : "NO — INVESTIGATE"}`);

  // --- membership outcome
  const committed = turns.filter((turn) => turn.status === "committed");
  const failed = turns.filter((turn) => turn.status === "failed");
  const cancelled = turns.filter((turn) => turn.status === "cancelled");
  // A `failed` turn means one of two very different things, and conflating them
  // makes a restart look like ten policy retirements. Only `failTurn` emits
  // `turn.failed`; whole-run settlement (restart, stop, run failure) marks turns
  // failed with no such event.
  const retiredTurnIds = new Set(
    events.filter((event) => event.type === "turn.failed").flatMap((e) => (e.turnId ? [e.turnId] : [])),
  );
  const retired = failed.filter((turn) => retiredTurnIds.has(turn.id));
  const settled = failed.filter((turn) => !retiredTurnIds.has(turn.id));
  console.log(`\nWAVE MEMBERSHIP`);
  console.log(`  scheduled                 ${turns.length}`);
  console.log(`  committed                 ${committed.length}`);
  console.log(`  retired by wave policy    ${retired.length}   (turn.failed events: ${retiredTurnIds.size})`);
  console.log(`  settled by run lifecycle  ${settled.length}   (restart/stop/run failure, no turn.failed)`);
  console.log(`  cancelled                 ${cancelled.length}`);
  console.log(`  contiguous sequences  ${JSON.stringify(turns.map((t) => t.sequence).sort((a, b) => a - b))}`);
  console.log(`  all bid-shaped        ${turns.every((t) => t.wavePurpose === "session_bidding") ? "YES" : "NO"}`);

  // --- usage
  console.log(`\nUSAGE (per attempt)`);
  const name = (agentId) =>
    run.participants.find((p) => p.agentId === agentId)?.agentNameSnapshot ?? agentId;
  for (const attempt of [...attempts].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const usage = attempt.usage ?? {};
    console.log(
      `  ${name(attempt.agentId).padEnd(18)} #${attempt.number} ${attempt.status.padEnd(14)}` +
        ` in ${String(usage.inputTokens ?? "-").padStart(7)}` +
        ` cached ${String(usage.cachedInputTokens ?? "-").padStart(7)}` +
        ` out ${String(usage.outputTokens ?? "-").padStart(6)}`,
    );
  }
  const summed = attempts.reduce(
    (total, attempt) => ({
      inputTokens: total.inputTokens + (attempt.usage?.inputTokens ?? 0),
      cachedInputTokens: total.cachedInputTokens + (attempt.usage?.cachedInputTokens ?? 0),
      outputTokens: total.outputTokens + (attempt.usage?.outputTokens ?? 0),
    }),
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  );
  console.log(`\nUSAGE (totals)`);
  console.log(`  reported by API   ${JSON.stringify(usageTotals)}`);
  console.log(`  recomputed here   ${JSON.stringify(summed)}`);
  console.log(
    `  agree             ${JSON.stringify(usageTotals) === JSON.stringify(summed) ? "YES" : "NO — INVESTIGATE"}`,
  );
  console.log(`  attempts counted  ${attempts.length} (including ${attempts.filter((a) => a.status !== "succeeded").length} non-succeeded)`);

  // --- failures and rate limits
  const failures = attempts.filter((attempt) => attempt.status !== "succeeded");
  console.log(`\nFAILURES AND CONTENTION`);
  if (failures.length === 0) {
    console.log("  none");
  } else {
    for (const attempt of failures) {
      console.log(`  ${name(attempt.agentId)} #${attempt.number} ${attempt.status} ${attempt.errorCode ?? ""}: ${attempt.errorMessage ?? ""}`);
    }
  }
  const rateLimited = failures.filter((attempt) =>
    /rate.?limit|429|quota|too many requests/i.test(attempt.errorMessage ?? ""),
  );
  console.log(`  provider rate limits engaged  ${rateLimited.length > 0 ? `YES (${rateLimited.length})` : "no"}`);
  const contended = failures.filter((attempt) => attempt.errorCode === "AGENT_RESERVED").length;
  console.log(`  contention (AGENT_RESERVED)   ${contended}`);
  const invalid = failures.filter((attempt) => attempt.status === "invalid_output").length;
  console.log(`  invalid Agent output          ${invalid} of ${attempts.length} attempts`);
  const retriedAndRecovered = turns.filter(
    (turn) => turn.status === "committed" && turn.attemptCount > 1,
  ).length;
  console.log(`  recovered on retry            ${retriedAndRecovered}`);

  // --- hygiene
  const orphaned = attempts.filter((attempt) => attempt.status === "running");
  const serialised = JSON.stringify(details);
  console.log(`\nHYGIENE`);
  console.log(`  attempts left running   ${orphaned.length}  ${orphaned.length === 0 ? "(clean)" : "— INVESTIGATE"}`);
  console.log(`  activeTurnIds           ${JSON.stringify(run.activeTurnIds)}`);
  console.log(`  events gapless          ${events.every((event, index) => event.sequence === index + 1) ? "YES" : "NO"} (${events.length} events)`);
  console.log(`  leaseToken in payload   ${/leaseToken/i.test(serialised) ? "PRESENT — INVESTIGATE" : "absent"}`);
  console.log(`  promptDigest exposed    ${attempts.some((a) => a.promptDigest) ? "digest only (expected)" : "absent"}`);
  console.log("=".repeat(72));
}

/* ----------------------------------------------------------------- cleanup */

async function cleanup() {
  const { agents } = await api("GET", "/api/agents");
  const mine = agents.filter((agent) => agent.name.startsWith(AGENT_PREFIX));
  // Sessions hold their participants until ended, so release before deleting.
  await releaseParticipants(mine);
  for (const agent of mine) {
    try {
      await api("DELETE", `/api/agents/${agent.id}`);
      console.log(`deleted ${agent.name}`);
    } catch (error) {
      console.log(`skipped ${agent.name}: ${error.message.slice(0, 120)}`);
    }
  }
}

/* -------------------------------------------------------------------- main */

const [command, argument] = process.argv.slice(2);
// The container reports "Started" before Node has bound the port and before
// `coordination.initialize()` has finished its reconciliation sweep, so a single
// probe races the boot. Wait instead of declaring the server dead.
const WAIT_SECONDS = Number(process.env.WAIT_SECONDS ?? 90);
let health;
for (let elapsed = 0; ; elapsed += 2) {
  try {
    health = await api("GET", "/api/health");
    break;
  } catch (error) {
    if (elapsed >= WAIT_SECONDS) {
      console.error(`\nCannot reach ${BASE} after ${WAIT_SECONDS}s: ${error.message}`);
      console.error("\nDiagnose with:");
      console.error("  docker compose ps");
      console.error("  docker compose logs --tail=80 launchpad");
      process.exit(1);
    }
    if (elapsed === 0) process.stdout.write(`waiting for ${BASE}`);
    process.stdout.write(".");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
if (command !== "report") console.log(`\nserver ok (${JSON.stringify(health)})\n`);

switch (command) {
  case "agents":
    await ensureAgents();
    break;
  case "run":
    await runWave({
      busy: process.argv.includes("--busy"),
      restart: process.argv.includes("--restart"),
    });
    break;
  case "report":
    if (!argument) {
      console.error("usage: report <runId>");
      process.exit(1);
    }
    report(await api("GET", `/api/coordination-runs/${argument}`));
    break;
  case "cleanup":
    await cleanup();
    break;
  default:
    console.log("commands: agents | run [--busy|--restart] | report <runId> | cleanup");
}
