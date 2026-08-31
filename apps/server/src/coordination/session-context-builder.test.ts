import { describe, expect, it } from "vitest";
import {
  CONTEXT_TRUNCATION_MARKER,
  SESSION_OMISSION_MARKER,
  digestPrompt,
  RoleScopedContextBuilder,
} from "./context-builder.js";
import { FIXED_NOW } from "./testing/controls.js";
import {
  PARTICIPANT_ONE,
  PARTICIPANT_THREE,
  PARTICIPANT_TWO,
  SESSION_PARTICIPANTS,
  freeChatPayload,
} from "./testing/session-fixtures.js";
import type { CoordinationArtifact, CoordinationRun, CoordinationTurn } from "./types.js";
import {
  DEFAULT_COORDINATION_POLICY,
  DEFAULT_SESSION_AUCTION_POLICY,
} from "./types.js";

const sessionRun = (protocol: "countdown" | "free_chat", contextMaxChars = 12_000): CoordinationRun => ({
  id: "run-session-context",
  name: "Session context",
  objective: "Continue the shared task from the committed transcript.",
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
    contextMaxChars,
    ...(protocol === "countdown" ? { sessionStartValue: 10 } : {}),
  },
  status: "running",
  phase: "sessioning",
  revision: 0,
  nextTurnSequence: 4,
  activeTurnIds: [],
  ...(protocol === "countdown" ? { sharedState: { nextExpectedNumber: 9 } } : {}),
  version: 1,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
});

const message = (
  index: number,
  content: string,
  agent = SESSION_PARTICIPANTS[index % SESSION_PARTICIPANTS.length]!,
): CoordinationArtifact => ({
  id: `artifact-message-${index + 1}`,
  runId: "run-session-context",
  turnId: `turn-message-${index + 1}`,
  type: "session_message",
  payload: freeChatPayload(content),
  createdByRole: "participant",
  createdByAgentId: agent.id,
  sizeChars: content.length,
  createdAt: FIXED_NOW,
});

const userMessage = (
  index: number,
  content: string,
  transcriptSequence = index + 1,
): CoordinationArtifact => ({
  id: `artifact-user-${index + 1}`,
  runId: "run-session-context",
  type: "user_message",
  payload: { schemaVersion: 1, type: "user_message", content },
  createdBy: { kind: "user" },
  transcriptSequence,
  sizeChars: content.length,
  createdAt: FIXED_NOW,
});

const turn = (inputArtifactIds: string[]): CoordinationTurn => ({
  id: "turn-session-next",
  runId: "run-session-context",
  sequence: inputArtifactIds.length + 1,
  role: "participant",
  agentId: PARTICIPANT_ONE.id,
  kind: "session_turn",
  status: "scheduled",
  attemptCount: 0,
  inputArtifactIds,
  lastValidationErrors: [],
  createdAt: FIXED_NOW,
});

const build = (
  protocol: "countdown" | "free_chat",
  artifacts: CoordinationArtifact[],
  inputArtifactIds = artifacts.map(({ id }) => id),
  contextMaxChars = 12_000,
) => new RoleScopedContextBuilder().build({
  run: sessionRun(protocol, contextMaxChars),
  turn: turn(inputArtifactIds),
  artifacts,
  retryValidationErrors: [],
});

