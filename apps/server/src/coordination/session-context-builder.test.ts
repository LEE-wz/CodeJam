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

const sessionRun = (contextMaxChars = 12_000): CoordinationRun => ({
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
    sessionProtocol: "free_chat",
    maxTurns: 6,
    contextMaxChars,
  },
  status: "running",
  phase: "sessioning",
  revision: 0,
  nextTurnSequence: 4,
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
  artifacts: CoordinationArtifact[],
  inputArtifactIds = artifacts.map(({ id }) => id),
  contextMaxChars = 12_000,
) => new RoleScopedContextBuilder().build({
  run: sessionRun(contextMaxChars),
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
    const envelope = build([artifacts[2]!, artifacts[0]!, artifacts[1]!],
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
    const envelope = build([second, user, first], [second.id, user.id, first.id]);
    const firstIndex = envelope.prompt.indexOf("Relay One: Initial comparison");
    const userIndex = envelope.prompt.indexOf("User: Please compare the options");
    const secondIndex = envelope.prompt.indexOf("Relay Two: Revised comparison");
    expect(firstIndex).toBeGreaterThan(0);
    expect(firstIndex).toBeLessThan(userIndex);
    expect(userIndex).toBeLessThan(secondIndex);
  });

  it("uses the free-chat instruction and exposes the done signal", () => {
    const freeChat = build([]);
    expect(freeChat.prompt).toContain("contribute the next message toward the shared objective");
    expect(freeChat.prompt).toContain('"done":<optional boolean>');
  });

  it("never states an expected answer in a session prompt", () => {
    // The ordered-output property must come from the plan and the transcript
    // (P14-06); the engine never tells a participant what to say.
    const envelope = build([message(0, "10")]);
    expect(envelope.prompt).not.toContain("nextExpectedNumber");
    expect(envelope.prompt).not.toContain("expected number");
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
    const envelope = build([visible, unrelated], [visible.id, unrelated.id]);
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
    const envelope = build(artifacts, undefined, 2_150);

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
    const envelope = build(artifacts);

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
    const envelope = build(artifacts, undefined, 1_600);

    expect(envelope.prompt).toContain(SESSION_OMISSION_MARKER);
    expect(envelope.prompt).toContain(CONTEXT_TRUNCATION_MARKER);
    expect(envelope.prompt).not.toContain("OLDEST-");
    expect(envelope.truncated).toBe(true);
  });

  it("renders a long transcript within the session window without dropping recent turns", () => {
    const artifacts = Array.from({ length: 40 }, (_unused, index) =>
      message(index, `MESSAGE-${index}`),
    );
    const envelope = build(artifacts,
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
    const envelope = build([...artifacts].reverse(),
      artifacts.map(({ id }) => id),
      6_000,
    );
    expect(envelope.prompt).toContain(`User: ${request}`);
    expect(envelope.prompt).toContain("CURRENT-WAVE-2");
    expect(envelope.prompt).toContain(SESSION_OMISSION_MARKER);
  });

  it("produces the same prompt and digest for identical input", () => {
    const artifacts = [message(0, "One"), message(1, "Two")];
    const first = build(artifacts);
    const second = build(artifacts);
    expect(second.prompt).toBe(first.prompt);
    expect(second.promptDigest).toBe(first.promptDigest);
    expect(first.promptDigest).toBe(digestPrompt(first.prompt));
  });
});

/**
 * P15-05: a session turn now pins its transcript as a sequence bound instead of
 * listing every artifact id, because listing them made the ledger grow O(n^2)
 * (`P15-01`). These tests hold the bound to the same trust boundary the id list
 * had: it selects exactly the transcript the workflow chose, and it can never
 * widen a turn onto anything the workflow did not name.
 */
describe("session context builder transcript bound (P15-05)", () => {
  const seq = (artifact: CoordinationArtifact, value: number): CoordinationArtifact => ({
    ...artifact,
    transcriptSequence: value,
  });

  const boundedTurn = (
    inputThroughSequence: number,
    inputArtifactIds: string[] = [],
  ): CoordinationTurn => ({
    id: "turn-session-bounded",
    runId: "run-session-context",
    sequence: 9,
    role: "participant",
    agentId: PARTICIPANT_ONE.id,
    kind: "session_turn",
    status: "scheduled",
    attemptCount: 0,
    inputArtifactIds,
    inputThroughSequence,
    lastValidationErrors: [],
    createdAt: FIXED_NOW,
  });

  const buildBounded = (
    artifacts: CoordinationArtifact[],
    inputThroughSequence: number,
    inputArtifactIds: string[] = [],
  ) =>
    new RoleScopedContextBuilder().build({
      run: sessionRun(),
      turn: boundedTurn(inputThroughSequence, inputArtifactIds),
      artifacts,
      retryValidationErrors: [],
    });

  const transcript = [
    seq(userMessage(0, "Start with seller verification."), 1),
    seq(message(0, "Verification first, then listings."), 2),
    seq(message(1, "Add an escrow hold."), 3),
  ];

  it("selects the same transcript the equivalent id list would", () => {
    const bounded = buildBounded(transcript, 3);
    const listed = build(transcript, transcript.map(({ id }) => id));
    expect(bounded.prompt).toBe(listed.prompt);
    expect(bounded.promptDigest).toBe(listed.promptDigest);
  });

  it("excludes an artifact committed above the bound", () => {
    const later = seq(message(2, "A reporting route a moderator reads daily."), 4);
    const bounded = buildBounded([...transcript, later], 3);
    expect(bounded.prompt).toContain("Add an escrow hold.");
    expect(bounded.prompt).not.toContain("A reporting route a moderator reads daily.");
  });

  // The security property. `session_turn` may read a plan, so a bound that
  // swept up every allowed type would hand this turn a plan the workflow never
  // chose - including a previous round's.
  it("never sweeps in a plan the workflow did not name", () => {
    const plan: CoordinationArtifact = {
      id: "artifact-plan-unnamed",
      runId: "run-session-context",
      turnId: "turn-plan-unnamed",
      type: "session_plan",
      payload: {
        schemaVersion: 1,
        type: "session_plan",
        mode: "sequential",
        assignments: [
          { agentId: PARTICIPANT_TWO.id, position: 1, instruction: "Leaked instruction." },
        ],
      },
      createdByRole: "participant",
      createdByAgentId: PARTICIPANT_THREE.id,
      transcriptSequence: 2,
      sizeChars: 40,
      createdAt: FIXED_NOW,
    };
    const bounded = buildBounded([...transcript, plan], 3);
    expect(bounded.prompt).not.toContain("Leaked instruction.");
  });

  it("includes a plan that is named explicitly alongside the bound", () => {
    const plan: CoordinationArtifact = {
      id: "artifact-plan-named",
      runId: "run-session-context",
      turnId: "turn-plan-named",
      type: "session_plan",
      payload: {
        schemaVersion: 1,
        type: "session_plan",
        mode: "sequential",
        assignments: [
          { agentId: PARTICIPANT_ONE.id, position: 1, instruction: "Open with the headline risk." },
        ],
      },
      createdByRole: "participant",
      createdByAgentId: PARTICIPANT_ONE.id,
      transcriptSequence: 4,
      sizeChars: 40,
      createdAt: FIXED_NOW,
    };
    const bounded = buildBounded([...transcript, plan], 3, [plan.id]);
    expect(bounded.prompt).toContain("Open with the headline risk.");
  });
});
