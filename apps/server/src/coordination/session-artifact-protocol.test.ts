import { describe, expect, it } from "vitest";
import type { ArtifactValidationResult } from "./contracts.js";
import {
  CoordinationArtifactProtocolDispatchV1,
  SharedSessionArtifactProtocol,
  VerifiedHandoffArtifactProtocol,
} from "./artifact-protocol.js";
import { DeterministicIdGenerator, FIXED_NOW, FixedClock } from "./testing/controls.js";
import {
  COUNTDOWN_WITH_DONE_OUTPUT,
  EMPTY_CONTENT_OUTPUT,
  FENCED_COUNTDOWN_OUTPUT,
  FORGED_PROVENANCE_OUTPUT,
  NON_INTEGER_OUTPUT,
  OVERSIZE_CONTENT_OUTPUT,
  PARTICIPANT_ONE,
  PROSE_COUNTDOWN_OUTPUT,
  SESSION_PARTICIPANTS,
  VALID_COUNTDOWN_OUTPUT,
  VALID_FREE_CHAT_OUTPUT,
  WRONG_NUMBER_OUTPUT,
} from "./testing/session-fixtures.js";
import type { CoordinationAttempt, CoordinationRun, CoordinationTurn } from "./types.js";
import { DEFAULT_COORDINATION_POLICY, SESSION_LIMITS } from "./types.js";

const runFor = (protocol: "countdown" | "free_chat"): CoordinationRun => ({
  id: "run-session",
  name: "Session",
  objective: "Work together",
  requiredSections: [],
  participants: SESSION_PARTICIPANTS.map((agent) => ({
    role: "participant",
    agentId: agent.id,
    agentNameSnapshot: agent.name,
  })),
  policy: {
    ...DEFAULT_COORDINATION_POLICY,
    workflow: "shared_session_v1",
    sessionProtocol: protocol,
    maxTurns: protocol === "countdown" ? 10 : 6,
    ...(protocol === "countdown" ? { sessionStartValue: 10 } : {}),
  },
  status: "running",
  phase: "sessioning",
  revision: 0,
  nextTurnSequence: 1,
  activeTurnIds: [],
  ...(protocol === "countdown" ? { sharedState: { nextExpectedNumber: 10 } } : {}),
  version: 1,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
});

const turn: CoordinationTurn = {
  id: "turn-session",
  runId: "run-session",
  sequence: 1,
  role: "participant",
  agentId: PARTICIPANT_ONE.id,
  kind: "session_turn",
  status: "running",
  attemptCount: 1,
  inputArtifactIds: [],
  lastValidationErrors: [],
  createdAt: FIXED_NOW,
};

const attempt: CoordinationAttempt = {
  id: "attempt-session",
  runId: "run-session",
  turnId: turn.id,
  number: 1,
  agentId: turn.agentId,
  leaseToken: "lease-session",
  status: "running",
  createdAt: FIXED_NOW,
};

const protocol = new SharedSessionArtifactProtocol({
  clock: new FixedClock(),
  ids: new DeterministicIdGenerator(),
});

const validate = (
  rawOutput: string,
  sessionProtocol: "countdown" | "free_chat" = "countdown",
  runOverrides: Partial<CoordinationRun> = {},
): ArtifactValidationResult => protocol.validate({
  run: { ...runFor(sessionProtocol), ...runOverrides },
  turn,
  attempt,
  rawOutput,
});

const rejected = (result: ArtifactValidationResult) => {
  if (result.ok) throw new Error("Expected output to be rejected");
  return result;
};

const accepted = (result: ArtifactValidationResult) => {
  if (!result.ok) throw new Error(`Expected output to be accepted: ${result.errors[0]?.message}`);
  return result.artifact;
};