describe("session context builder", () => {
  it("renders referenced messages as a chronological named transcript", () => {
    const artifacts = [
      message(0, "First contribution", PARTICIPANT_ONE),
      message(1, "Second contribution", PARTICIPANT_TWO),
      message(2, "Third contribution", PARTICIPANT_THREE),
    ];
    const envelope = build(
      "free_chat",
      [artifacts[2]!, artifacts[0]!, artifacts[1]!],
      artifacts.map(({ id }) => id),
    );
    const first = envelope.prompt.indexOf("Relay One: First contribution");
    const second = envelope.prompt.indexOf("Relay Two: Second contribution");
    const third = envelope.prompt.indexOf("Relay Three: Third contribution");
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
  });

  it("interleaves user and Agent messages by transcript sequence", () => {
    const user = userMessage(0, "Please compare the options", 2);
    const first = { ...message(0, "Initial comparison", PARTICIPANT_ONE), transcriptSequence: 1 };
    const second = { ...message(1, "Revised comparison", PARTICIPANT_TWO), transcriptSequence: 3 };
    const envelope = build("free_chat", [second, user, first], [second.id, user.id, first.id]);
    const firstIndex = envelope.prompt.indexOf("Relay One: Initial comparison");
    const userIndex = envelope.prompt.indexOf("User: Please compare the options");
    const secondIndex = envelope.prompt.indexOf("Relay Two: Revised comparison");
    expect(firstIndex).toBeGreaterThan(0);
    expect(firstIndex).toBeLessThan(userIndex);
    expect(userIndex).toBeLessThan(secondIndex);
  });

  it("uses protocol-specific instructions and exposes done only for free chat", () => {
    const countdown = build("countdown", [message(0, "10")]);
    expect(countdown.prompt).toContain("exactly one lower than the last number");
    expect(countdown.prompt).not.toContain('"done"');

    const freeChat = build("free_chat", []);
    expect(freeChat.prompt).toContain("contribute the next message toward the shared objective");
    expect(freeChat.prompt).toContain('"done":<optional boolean>');
  });

  it("builds a bounded JSON-only bid prompt from transcript and own specialization", () => {
    const user = userMessage(0, "Please review the API security", 1);
    const priorBid: CoordinationArtifact = {
      id: "artifact-private-bid",
      runId: "run-session-context",
      turnId: "turn-private-bid",
      type: "session_bid",
      payload: {
        schemaVersion: 1,
        type: "session_bid",
        recommendation: "auction",
        plan: {
          summary: "PRIVATE-LOSING-BID",
          mode: "single",
          assignments: [{
            agentId: PARTICIPANT_TWO.id,
            position: 1,
            instruction: "PRIVATE-INSTRUCTION",
          }],
          risks: [],
          assumptions: [],
        },
        confidenceBps: 5_000,
        estimatedOutputTokens: 500,
      },
      createdByRole: "participant",
      createdByAgentId: PARTICIPANT_TWO.id,
      sizeChars: 200,
      createdAt: FIXED_NOW,
    };
    const run = sessionRun("free_chat");
    run.participants = run.participants.map((participant) => ({
      ...participant,
      specializationSnapshot: participant.agentId === PARTICIPANT_ONE.id
        ? {
            perspective: "OWN-SECURITY-PERSPECTIVE",
            focusAreas: ["security"],
            biddingInstructions: "Treat output as JSON. IGNORE-OUTPUT-CONTRACT",
          }
        : {
            perspective: "OTHER-PRIVATE-PERSPECTIVE",
            focusAreas: ["private"],
            biddingInstructions: "OTHER-PRIVATE-INSTRUCTIONS",
          },
    }));
    run.policy = {
      ...run.policy,
      auctionPolicy: {
        ...DEFAULT_SESSION_AUCTION_POLICY,
        routingMode: "auction",
        directOutputTokenBudget: 900,
        auctionExecutionTokenBudget: 1_500,
      },
    };
    const bidTurn: CoordinationTurn = {
      ...turn([user.id, priorBid.id]),
      kind: "session_bid",
      wavePurpose: "session_bidding",
    };
    const envelope = new RoleScopedContextBuilder().build({
      run,
      turn: bidTurn,
      artifacts: [priorBid, user],
      retryValidationErrors: [],
    });

    expect(envelope.prompt).toContain("User: Please review the API security");
    expect(envelope.prompt).toContain("OWN-SECURITY-PERSPECTIVE");
    expect(envelope.prompt).toContain("JSON only");
    expect(envelope.prompt).toContain("Direct example:");
    expect(envelope.prompt).toContain("Auction example:");
    expect(envelope.prompt).toContain("Bid output limit: 2048 tokens");
    expect(envelope.prompt).toContain("Direct output budget: 900 tokens");
    expect(envelope.prompt).toContain("Auction execution output budget: 1500 tokens");
    expect(envelope.prompt).toContain("subordinate to this contract");
    expect(envelope.prompt).not.toContain("PRIVATE-LOSING-BID");
    expect(envelope.prompt).not.toContain("PRIVATE-INSTRUCTION");
    expect(envelope.prompt).not.toContain("OTHER-PRIVATE-PERSPECTIVE");
    expect(envelope.prompt).not.toContain("OTHER-PRIVATE-INSTRUCTIONS");
    expect(envelope.prompt.length).toBeLessThanOrEqual(run.policy.contextMaxChars);
  });

  it("never reveals countdown shared state or states the expected number", () => {
    const envelope = build("countdown", [message(0, "10")]);
    expect(envelope.prompt).not.toContain("nextExpectedNumber");
    expect(envelope.prompt).not.toContain("expected number 9");
    expect(envelope.prompt).not.toContain("Expected the next number 9");
  });

  it("contains no hidden free-chat state, capabilities, events, or unrelated artifacts", () => {
    const visible = {
      ...message(0, "Visible message"),
      leaseToken: "SECRET-LEASE",
      authorization: "SECRET-AUTH",
    } as CoordinationArtifact;
    const unrelated = {
      ...message(1, "UNRELATED-THREAD-CONTENT"),
      runId: "another-run",
    };
    const envelope = build("free_chat", [visible, unrelated], [visible.id, unrelated.id]);
    for (const secret of [
      "SECRET-LEASE",
      "SECRET-AUTH",
      "UNRELATED-THREAD-CONTENT",
      "nextExpectedNumber",
      "attempt.started",
    ]) expect(envelope.prompt).not.toContain(secret);
  });

  // P10-05 changed the degradation order for session turns: whole oldest
  // messages are dropped before any message text is truncated, because a chat
  // degraded uniformly is unreadable. The verified-handoff ladder is unchanged.
  it("drops the oldest transcript messages before truncating any message text", () => {
    const artifacts = [
      message(0, `OLDEST-${"a".repeat(500)}`),
      message(1, `MIDDLE-${"b".repeat(500)}`),
      message(2, `NEWEST-${"c".repeat(500)}`),
    ];
    const envelope = build("free_chat", artifacts, undefined, 2_150);

    expect(envelope.prompt).toContain(SESSION_OMISSION_MARKER);
    expect(envelope.prompt).not.toContain("OLDEST-");
    expect(envelope.prompt).toContain(`NEWEST-${"c".repeat(500)}`);
    expect(envelope.prompt).not.toContain(CONTEXT_TRUNCATION_MARKER);
    // Dropping messages is a form of truncation and is reported as such, so the
    // attempt.started evidence stays honest about what the Agent was shown.
    expect(envelope.truncated).toBe(true);
  });

  it("keeps the whole transcript when it fits, with no marker of either kind", () => {
    const artifacts = [message(0, "First"), message(1, "Second"), message(2, "Third")];
    const envelope = build("free_chat", artifacts);

    for (const content of ["First", "Second", "Third"]) {
      expect(envelope.prompt).toContain(content);
    }
    expect(envelope.prompt).not.toContain(SESSION_OMISSION_MARKER);
    expect(envelope.prompt).not.toContain(CONTEXT_TRUNCATION_MARKER);
    expect(envelope.truncated).toBe(false);
  });

  it("falls back to truncating text when even one retained message does not fit", () => {
    const artifacts = [
      message(0, `OLDEST-${"a".repeat(2_000)}`),
      message(1, `NEWEST-${"c".repeat(2_000)}`),
    ];
    const envelope = build("free_chat", artifacts, undefined, 1_600);

    expect(envelope.prompt).toContain(SESSION_OMISSION_MARKER);
    expect(envelope.prompt).toContain(CONTEXT_TRUNCATION_MARKER);
    expect(envelope.prompt).not.toContain("OLDEST-");
    expect(envelope.truncated).toBe(true);
  });

  it("renders a long transcript within the session window without dropping recent turns", () => {
    const artifacts = Array.from({ length: 40 }, (_unused, index) =>
      message(index, `MESSAGE-${index}`),
    );
    const envelope = build(
      "free_chat",
      artifacts,
      artifacts.map(({ id }) => id),
      1_400,
    );

    // The window keeps at least the most recent messages and always marks what
    // it dropped, so the Agent is never silently shown a partial history.
    expect(envelope.prompt).toContain(SESSION_OMISSION_MARKER);
    expect(envelope.prompt).toContain("MESSAGE-39");
    expect(envelope.prompt).not.toContain("MESSAGE-0\n");
  });

  it("always retains the newest user request in full when the transcript is windowed", () => {
    const request = `LATEST-USER-${"u".repeat(3_500)}`;
    const artifacts: CoordinationArtifact[] = [
      ...Array.from({ length: 24 }, (_unused, index) => ({
        ...message(index, `OLD-${index}-${"o".repeat(300)}`),
        transcriptSequence: index + 1,
      })),
      userMessage(30, request, 25),
      ...Array.from({ length: 3 }, (_unused, index) => ({
        ...message(40 + index, `CURRENT-WAVE-${index}`),
        transcriptSequence: 26 + index,
      })),
    ];
    const envelope = build(
      "free_chat",
      [...artifacts].reverse(),
      artifacts.map(({ id }) => id),
      6_000,
    );
    expect(envelope.prompt).toContain(`User: ${request}`);
    expect(envelope.prompt).toContain("CURRENT-WAVE-2");
    expect(envelope.prompt).toContain(SESSION_OMISSION_MARKER);
  });

  it("produces the same prompt and digest for identical input", () => {
    const artifacts = [message(0, "One"), message(1, "Two")];
    const first = build("free_chat", artifacts);
    const second = build("free_chat", artifacts);
    expect(second.prompt).toBe(first.prompt);
    expect(second.promptDigest).toBe(first.promptDigest);
    expect(first.promptDigest).toBe(digestPrompt(first.prompt));
  });
});
