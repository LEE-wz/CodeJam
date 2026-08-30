import { describe, expect, it } from "vitest";
import { PHASE4_RESPONSE_FIXTURES } from "./phase4-response-fixtures.js";

describe("Phase 4 response fixtures", () => {
  it("covers every required UI state with the expected evidence", () => {
    expect(Object.keys(PHASE4_RESPONSE_FIXTURES)).toEqual([
      "completed", "rejectionRevision", "retry", "timeout", "stopped", "failed", "interrupted",
    ]);
    expect(PHASE4_RESPONSE_FIXTURES.completed.run.status).toBe("completed");
    expect(PHASE4_RESPONSE_FIXTURES.rejectionRevision.events.map(({ type }) => type)).toContain("review.rejected");
    expect(PHASE4_RESPONSE_FIXTURES.retry.events.map(({ type }) => type)).toContain("attempt.invalid_output");
    expect(PHASE4_RESPONSE_FIXTURES.timeout.events.map(({ type }) => type)).toContain("attempt.timed_out");
    expect(PHASE4_RESPONSE_FIXTURES.stopped.run.status).toBe("stopped");
    expect(PHASE4_RESPONSE_FIXTURES.failed.run.errorCode).toBe("MAX_ATTEMPTS_EXCEEDED");
    expect(PHASE4_RESPONSE_FIXTURES.interrupted.events.map(({ type }) => type)).toContain("run.interrupted");
  });

  it("keeps identifiers consistent and event sequences gapless", () => {
    for (const response of Object.values(PHASE4_RESPONSE_FIXTURES)) {
      expect(response.turns.every(({ runId }) => runId === response.run.id)).toBe(true);
      expect(response.attempts.every(({ runId }) => runId === response.run.id)).toBe(true);
      expect(response.artifacts.every(({ runId }) => runId === response.run.id)).toBe(true);
      expect(response.events.every(({ runId }) => runId === response.run.id)).toBe(true);
      expect(response.events.map(({ sequence }) => sequence)).toEqual(
        response.events.map((_, index) => index + 1),
      );
    }
  });

  it("is safe for browser-side rendering and contains no internal capabilities", () => {
    const serialized = JSON.stringify(PHASE4_RESPONSE_FIXTURES).toLowerCase();
    for (const forbidden of [
      "leasetoken", "authorization", "bearer ", "set-cookie", "api_key", "rawprompt", "rawoutput",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
