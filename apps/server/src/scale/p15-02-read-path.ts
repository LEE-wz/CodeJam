/**
 * P15-02 - measure the read path under the delta model from `P12-10`.
 *
 * Compares a full detail fetch against a `?sinceSequence=` fetch at each
 * transcript size, and records the payload the browser actually receives while
 * polling at 1.5 seconds (`SessionWorkspace.tsx`).
 *
 * Requests go through the real Fastify route so the recorded bytes are the
 * bytes on the wire, not an estimate from an in-process object.
 *
 * Usage:
 *   npm run scale:p15-02
 *   npm run scale:p15-02 -- --sizes=100,500 --participants=10
 */
import { writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Fastify from "fastify";
import { registerCoordinationRoutes } from "../coordination/routes.js";
import {
  buildScaleSession,
  hasFlag,
  mib,
  parseFlag,
  parseSizes,
  round,
} from "./session-harness.js";

/** The client's poll cadence in `SessionWorkspace.tsx`. */
const POLL_INTERVAL_MS = 1_500;
const POLLS_PER_MINUTE = 60_000 / POLL_INTERVAL_MS;

interface ReadMeasurement {
  committedTurns: number;
  /** Full `GET /api/coordination-runs/:id` - what the first load costs. */
  fullBytes: number;
  fullMib: number;
  fullMs: number;
  /** Delta poll with nothing new, the steady-state idle case. */
  idleDeltaBytes: number;
  idleDeltaMs: number;
  /** Delta poll carrying one wave of new events, the active case. */
  waveDeltaBytes: number;
  waveDeltaMs: number;
  waveEvents: number;
  /** What a minute of active polling costs in each model. */
  fullPollingMibPerMinute: number;
  deltaPollingMibPerMinute: number;
  savingRatio: number;
}

const main = async (): Promise<void> => {
  const participants = Number.parseInt(parseFlag("participants", "10"), 10);
  const sizes = parseSizes("100,500,1000,2000", participants);

  const session = await buildScaleSession(participants);
  const app = Fastify({ logger: false });
  await registerCoordinationRoutes(app, session.service);
  await app.ready();

  const url = `/api/coordination-runs/${session.runId}`;
  const measurements: ReadMeasurement[] = [];
  let committed = 0;
  let prompts = 0;

  const startedAt = performance.now();
  console.log(
    `P15-02 read path: ${participants} participants, sizes ${sizes.join(", ")}\n` +
      `store: ${session.databasePath}\n`,
  );

  for (const size of sizes) {
    while (committed < size) {
      prompts += 1;
      await session.prompt(`Prompt ${prompts}`);
      committed += participants;
    }

    // Full read: what the browser downloads on first open of this session.
    const fullStarted = performance.now();
    const full = await app.inject({ method: "GET", url });
    const fullMs = performance.now() - fullStarted;
    if (full.statusCode !== 200) throw new Error(`Full read returned ${full.statusCode}`);
    const fullBytes = Buffer.byteLength(full.rawPayload);
    const cursor = (JSON.parse(full.payload).events.at(-1)?.sequence ?? -1) + 1;

    // Idle delta: the poll that happens when nothing has changed.
    const idleStarted = performance.now();
    const idle = await app.inject({ method: "GET", url: `${url}?sinceSequence=${cursor}` });
    const idleMs = performance.now() - idleStarted;
    if (idle.statusCode !== 200) throw new Error(`Idle delta returned ${idle.statusCode}`);

    // Active delta: one more wave, then poll from the pre-wave cursor. This is
    // the payload a browser receives while a wave is actually running.
    prompts += 1;
    await session.prompt(`Prompt ${prompts}`);
    committed += participants;
    const waveStarted = performance.now();
    const wave = await app.inject({ method: "GET", url: `${url}?sinceSequence=${cursor}` });
    const waveMs = performance.now() - waveStarted;
    if (wave.statusCode !== 200) throw new Error(`Wave delta returned ${wave.statusCode}`);
    const waveBytes = Buffer.byteLength(wave.rawPayload);
    const waveEvents = JSON.parse(wave.payload).events.length;

    const fullPerMinute = mib(fullBytes * POLLS_PER_MINUTE);
    const deltaPerMinute = mib(waveBytes * POLLS_PER_MINUTE);
    const measurement: ReadMeasurement = {
      committedTurns: size,
      fullBytes,
      fullMib: mib(fullBytes),
      fullMs: round(fullMs),
      idleDeltaBytes: Buffer.byteLength(idle.rawPayload),
      idleDeltaMs: round(idleMs),
      waveDeltaBytes: waveBytes,
      waveDeltaMs: round(waveMs),
      waveEvents,
      fullPollingMibPerMinute: fullPerMinute,
      deltaPollingMibPerMinute: deltaPerMinute,
      savingRatio: round(fullBytes / waveBytes),
    };
    measurements.push(measurement);
    console.log(
      `${String(size).padStart(6)} turns | full ${measurement.fullMib}MiB ${measurement.fullMs}ms | ` +
        `idle delta ${measurement.idleDeltaBytes}B ${measurement.idleDeltaMs}ms | ` +
        `wave delta ${measurement.waveDeltaBytes}B (${waveEvents} events) ${measurement.waveDeltaMs}ms | ` +
        `${measurement.savingRatio}x smaller`,
    );
  }

  const header =
    "| Committed turns | Full read | Full read time | Idle delta | Wave delta | " +
    "Delta read time | Full-poll cost/min | Delta-poll cost/min | Saving |";
  const divider = `|${"---|".repeat(9)}`;
  const rows = measurements.map(
    (row) =>
      `| ${row.committedTurns} | ${row.fullMib} MiB | ${row.fullMs} ms | ` +
      `${row.idleDeltaBytes} B | ${row.waveDeltaBytes} B | ${row.waveDeltaMs} ms | ` +
      `${row.fullPollingMibPerMinute} MiB | ${row.deltaPollingMibPerMinute} MiB | ` +
      `${row.savingRatio}x |`,
  );
  console.log(`\n${[header, divider, ...rows].join("\n")}\n`);

  const report = {
    task: "P15-02",
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    participants,
    pollIntervalMs: POLL_INTERVAL_MS,
    totalWallClockSeconds: round((performance.now() - startedAt) / 1000),
    measurements,
  };
  const reportPath = path.join(process.cwd(), "p15-02-read-path.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`report: ${reportPath}`);
  console.log(`total wall clock: ${report.totalWallClockSeconds}s`);

  await app.close();
  if (hasFlag("keep")) {
    console.log(`kept store directory: ${session.directory}`);
  } else {
    await rm(session.directory, { recursive: true, force: true });
  }
};

await main();