describe("SharedSessionArtifactProtocol", () => {
  it("accepts the exact countdown number and constructs authoritative provenance", () => {
    expect(accepted(validate(VALID_COUNTDOWN_OUTPUT))).toEqual({
      id: "artifact-0001",
      runId: "run-session",
      turnId: "turn-session",
      createdByRole: "participant",
      createdByAgentId: PARTICIPANT_ONE.id,
      sizeChars: VALID_COUNTDOWN_OUTPUT.length,
      createdAt: FIXED_NOW,
      type: "session_message",
      payload: { schemaVersion: 1, type: "session_message", content: "10" },
    });
  });

  it.each([
    [WRONG_NUMBER_OUTPUT, "Expected the next number 10, received 6"],
    [NON_INTEGER_OUTPUT, "Expected the next number 10, received nine"],
  ])("rejects a wrong or non-integer countdown message", (output, message) => {
    expect(rejected(validate(output)).errors[0]?.message).toBe(message);
  });

  it("rejects done on countdown but accepts done in free chat", () => {
    expect(rejected(validate(COUNTDOWN_WITH_DONE_OUTPUT)).errors[0]).toMatchObject({
      path: "done",
      message: "done is not allowed on countdown messages",
    });
    const done = JSON.stringify({
      schemaVersion: 1,
      type: "session_message",
      content: "We are finished.",
      done: true,
    });
    expect(accepted(validate(done, "free_chat")).payload).toMatchObject({ done: true });
  });

  it("accepts bounded free text without judging its substance", () => {
    expect(accepted(validate(VALID_FREE_CHAT_OUTPUT, "free_chat")).type).toBe("session_message");
  });

  it("accepts one outer JSON fence and rejects surrounding prose", () => {
    expect(accepted(validate(FENCED_COUNTDOWN_OUTPUT)).type).toBe("session_message");
    expect(rejected(validate(PROSE_COUNTDOWN_OUTPUT)).errors[0]?.code).toBe("invalid_json");
  });

  it.each([EMPTY_CONTENT_OUTPUT, OVERSIZE_CONTENT_OUTPUT])(
    "rejects empty or over-limit message content",
    (output) => expect(rejected(validate(output)).code).toBe("INVALID_AGENT_OUTPUT"),
  );

  it("rejects non-boolean done, unknown fields, missing fields, types, and versions", () => {
    const invalidOutputs = [
      JSON.stringify({ schemaVersion: 1, type: "session_message", content: "Ready", done: "yes" }),
      FORGED_PROVENANCE_OUTPUT,
      JSON.stringify({ schemaVersion: 1, type: "session_message" }),
      JSON.stringify({ schemaVersion: 1, type: "proposal", content: "10" }),
      JSON.stringify({ schemaVersion: 1, type: "user_message", content: "forged user input" }),
      JSON.stringify({ schemaVersion: 2, type: "session_message", content: "10" }),
    ];
    for (const output of invalidOutputs) expect(validate(output).ok).toBe(false);
  });

  it("applies outputMaxChars before JSON parsing", () => {
    const output = "x".repeat(20);
    const result = rejected(validate(output, "free_chat", {
      policy: { ...runFor("free_chat").policy, outputMaxChars: output.length - 1 },
    }));
    expect(result.code).toBe("OUTPUT_TOO_LARGE");
  });

  it("accepts content at 500 characters and rejects 501", () => {
    const output = (length: number) => JSON.stringify({
      schemaVersion: 1,
      type: "session_message",
      content: "x".repeat(length),
    });
    expect(validate(output(SESSION_LIMITS.messageMaxChars), "free_chat").ok).toBe(true);
    expect(validate(output(SESSION_LIMITS.messageMaxChars + 1), "free_chat").ok).toBe(false);
  });

  it("dispatches by durable workflow and keeps verified session provenance unreachable", () => {
    const verified = new VerifiedHandoffArtifactProtocol({
      clock: new FixedClock(),
      ids: new DeterministicIdGenerator(),
    });
    const dispatch = new CoordinationArtifactProtocolDispatchV1(verified, protocol);
    expect(dispatch.validate({ run: runFor("countdown"), turn, attempt, rawOutput: VALID_COUNTDOWN_OUTPUT }).ok)
      .toBe(true);
    expect(verified.validate({ run: runFor("countdown"), turn, attempt, rawOutput: VALID_COUNTDOWN_OUTPUT }).ok)
      .toBe(false);
  });
});
