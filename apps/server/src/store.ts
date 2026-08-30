import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types.js";

export const CURRENT_DATABASE_VERSION = 2;

/** Collections that exist in every supported version and must survive migration. */
const BASE_COLLECTIONS = ["agents", "messages", "runs"] as const;

/** Collections added by v2. Empty on migration; never populated from v1 data. */
const COORDINATION_COLLECTIONS = [
  "coordinationRuns",
  "coordinationTurns",
  "coordinationAttempts",
  "coordinationArtifacts",
  "coordinationEvents",
] as const;

const emptyDatabase = (): Database => ({
  version: 2,
  agents: [],
  messages: [],
  runs: [],
  coordinationRuns: [],
  coordinationTurns: [],
  coordinationAttempts: [],
  coordinationArtifacts: [],
  coordinationEvents: [],
});

export class DatabaseVersionError extends Error {
  constructor(
    message: string,
    readonly foundVersion: unknown,
  ) {
    super(message);
    this.name = "DatabaseVersionError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireArrays = (
  source: Record<string, unknown>,
  keys: readonly string[],
  version: number,
): void => {
  for (const key of keys) {
    if (!Array.isArray(source[key])) {
      throw new Error(
        `Database v${version} is missing required array "${key}"; refusing to load.`,
      );
    }
  }
};

/**
 * Parse a database document without discarding anything (overview Section 10.2).
 *
 * v1 is migrated additively: every existing key is carried over by spread, the
 * five coordination collections are appended empty, and only `version` is
 * rewritten. Unknown future versions are rejected before any write.
 */
export const parseDatabaseDocument = (
  raw: string,
): { database: Database; migratedFromVersion: 1 | null } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Database file is not valid JSON: ${(error as Error).message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("Database file must contain a JSON object.");
  }

  const { version } = parsed;

  if (version === 1) {
    requireArrays(parsed, BASE_COLLECTIONS, 1);
    return {
      database: {
        ...(parsed as unknown as Database),
        version: 2,
        coordinationRuns: [],
        coordinationTurns: [],
        coordinationAttempts: [],
        coordinationArtifacts: [],
        coordinationEvents: [],
      },
      migratedFromVersion: 1,
    };
  }

  if (version === 2) {
    requireArrays(parsed, [...BASE_COLLECTIONS, ...COORDINATION_COLLECTIONS], 2);
    return { database: parsed as unknown as Database, migratedFromVersion: null };
  }

  throw new DatabaseVersionError(
    `Unsupported database version ${JSON.stringify(version)}; this server supports ` +
      `versions 1 and ${CURRENT_DATABASE_VERSION}. The file was left unchanged.`,
    version,
  );
};

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
      return;
    }

    const { database, migratedFromVersion } = parseDatabaseDocument(raw);
    this.data = database;
    if (migratedFromVersion !== null) {
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
