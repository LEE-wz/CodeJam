import { describe, expect, it } from "vitest";
import type { ArtifactValidationResult } from "./contracts.js";
import {
  CoordinationArtifactProtocolDispatchV1,
  SharedSessionArtifactProtocol,
  VerifiedHandoffArtifactProtocol,
} from "./artifact-protocol.js";
import { DeterministicIdGenerator, FIXED_NOW, FixedClock } from "./testing/controls.js";
import {
  EMPTY_CONTENT_OUTPUT,
  FENCED_MESSAGE_OUTPUT,
  FORGED_PROVENANCE_OUTPUT,
  OVERSIZE_CONTENT_OUTPUT,
  PARTICIPANT_ONE,
  PROSE_MESSAGE_OUTPUT,
  SESSION_PARTICIPANTS,
  VALID_FREE_CHAT_OUTPUT,
} from "./testing/session-fixtures.js";
import type { CoordinationAttempt, CoordinationRun, CoordinationTurn } from "./types.js";
import { DEFAULT_COORDINATION_POLICY, SESSION_LIMITS } from "./types.js";

const runFor = (): CoordinationRun => ({
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
    sessionProtocol: "free_chat",
    maxTurns: 6,
  },
  status: "running",
  phase: "sessioning",
  revision: 0,
  nextTurnSequence: 1,
  activeTurnIds: [],
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
  runOverrides: Partial<CoordinationRun> = {},
): ArtifactValidationResult => protocol.validate({
  run: { ...runFor(), ...runOverrides },
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
  it("accepts a bounded message and constructs authoritative provenance", () => {
    expect(accepted(validate(VALID_FREE_CHAT_OUTPUT))).toEqual({
      id: "artifact-0001",
      runId: "run-session",
      turnId: "turn-session",
      createdByRole: "participant",
      createdByAgentId: PARTICIPANT_ONE.id,
      sizeChars: VALID_FREE_CHAT_OUTPUT.length,
      createdAt: FIXED_NOW,
      type: "session_message",
      payload: {
        schemaVersion: 1,
        type: "session_message",
        content: "Start with seller verification before any listing goes live.",
      },
    });
  });

  it("accepts the advisory done signal", () => {
    const done = JSON.stringify({
      schemaVersion: 1,
      type: "session_message",
      content: "We are finished.",
      done: true,
    });
    expect(accepted(validate(done)).payload).toMatchObject({ done: true });
  });

  it("accepts bounded free text without judging its substance", () => {
    expect(accepted(validate(VALID_FREE_CHAT_OUTPUT)).type).toBe("session_message");
  });

  it("accepts one outer JSON fence and rejects surrounding prose", () => {
    expect(accepted(validate(FENCED_MESSAGE_OUTPUT)).type).toBe("session_message");
    expect(rejected(validate(PROSE_MESSAGE_OUTPUT)).errors[0]?.code).toBe("invalid_json");
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
    const result = rejected(validate(output, {
      policy: { ...runFor().policy, outputMaxChars: output.length - 1 },
    }));
    expect(result.code).toBe("OUTPUT_TOO_LARGE");
  });

  it("accepts content at 500 characters and rejects 501", () => {
    const output = (length: number) => JSON.stringify({
      schemaVersion: 1,
      type: "session_message",
      content: "x".repeat(length),
    });
    expect(validate(output(SESSION_LIMITS.messageMaxChars)).ok).toBe(true);
    expect(validate(output(SESSION_LIMITS.messageMaxChars + 1)).ok).toBe(false);
  });

  it("dispatches by durable workflow and keeps verified session provenance unreachable", () => {
    const verified = new VerifiedHandoffArtifactProtocol({
      clock: new FixedClock(),
      ids: new DeterministicIdGenerator(),
    });
    const dispatch = new CoordinationArtifactProtocolDispatchV1(verified, protocol);
    expect(dispatch.validate({ run: runFor(), turn, attempt, rawOutput: VALID_FREE_CHAT_OUTPUT }).ok)
      .toBe(true);
    expect(verified.validate({ run: runFor(), turn, attempt, rawOutput: VALID_FREE_CHAT_OUTPUT }).ok)
      .toBe(false);
  });
});
