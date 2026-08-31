import { describe, expect, it } from "vitest";
import {
  createCoordinationEventFactory,
  materialiseEvent,
  roleLabel,
} from "./events.js";
import type { CoordinationEventDraft } from "./events.js";
import { MAX_EVENT_DETAIL_CHARS, defaultRedactor } from "./redaction.js";
import type { CoordinationEventType } from "./types.js";

const events = createCoordinationEventFactory();

const RUN_ID = "3d2a7f10-0a0a-4b0b-8c0c-1d1d1d1d1d1d";
const TURN_ID = "4e3b8021-1b1b-4c1c-9d1d-2e2e2e2e2e2e";
const ATTEMPT_ID = "5f4c9132-2c2c-4d2d-ae2e-3f3f3f3f3f3f";
const ARTIFACT_ID = "6a5da243-3d3d-4e3e-bf3f-404040404040";
const AGENT_ID = "7b6eb354-4e4e-4f4f-c040-515151515151";

/** One draft per frozen event type, so coverage is asserted, not assumed. */
const allDrafts = (): CoordinationEventDraft[] => [
  events.runCreated({
    runId: RUN_ID,
    name: "Rollout plan",
    workflow: "verified_handoff_v1",
    maxRevisions: 2,
    maxTurns: 8,
    requiredSectionKeys: ["scope", "risks"],
  }),
  events.runStarted({ runId: RUN_ID, participantAgentIds: [AGENT_ID] }),
  events.turnScheduled({
    runId: RUN_ID,
    turnId: TURN_ID,
    sequence: 1,
    role: "planner",
    agentId: AGENT_ID,
    kind: "initial_proposal",
    phase: "drafting",
    revision: 0,
    expectedArtifactType: "proposal",
    inputArtifactCount: 0,
  }),
  events.attemptStarted({
    runId: RUN_ID,
    turnId: TURN_ID,
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    role: "planner",
    agentId: AGENT_ID,
    promptDigest: "sha256:abc",
    truncated: true,
    timeoutMs: 120_000,
  }),
  events.attemptInvalidOutput({
    runId: RUN_ID,
    turnId: TURN_ID,
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    role: "planner",
    agentId: AGENT_ID,
    code: "INVALID_AGENT_OUTPUT",
    validationErrors: ["sections: required section 'risks' is missing"],
  }),
  events.attemptTimedOut({
    runId: RUN_ID,
    turnId: TURN_ID,
    attemptId: ATTEMPT_ID,
    attemptNumber: 2,
    role: "planner",
    agentId: AGENT_ID,
    timeoutMs: 120_000,
  }),
  events.attemptFailed({
    runId: RUN_ID,
    turnId: TURN_ID,
    attemptId: ATTEMPT_ID,
    attemptNumber: 2,
    role: "critic",
    agentId: AGENT_ID,
    code: "AGENT_EXECUTION_FAILED",
    reason: "runner exited with code 1",
  }),
  events.attemptCancelled({
    runId: RUN_ID,
    turnId: TURN_ID,
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    role: "critic",
    agentId: AGENT_ID,
    code: "STOPPED_BY_USER",
    reason: "stop requested",
  }),
  events.attemptStaleIgnored({
    runId: RUN_ID,
    turnId: TURN_ID,
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    reason: "lease no longer active",
  }),
  events.turnCommitted({
    runId: RUN_ID,
    turnId: TURN_ID,
    attemptId: ATTEMPT_ID,
    artifactId: ARTIFACT_ID,
    sequence: 1,
    role: "planner",
    agentId: AGENT_ID,
    artifactType: "proposal",
    sizeChars: 1234,
    outputDigest: "sha256:def",
  }),
  events.reviewDecided({
    runId: RUN_ID,
    turnId: TURN_ID,
    artifactId: ARTIFACT_ID,
    agentId: AGENT_ID,
    decision: "approve",
    issueCount: 0,
    issueCodes: [],
    revision: 0,
  }),
  events.reviewDecided({
    runId: RUN_ID,
    turnId: TURN_ID,
    artifactId: ARTIFACT_ID,
    agentId: AGENT_ID,
    decision: "reject",
    issueCount: 2,
    issueCodes: ["missing_section", "unclear_scope"],
    revision: 1,
  }),
  events.runStopRequested({ runId: RUN_ID }),
  events.runStopped({ runId: RUN_ID, code: "STOPPED_BY_USER" }),
  events.runCompleted({ runId: RUN_ID, artifactId: ARTIFACT_ID }),
  events.runFailed({
    runId: RUN_ID,
    code: "MAX_TURNS_EXCEEDED",
    reason: "turn ceiling reached",
  }),
  events.runInterrupted({ runId: RUN_ID, code: "SERVER_RESTARTED" }),
  events.runReconciled({
    runId: RUN_ID,
    turnId: TURN_ID,
    code: "RUN_ABANDONED",
    reason: "orchestration loop exited without settling the run",
  }),
  events.userMessageAppended({
    runId: RUN_ID,
    artifactId: ARTIFACT_ID,
    transcriptSequence: 1,
  }),
  events.runAwaitingInput({ runId: RUN_ID }),
];

