/**
 * P15-02 — full-versus-delta HTTP read-path measurement.
 *
 * Every row uses the same validated, temporary ledger materialisation as
 * P15-01. Requests pass through the real Fastify routes, so byte counts are the
 * payloads a browser receives at the client's 1.5-second polling cadence.
 */
import { rm, writeFile } from "node:fs/promises";
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

const POLL_INTERVAL_MS = 1_500;
const POLLS_PER_MINUTE = 60_000 / POLL_INTERVAL_MS;

interface ReadMeasurement {
  committedTurns: number;
  fullBytes: number;
  fullMib: number;
  fullMs: number;
  idleDeltaBytes: number;
  idleDeltaMs: number;
  waveDeltaBytes: number;
  waveDeltaMs: number;
  waveEvents: number;
  fullPollingMibPerMinute: number;
  deltaPollingMibPerMinute: number;
  savingRatio: number;
}

const main = async (): Promise<void> => {
  const participants = Number.parseInt(parseFlag("participants", "10"), 10);
  const sizes = parseSizes("100,500,2000,10000", participants);
  const measurements: ReadMeasurement[] = [];
  const startedAt = performance.now();

  console.log(`P15-02 seeded read path: ${participants} participants, sizes ${sizes.join(", ")}`);
  for (const size of sizes) {
    const session = await buildScaleSession(participants);
    const app = Fastify({ logger: false });
    try {
      await session.seedCommittedTurns(size);
      await registerCoordinationRoutes(app, session.service);
      await app.ready();
      const url = `/api/coordination-runs/${session.runId}`;

      const fullStarted = performance.now();
      const full = await app.inject({ method: "GET", url });
      const fullMs = performance.now() - fullStarted;
      if (full.statusCode !== 200) throw new Error(`Full read returned ${full.statusCode}`);
      const fullBytes = Buffer.byteLength(full.rawPayload);
      const fullBody = JSON.parse(full.payload);
      const cursor = (fullBody.events.at(-1)?.sequence ?? -1) + 1;

      const idleStarted = performance.now();
      const idle = await app.inject({ method: "GET", url: `${url}?sinceSequence=${cursor}` });
      const idleMs = performance.now() - idleStarted;
      if (idle.statusCode !== 200) throw new Error(`Idle delta returned ${idle.statusCode}`);

      await session.prompt(`Delta wave after ${size} turns`);
      const waveStarted = performance.now();
      const wave = await app.inject({ method: "GET", url: `${url}?sinceSequence=${cursor}` });
      const waveMs = performance.now() - waveStarted;
      if (wave.statusCode !== 200) throw new Error(`Wave delta returned ${wave.statusCode}`);
      const waveBytes = Buffer.byteLength(wave.rawPayload);
      const waveEvents = JSON.parse(wave.payload).events.length;

      const row: ReadMeasurement = {
        committedTurns: size,
        fullBytes,
        fullMib: mib(fullBytes),
        fullMs: round(fullMs),
        idleDeltaBytes: Buffer.byteLength(idle.rawPayload),
        idleDeltaMs: round(idleMs),
        waveDeltaBytes: waveBytes,
        waveDeltaMs: round(waveMs),
        waveEvents,
        fullPollingMibPerMinute: mib(fullBytes * POLLS_PER_MINUTE),
        deltaPollingMibPerMinute: mib(waveBytes * POLLS_PER_MINUTE),
        savingRatio: round(fullBytes / waveBytes),
      };
      measurements.push(row);
      console.log(
        `${String(size).padStart(6)} turns | full ${row.fullMib}MiB ${row.fullMs}ms | ` +
          `idle delta ${row.idleDeltaBytes}B ${row.idleDeltaMs}ms | ` +
          `wave delta ${row.waveDeltaBytes}B (${waveEvents} events) ${row.waveDeltaMs}ms | ` +
          `${row.savingRatio}x smaller`,
      );
    } finally {
      await app.close();
      if (hasFlag("keep")) console.log(`kept store directory: ${session.directory}`);
      else await rm(session.directory, { recursive: true, force: true });
    }
  }

  const header =
    "| Committed turns | Full read | Full read time | Idle delta | Wave delta | " +
    "Delta read time | Full-poll cost/min | Delta-poll cost/min | Saving |";
  const rows = measurements.map((row) =>
    `| ${row.committedTurns} | ${row.fullMib} MiB | ${row.fullMs} ms | ` +
    `${row.idleDeltaBytes} B | ${row.waveDeltaBytes} B | ${row.waveDeltaMs} ms | ` +
    `${row.fullPollingMibPerMinute} MiB | ${row.deltaPollingMibPerMinute} MiB | ` +
    `${row.savingRatio}x |`,
  );
  console.log(`\n${[header, `|${"---|".repeat(9)}`, ...rows].join("\n")}\n`);

  const report = {
    task: "P15-02",
    method: "real Fastify full and delta reads over validated materialised ledgers",
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
};

await main();
