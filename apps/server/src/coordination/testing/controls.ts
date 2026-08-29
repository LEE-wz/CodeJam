import type { Clock, IdGenerator } from "../contracts.js";

export const FIXED_NOW = "2026-08-29T00:00:00.000Z";

export class FixedClock implements Clock {
  constructor(private readonly value = FIXED_NOW) {}

  nowIso(): string {
    return this.value;
  }
}

export class AdvancingClock implements Clock {
  private currentMs: number;

  constructor(
    startIso = FIXED_NOW,
    private readonly stepMs = 1_000,
  ) {
    this.currentMs = Date.parse(startIso);
    if (!Number.isFinite(this.currentMs) || stepMs < 0) {
      throw new Error("AdvancingClock requires a valid start time and non-negative step");
    }
  }

  nowIso(): string {
    const value = new Date(this.currentMs).toISOString();
    this.currentMs += this.stepMs;
    return value;
  }
}

export class DeterministicIdGenerator implements IdGenerator {
  private readonly counters = new Map<string, number>();

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

  private next(kind: string): string {
    const value = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, value);
    return `${kind}-${String(value).padStart(4, "0")}`;
  }
}
