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
import {
  DEFAULT_COORDINATION_POLICY,
  DEFAULT_SESSION_AUCTION_POLICY,
  SESSION_LIMITS,
} from "./types.js";

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

const bidTurn: CoordinationTurn = {
  ...turn,
  id: "turn-session-bid",
  kind: "session_bid",
  wavePurpose: "session_bidding",
};

const validBid = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  schemaVersion: 1,
  type: "session_bid",
  recommendation: "direct",
  candidateAnswer: "A bounded answer ready to publish.",
  plan: {
    summary: "Answer directly.",
    mode: "single",
    assignments: [{
      agentId: PARTICIPANT_ONE.id,
      position: 1,
      instruction: "Answer the request.",
    }],
    risks: [],
    assumptions: [],
  },
  confidenceBps: 8_000,
  estimatedOutputTokens: 1_000,
  ...overrides,
});

const validateBid = (
  rawOutput: string,
  policyOverrides: Partial<typeof DEFAULT_SESSION_AUCTION_POLICY> = {},
): ArtifactValidationResult => {
  const run = runFor("free_chat");
  return protocol.validate({
    run: {
      ...run,
      policy: {
        ...run.policy,
        auctionPolicy: {
          ...DEFAULT_SESSION_AUCTION_POLICY,
          routingMode: "auction",
          ...policyOverrides,
        },
      },
    },
    turn: bidTurn,
    attempt: { ...attempt, turnId: bidTurn.id },
    rawOutput,
  });
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

  it("accepts a strict bid and constructs authoritative bidder provenance", () => {
    const artifact = accepted(validateBid(validBid()));
    expect(artifact).toMatchObject({
      runId: "run-session",
      turnId: bidTurn.id,
      createdByRole: "participant",
      createdByAgentId: PARTICIPANT_ONE.id,
      type: "session_bid",
      payload: {
        recommendation: "direct",
        confidenceBps: 8_000,
        estimatedOutputTokens: 1_000,
      },
    });
  });

  it("accepts mechanically valid sequential and parallel auction plans", () => {
    const assignments = SESSION_PARTICIPANTS.slice(0, 2).map((agent, index) => ({
      agentId: agent.id,
      position: index + 1,
      instruction: `Perform step ${index + 1}.`,
    }));
    for (const mode of ["sequential", "parallel"] as const) {
      expect(validateBid(validBid({
        recommendation: "auction",
        candidateAnswer: undefined,
        plan: {
          summary: "Use two specialists.",
          mode,
          assignments,
          risks: ["Coordination cost"],
          assumptions: ["Inputs are current"],
        },
      })).ok).toBe(true);
    }
  });

  it("requires literal JSON and rejects unknown or forged fields", () => {
    expect(rejected(validateBid(`\`\`\`json\n${validBid()}\n\`\`\``)).errors[0]?.code)
      .toBe("invalid_json");
    expect(validateBid(validBid({ createdByAgentId: "forged" })).ok).toBe(false);
    expect(validateBid(validBid({ type: "session_message" })).ok).toBe(false);
  });

  it.each([
    [
      "direct candidate",
      validBid({ candidateAnswer: undefined }),
      "invalid_direct_candidate",
    ],
    [
      "single bidder assignment",
      validBid({
        plan: {
          summary: "Wrong owner",
          mode: "single",
          assignments: [{
            agentId: SESSION_PARTICIPANTS[1]!.id,
            position: 1,
            instruction: "Answer.",
          }],
          risks: [],
          assumptions: [],
        },
      }),
      "invalid_single_assignment",
    ],
    [
      "participant-only assignments",
      validBid({
        recommendation: "auction",
        candidateAnswer: undefined,
        plan: {
          summary: "Foreign assignment",
          mode: "sequential",
          assignments: [{ agentId: "foreign-agent", position: 1, instruction: "Answer." }],
          risks: [],
          assumptions: [],
        },
      }),
      "foreign_assignment_agent",
    ],
    [
      "distinct assignments",
      validBid({
        recommendation: "auction",
        candidateAnswer: undefined,
        plan: {
          summary: "Duplicate assignment",
          mode: "sequential",
          assignments: [
            { agentId: PARTICIPANT_ONE.id, position: 1, instruction: "First." },
            { agentId: PARTICIPANT_ONE.id, position: 2, instruction: "Second." },
          ],
          risks: [],
          assumptions: [],
        },
      }),
      "duplicate_assignment_agent",
    ],
    [
      "contiguous positions",
      validBid({
        recommendation: "auction",
        candidateAnswer: undefined,
        plan: {
          summary: "Bad position",
          mode: "sequential",
          assignments: [{ agentId: PARTICIPANT_ONE.id, position: 2, instruction: "Answer." }],
          risks: [],
          assumptions: [],
        },
      }),
      "invalid_assignment_position",
    ],
  ])("enforces %s", (_label, output, code) => {
    expect(rejected(validateBid(output)).errors[0]?.code).toBe(code);
  });

  it("enforces direct, auction, and parallel execution budgets", () => {
    expect(rejected(validateBid(validBid({ estimatedOutputTokens: 1_001 }), {
      directOutputTokenBudget: 1_000,
    })).errors[0]?.code).toBe("direct_budget_exceeded");
    expect(rejected(validateBid(validBid({
      recommendation: "auction",
      candidateAnswer: undefined,
      estimatedOutputTokens: 1_001,
    }), { auctionExecutionTokenBudget: 1_000 })).errors[0]?.code)
      .toBe("execution_budget_exceeded");

    const assignments = SESSION_PARTICIPANTS.slice(0, 2).map((agent, index) => ({
      agentId: agent.id,
      position: index + 1,
      instruction: "Answer.",
    }));
    const run = runFor("free_chat");
    const result = protocol.validate({
      run: {
        ...run,
        policy: {
          ...run.policy,
          maxParallelTurns: 1,
          auctionPolicy: { ...DEFAULT_SESSION_AUCTION_POLICY, routingMode: "auction" },
        },
      },
      turn: bidTurn,
      attempt: { ...attempt, turnId: bidTurn.id },
      rawOutput: validBid({
        recommendation: "auction",
        candidateAnswer: undefined,
        plan: {
          summary: "Too wide",
          mode: "parallel",
          assignments,
          risks: [],
          assumptions: [],
        },
      }),
    });
    expect(rejected(result).errors[0]?.code).toBe("parallel_limit_exceeded");
  });
});
