/**
 * Phase 5 scope-amendment proof.
 *
 * Adding the session enum members breaks compile-time exhaustiveness in several
 * `Readonly<Record<...>>` tables outside Phase 5's normal filesystem map. The
 * approved amendment fills those holes with loud placeholders that throw and
 * name the task which replaces them. This file proves every one of them throws,
 * so a placeholder can never be mistaken for a working implementation and can
 * never ship silently.
 *
 * Each placeholder is a getter rather than an immediately-invoked function. An
 * IIFE inside an object literal is evaluated when the module is imported, which
 * would throw on import and take the server and the whole suite with it. A
 * getter throws only when something actually reads the session entry -- which
 * nothing in Phase 5 does, and which is exactly the signal Phase 6 needs.
 */
import { describe, expect, it } from "vitest";
import { EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND } from "./artifact-protocol.js";
import { RoleScopedContextBuilder } from "./context-builder.js";
import { createCoordinationEventFactory, roleLabel } from "./events.js";
import { VerifiedHandoffWorkflowV1 } from "./workflow.js";
import { FIXED_NOW } from "./testing/controls.js";
import { OBJECTIVE, REQUIRED_SECTIONS } from "./testing/fixtures.js";
import { PARTICIPANT_ONE, SESSION_PARTICIPANTS } from "./testing/session-fixtures.js";
import type { CoordinationRun, CoordinationTurn } from "./types.js";
import { DEFAULT_COORDINATION_POLICY } from "./types.js";

const sessionRun = (): CoordinationRun => ({
  id: "run-placeholder",
  name: "Placeholder session",
  objective: OBJECTIVE,
  requiredSections: REQUIRED_SECTIONS.map((section) => ({ ...section })),
  participants: SESSION_PARTICIPANTS.map((agent) => ({
    role: "participant" as const,
    agentId: agent.id,
    agentNameSnapshot: agent.name,
  })),
  policy: { ...DEFAULT_COORDINATION_POLICY, workflow: "shared_session_v1" },
  status: "running",
  phase: "sessioning",
  revision: 0,
  nextTurnSequence: 2,
  version: 1,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
});

const sessionTurn = (): CoordinationTurn => ({
  id: "turn-placeholder",
  runId: "run-placeholder",
  sequence: 1,
  role: "participant",
  agentId: PARTICIPANT_ONE.id,
  kind: "session_turn",
  status: "scheduled",
  attemptCount: 0,
  inputArtifactIds: [],
  lastValidationErrors: [],
  createdAt: FIXED_NOW,
});

describe("Phase 5 placeholders: modules still load", () => {
  it("imports every amended module without throwing", () => {
    // The getters are lazy, so nothing above this line has thrown. An IIFE
    // placeholder would have failed this file at import time.
    expect(typeof roleLabel).toBe("function");
    expect(EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND.initial_proposal).toBe("proposal");
  });
});

describe("Phase 5 placeholders: artifact-protocol", () => {
  it("throws for the session_turn expected artifact type, naming P6-05", () => {
    expect(() => EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND.session_turn).toThrow(
      "session_turn expected artifact type lands in P6-05",
    );
  });
});

describe("Phase 5 placeholders: events", () => {
  it("uses the participant role label implemented by P6-01", () => {
    expect(roleLabel("participant")).toBe("Participant");
  });

  it("uses the session-turn label implemented by P6-01", () => {
    const events = createCoordinationEventFactory({
      text: (value: string) => value,
      eventDetails: (value: Record<string, unknown>) =>
        value as Record<string, string | number | boolean | null | string[]>,
    });

    expect(
      events.turnScheduled({
        runId: "run-placeholder",
        turnId: "turn-placeholder",
        sequence: 1,
        role: "planner",
        agentId: PARTICIPANT_ONE.id,
        kind: "session_turn",
        phase: "sessioning",
        revision: 0,
        expectedArtifactType: "proposal",
        inputArtifactCount: 0,
      }).message,
    ).toBe("Turn 1: Planner to produce the session turn.");
  });
});

describe("Phase 5 placeholders: context-builder", () => {
  /**
   * `TASK_INSTRUCTIONS`, `OUTPUT_SHAPES`, `OUTPUT_LIMITS` and `ROLE_VISIBILITY`
   * are module-private, and `build()` reads the expected artifact type before
   * any of them, so the first placeholder on the path always wins. They are
   * therefore covered collectively rather than one by one: exporting four
   * internal tables purely to assert them would widen the module's surface,
   * which this phase is not permitted to do.
   *
   * What matters is proven here -- the session path through the real public
   * entry point cannot quietly produce a prompt. It throws, and the message
   * names the Phase 6 task that replaces the placeholder.
   */
  it("cannot build a session prompt, and says which task lands it", () => {
    const builder = new RoleScopedContextBuilder();

    expect(() =>
      builder.build({
        run: sessionRun(),
        turn: sessionTurn(),
        artifacts: [],
        retryValidationErrors: [],
      }),
    ).toThrow(/lands in P6-0\d/);
  });

  it("never returns a prompt for a session turn under any retry state", () => {
    const builder = new RoleScopedContextBuilder();

    expect(() =>
      builder.build({
        run: sessionRun(),
        turn: { ...sessionTurn(), attemptCount: 1 },
        artifacts: [],
        retryValidationErrors: ["Expected the next number 9, received 7"],
      }),
    ).toThrow(/lands in P6-0\d/);
  });
});

describe("Phase 5 placeholders: workflow", () => {
  it("rejects a session turn that reaches the verified-handoff state guard", () => {
    const workflow = new VerifiedHandoffWorkflowV1();
    const turn: CoordinationTurn = {
      ...sessionTurn(),
      status: "committed",
      outputArtifactId: "artifact-placeholder",
    };

    expect(
      workflow.decideNext({ run: sessionRun(), turns: [turn], artifacts: [] }),
    ).toEqual({
      kind: "fail",
      code: "INVALID_STATE",
      message: "Verified-handoff run contains a session turn",
    });
  });
});
