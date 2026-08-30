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
import { DEFAULT_COORDINATION_POLICY } from "./types.js";

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

  it("uses protocol-specific instructions and exposes done only for free chat", () => {
    const countdown = build("countdown", [message(0, "10")]);
    expect(countdown.prompt).toContain("exactly one lower than the last number");
    expect(countdown.prompt).not.toContain('"done"');

    const freeChat = build("free_chat", []);
    expect(freeChat.prompt).toContain("Contribute the next message toward the shared objective");
    expect(freeChat.prompt).toContain('"done":<optional boolean>');
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

  it("produces the same prompt and digest for identical input", () => {
    const artifacts = [message(0, "One"), message(1, "Two")];
    const first = build("free_chat", artifacts);
    const second = build("free_chat", artifacts);
    expect(second.prompt).toBe(first.prompt);
    expect(second.promptDigest).toBe(first.promptDigest);
    expect(first.promptDigest).toBe(digestPrompt(first.prompt));
  });
});