const FROZEN_EVENT_TYPES: CoordinationEventType[] = [
  "run.created",
  "run.started",
  "turn.scheduled",
  "attempt.started",
  "attempt.invalid_output",
  "attempt.timed_out",
  "attempt.failed",
  "attempt.cancelled",
  "attempt.stale_ignored",
  "turn.committed",
  "review.approved",
  "review.rejected",
  "run.stop_requested",
  "run.stopped",
  "run.completed",
  "run.failed",
  "run.interrupted",
  "run.reconciled",
  "user.message_appended",
  "run.awaiting_input",
];

describe("coordination event factories", () => {
  it("covers every frozen event type", () => {
    const produced = new Set(allDrafts().map((draft) => draft.type));
    expect([...produced].sort()).toEqual([...FROZEN_EVENT_TYPES].sort());
  });

  it("produces stable, short display messages", () => {
    expect(allDrafts().map((draft) => `${draft.type}: ${draft.message}`)).toEqual([
      "run.created: Run created.",
      "run.started: Run started.",
      "turn.scheduled: Turn 1: Planner to produce the initial proposal.",
      "attempt.started: Planner attempt 1 started.",
      "attempt.invalid_output: Planner attempt 1 returned output that failed validation.",
      "attempt.timed_out: Planner attempt 2 timed out.",
      "attempt.failed: Critic attempt 2 failed.",
      "attempt.cancelled: Critic attempt 1 was cancelled.",
      "attempt.stale_ignored: A late result for attempt 1 was ignored.",
      "turn.committed: Turn 1: Planner committed a proposal.",
      "review.approved: Critic approved the proposal.",
      "review.rejected: Critic requested changes (2 issues).",
      "run.stop_requested: Stop requested.",
      "run.stopped: Run stopped.",
      "run.completed: Run completed.",
      "run.failed: Run failed: MAX_TURNS_EXCEEDED.",
      "run.interrupted: Run interrupted by a server restart.",
      "run.reconciled: Run reconciled after an orchestration exit.",
      "user.message_appended: User message appended.",
      "run.awaiting_input: Session is awaiting user input.",
    ]);
  });

  it("records user-message provenance without recording prompt content", () => {
    const draft = events.userMessageAppended({
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
      transcriptSequence: 4,
    });
    expect(draft).toMatchObject({
      type: "user.message_appended",
      actor: { type: "user" },
      artifactId: ARTIFACT_ID,
      details: { transcriptSequence: 4 },
    });
    expect(JSON.stringify(draft)).not.toContain("prompt content");
  });

  it("uses the product spelling for the Finaliser label but the stored enum in details", () => {
    const draft = events.turnScheduled({
      runId: RUN_ID,
      turnId: TURN_ID,
      sequence: 4,
      role: "finalizer",
      agentId: AGENT_ID,
      kind: "finalization",
      phase: "finalizing",
      revision: 1,
      expectedArtifactType: "final",
      inputArtifactCount: 2,
    });

    expect(draft.message).toBe("Turn 4: Finaliser to produce the finalization.");
    expect(draft.details.role).toBe("finalizer");
    expect(roleLabel("finalizer")).toBe("Finaliser");
  });

  it("records the truncated context flag on attempt.started, per handoff decision 1.2", () => {
    const draft = events.attemptStarted({
      runId: RUN_ID,
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      attemptNumber: 1,
      role: "planner",
      agentId: AGENT_ID,
      promptDigest: "sha256:abc",
      truncated: true,
      timeoutMs: 120_000,
    });

    expect(draft.details.truncated).toBe(true);
    expect(draft.details.promptDigest).toBe("sha256:abc");
  });

  it("routes a review decision to the matching frozen event type", () => {
    const base = {
      runId: RUN_ID,
      turnId: TURN_ID,
      artifactId: ARTIFACT_ID,
      agentId: AGENT_ID,
      issueCount: 0,
      issueCodes: [],
      revision: 0,
    };
    expect(events.reviewDecided({ ...base, decision: "approve" }).type).toBe("review.approved");
    expect(events.reviewDecided({ ...base, decision: "reject" }).type).toBe("review.rejected");
  });

  it("carries the correlating identifiers only where the frozen type allows", () => {
    const scheduled = events.turnScheduled({
      runId: RUN_ID,
      turnId: TURN_ID,
      sequence: 1,
      role: "planner",
      agentId: AGENT_ID,
      kind: "initial_proposal",
      phase: "drafting",
      revision: 0,
      expectedArtifactType: "proposal",
      inputArtifactCount: 0,
    });
    expect(scheduled.turnId).toBe(TURN_ID);
    expect(scheduled.attemptId).toBeUndefined();
    expect(scheduled.artifactId).toBeUndefined();

    const created = events.runCreated({
      runId: RUN_ID,
      name: "Rollout plan",
      workflow: "verified_handoff_v1",
      maxRevisions: 2,
      maxTurns: 8,
      requiredSectionKeys: [],
    });
    expect(created.turnId).toBeUndefined();
  });

  it("attributes actors correctly", () => {
    expect(events.runCreated({
      runId: RUN_ID,
      name: "n",
      workflow: "verified_handoff_v1",
      maxRevisions: 2,
      maxTurns: 8,
      requiredSectionKeys: [],
    }).actor).toEqual({ type: "user" });

    expect(
      events.attemptStarted({
        runId: RUN_ID,
        turnId: TURN_ID,
        attemptId: ATTEMPT_ID,
        attemptNumber: 1,
        role: "critic",
        agentId: AGENT_ID,
        promptDigest: "d",
        truncated: false,
        timeoutMs: 1,
      }).actor,
    ).toEqual({ type: "agent", agentId: AGENT_ID, role: "critic" });

    // A cancellation is the server settling state, not the Agent acting.
    expect(
      events.attemptCancelled({
        runId: RUN_ID,
        turnId: TURN_ID,
        attemptId: ATTEMPT_ID,
        attemptNumber: 1,
        role: "critic",
        agentId: AGENT_ID,
        code: "STOPPED_BY_USER",
        reason: "stop requested",
      }).actor,
    ).toEqual({ type: "system" });

    expect(events.runInterrupted({ runId: RUN_ID, code: "SERVER_RESTARTED" }).actor).toEqual({
      type: "system",
    });
  });
});

