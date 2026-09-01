/**
 * P15-01 — reproducible JsonStore scale measurement.
 *
 * Each row uses a fresh temporary database. A real ten-participant wave is
 * driven first, its validated durable shape is materialised to one wave below
 * the target in a single unmeasured setup mutation, and the final user prompt
 * runs through the real service/repository/workflow/protocol/store. This makes
 * the 10,000-turn point measurable without spending hours rewriting every
 * intermediate database; no measured operation is synthetic or extrapolated.
 */
import { rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  buildScaleSession,
  hasFlag,
  median,
  mib,
  parseFlag,
  parseSizes,
  percentile,
  round,
} from "./session-harness.js";

interface Measurement {
  committedTurns: number;
  mutationSamples: number;
  mutationMedianMs: number;
  mutationP95Ms: number;
  mutationMaxMs: number;
  databaseBytes: number;
  databaseMib: number;
  snapshotMs: number;
  snapshotHeapDeltaMib: number;
  rssAfterSnapshotMib: number;
  getRunDetailsMs: number;
  lastPromptMs: number;
}

const main = async (): Promise<void> => {
  const participants = Number.parseInt(parseFlag("participants", "10"), 10);
  const sizes = parseSizes("100,500,2000,10000", participants);
  const measurements: Measurement[] = [];
  const startedAt = performance.now();

  console.log(`P15-01 seeded scale measurement: ${participants} participants, sizes ${sizes.join(", ")}`);
  for (const size of sizes) {
    const session = await buildScaleSession(participants);
    try {
      await session.seedCommittedTurns(size - participants);
      session.store.durations.length = 0;
      const lastPromptMs = await session.prompt(`Measured prompt at ${size} turns`);
      const window = [...session.store.durations];
      const file = await stat(session.databasePath);

      const heapBefore = process.memoryUsage().heapUsed;
      const snapshotStarted = performance.now();
      const snapshot = session.store.snapshot();
      const snapshotMs = performance.now() - snapshotStarted;
      const memory = process.memoryUsage();

      const detailsStarted = performance.now();
      const details = await session.repository.getRunDetails(session.runId);
      const getRunDetailsMs = performance.now() - detailsStarted;
      const actual = details?.turns.filter(({ status }) => status === "committed").length ?? 0;
      if (actual !== size || snapshot.coordinationTurns.length !== size) {
        throw new Error(`Expected ${size} turns, measured ${actual}/${snapshot.coordinationTurns.length}`);
      }

      const row: Measurement = {
        committedTurns: size,
        mutationSamples: window.length,
        mutationMedianMs: round(median(window)),
        mutationP95Ms: round(percentile(window, 0.95)),
        mutationMaxMs: round(Math.max(...window)),
        databaseBytes: file.size,
        databaseMib: mib(file.size),
        snapshotMs: round(snapshotMs),
        snapshotHeapDeltaMib: mib(memory.heapUsed - heapBefore),
        rssAfterSnapshotMib: mib(memory.rss),
        getRunDetailsMs: round(getRunDetailsMs),
        lastPromptMs: round(lastPromptMs),
      };
      measurements.push(row);
      console.log(
        `${String(size).padStart(6)} turns | mutate p50 ${row.mutationMedianMs}ms ` +
          `p95 ${row.mutationP95Ms}ms (${row.mutationSamples} samples) | ` +
          `db ${row.databaseMib}MiB | snapshot ${row.snapshotMs}ms | ` +
          `getRunDetails ${row.getRunDetailsMs}ms | prompt ${round(row.lastPromptMs / 1000)}s`,
      );
    } finally {
      if (hasFlag("keep")) console.log(`kept store directory: ${session.directory}`);
      else await rm(session.directory, { recursive: true, force: true });
    }
  }

  const header =
    "| Committed turns | DB file | Mutation p50 | Mutation p95 | Mutation max | " +
    "`snapshot()` | Snapshot heap | RSS | `getRunDetails` | Last prompt end-to-end |";
  const rows = measurements.map((row) =>
    `| ${row.committedTurns} | ${row.databaseMib} MiB | ${row.mutationMedianMs} ms | ` +
    `${row.mutationP95Ms} ms | ${row.mutationMaxMs} ms | ${row.snapshotMs} ms | ` +
    `${row.snapshotHeapDeltaMib} MiB | ${row.rssAfterSnapshotMib} MiB | ` +
    `${row.getRunDetailsMs} ms | ${round(row.lastPromptMs / 1000)} s |`,
  );
  console.log(`\n${[header, `|${"---|".repeat(10)}`, ...rows].join("\n")}\n`);

  const report = {
    task: "P15-01",
    method: "validated-wave materialisation followed by one real end-to-end prompt per size",
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    participants,
    totalWallClockSeconds: round((performance.now() - startedAt) / 1000),
    measurements,
  };
  const reportPath = path.join(process.cwd(), "p15-01-store-scale.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`report: ${reportPath}`);
  console.log(`total wall clock: ${report.totalWallClockSeconds}s`);
};

await main();
