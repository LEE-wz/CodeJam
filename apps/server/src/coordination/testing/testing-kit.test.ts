import { describe, expect, it } from "vitest";
import { AdvancingClock, DeterministicIdGenerator, FixedClock } from "./controls.js";
import {
  APPROVING_REVIEW_ARTIFACT,
  COORDINATION_AGENTS,
  CREATE_RUN_REQUEST,
  INVALID_ARTIFACT_OUTPUT,
  REJECTING_REVIEW_ARTIFACT,
  REQUIRED_SECTIONS,
  VALID_FINAL_ARTIFACT,
  VALID_PROPOSAL_ARTIFACT,
} from "./fixtures.js";

describe("Phase 0 testing kit", () => {
  it("provides fixed and advancing deterministic controls", () => {
    expect(new FixedClock().nowIso()).toBe("2026-08-29T00:00:00.000Z");

    const clock = new AdvancingClock("2026-08-29T00:00:00.000Z", 1_000);
    expect(clock.nowIso()).toBe("2026-08-29T00:00:00.000Z");
    expect(clock.nowIso()).toBe("2026-08-29T00:00:01.000Z");

    const ids = new DeterministicIdGenerator();
    expect([
      ids.runId(),
      ids.turnId(),
      ids.attemptId(),
      ids.artifactId(),
      ids.eventId(),
      ids.leaseToken(),
      ids.runId(),
    ]).toEqual([
      "run-0001",
      "turn-0001",
      "attempt-0001",
      "artifact-0001",
      "event-0001",
      "lease-0001",
      "run-0002",
    ]);
  });

  it("provides the complete stable artifact and Agent fixture set", () => {
    expect(new Set(COORDINATION_AGENTS.map((agent) => agent.id)).size).toBe(3);
    expect(REQUIRED_SECTIONS).toHaveLength(3);
    expect(CREATE_RUN_REQUEST.requiredSections).toHaveLength(3);
    expect(VALID_PROPOSAL_ARTIFACT.payload.type).toBe("proposal");
    expect(REJECTING_REVIEW_ARTIFACT.payload).toMatchObject({
      type: "review",
      decision: "reject",
    });
    expect(APPROVING_REVIEW_ARTIFACT.payload).toMatchObject({
      type: "review",
      decision: "approve",
    });
    expect(VALID_FINAL_ARTIFACT.payload.type).toBe("final");
    expect(() => JSON.parse(INVALID_ARTIFACT_OUTPUT)).not.toThrow();
  });
});