describe("event factory redaction", () => {
  it("redacts details even when a caller passes a secret-bearing reason", () => {
    const draft = events.attemptFailed({
      runId: RUN_ID,
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      attemptNumber: 1,
      role: "planner",
      agentId: AGENT_ID,
      code: "AGENT_EXECUTION_FAILED",
      reason: "POST failed, Authorization: Bearer abc123def456ghi789",
    });

    expect(JSON.stringify(draft)).not.toContain("abc123def456ghi789");
    expect(draft.details.reason).toContain("[redacted]");
  });

  it("bounds a long run name in details", () => {
    const draft = events.runCreated({
      runId: RUN_ID,
      name: "z".repeat(5000),
      workflow: "verified_handoff_v1",
      maxRevisions: 2,
      maxTurns: 8,
      requiredSectionKeys: [],
    });

    expect(draft.details.name).toHaveLength(MAX_EVENT_DETAIL_CHARS);
  });

  it("never lets a raw prompt or output reach a draft", () => {
    const drafts = allDrafts();
    const serialised = JSON.stringify(drafts);
    for (const forbidden of ["[CONTEXT]", "[YOUR TASK]", "leaseToken", "rawOutput", "prompt\""]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("accepts an injected redactor", () => {
    const shouty = createCoordinationEventFactory({
      text: (value) => value.toUpperCase(),
      eventDetails: () => ({ code: "REDACTED_BY_FAKE" }),
    });

    const draft = shouty.runStopped({ runId: RUN_ID, code: "STOPPED_BY_USER" });
    expect(draft.message).toBe("RUN STOPPED.");
    expect(draft.details).toEqual({ code: "REDACTED_BY_FAKE" });
  });
});

describe("materialiseEvent", () => {
  it("adds identity without inventing optional correlation fields", () => {
    const draft = events.runCreated({
      runId: RUN_ID,
      name: "Rollout plan",
      workflow: "verified_handoff_v1",
      maxRevisions: 2,
      maxTurns: 8,
      requiredSectionKeys: ["scope"],
    });

    const event = materialiseEvent(draft, {
      id: "event-1",
      sequence: 1,
      createdAt: "2026-08-30T00:00:00.000Z",
    });

    expect(event).toEqual({
      id: "event-1",
      runId: RUN_ID,
      sequence: 1,
      type: "run.created",
      actor: { type: "user" },
      message: "Run created.",
      details: defaultRedactor.eventDetails({
        name: "Rollout plan",
        workflow: "verified_handoff_v1",
        maxRevisions: 2,
        maxTurns: 8,
        requiredSectionKeys: ["scope"],
      }),
      createdAt: "2026-08-30T00:00:00.000Z",
    });
    expect("turnId" in event).toBe(false);
    expect("attemptId" in event).toBe(false);
    expect("artifactId" in event).toBe(false);
  });

  it("preserves every correlation identifier a draft does carry", () => {
    const draft = events.turnCommitted({
      runId: RUN_ID,
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      artifactId: ARTIFACT_ID,
      sequence: 1,
      role: "planner",
      agentId: AGENT_ID,
      artifactType: "proposal",
      sizeChars: 10,
      outputDigest: "sha256:def",
    });

    const event = materialiseEvent(draft, {
      id: "event-2",
      sequence: 7,
      createdAt: "2026-08-30T00:00:01.000Z",
    });

    expect(event.turnId).toBe(TURN_ID);
    expect(event.attemptId).toBe(ATTEMPT_ID);
    expect(event.artifactId).toBe(ARTIFACT_ID);
    expect(event.sequence).toBe(7);
  });
});
