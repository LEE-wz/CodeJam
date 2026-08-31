/**
 * Shared-session fixtures (P5-05).
 *
 * A separate module from `fixtures.ts` on purpose: the Phase 1 fixture pack is
 * frozen for the Phase 2 repository and API suites, so session material is
 * added alongside it rather than into it.
 *
 * Everything here is deterministic -- fixed IDs, the fixed clock, no randomness,
 * no network, no secrets -- so a session test asserting an exact transcript,
 * digest, or event sequence stays reproducible.
 */
import type { CoordinationAgentView } from "../contracts.js";
import type {
  CoordinationRun,
  SessionPlanAssignment,
  SessionPlanMode,
  SessionPlanPayload,
  CoordinationArtifact,
  CoordinationEventType,
  CreateSessionRunRequest,
  SessionMessagePayload,
} from "../types.js";
import { SESSION_LIMITS } from "../types.js";
import { FIXED_NOW } from "./controls.js";

/* ------------------------------------------------------------------ *
 * Participants. Array order is the round-robin turn order.
 * ------------------------------------------------------------------ */

export const PARTICIPANT_ONE: CoordinationAgentView = {
  id: "agent-session-one",
  name: "Relay One",
  status: "ready",
};

export const PARTICIPANT_TWO: CoordinationAgentView = {
  id: "agent-session-two",
  name: "Relay Two",
  status: "ready",
};

export const PARTICIPANT_THREE: CoordinationAgentView = {
  id: "agent-session-three",
  name: "Relay Three",
  status: "ready",
};

/** A fourth participant, for round-robin cycles that do not divide evenly. */
export const PARTICIPANT_FOUR: CoordinationAgentView = {
  id: "agent-session-four",
  name: "Relay Four",
  status: "ready",
};

export const SESSION_PARTICIPANTS = [
  PARTICIPANT_ONE,
  PARTICIPANT_TWO,
  PARTICIPANT_THREE,
] as const;

/**
 * A roster of `count` distinct ready participants, for the widened participant
 * bounds (P10-03). The first four reuse the named fixtures so existing
 * transcripts and expectations keep their names.
 */
export const sessionParticipantRoster = (count: number): CoordinationAgentView[] =>
  Array.from({ length: count }, (_unused, index) =>
    index < SESSION_PARTICIPANTS_FOUR.length
      ? { ...SESSION_PARTICIPANTS_FOUR[index]! }
      : {
          id: `agent-session-${index + 1}`,
          name: `Relay ${index + 1}`,
          status: "ready" as const,
        },
  );

export const SESSION_PARTICIPANTS_FOUR = [
  PARTICIPANT_ONE,
  PARTICIPANT_TWO,
  PARTICIPANT_THREE,
  PARTICIPANT_FOUR,
] as const;

/* ------------------------------------------------------------------ *
 * Create requests.
 * ------------------------------------------------------------------ */

/**
 * Turn ceiling for the free-chat fixtures. Deliberately a fixture constant
 * rather than `SESSION_LIMITS.defaultSessionTurns`: the session default is 200
 * (P10-04), and a fixture that expands to 200 committed turns would be neither
 * readable nor fast. Fixtures pin the shape of a short run, not the product
 * default.
 */
export const FREE_CHAT_FIXTURE_TURNS = 6;

export const FREE_CHAT_OBJECTIVE =
  "Agree a three-point launch checklist for the student marketplace.";

export const CREATE_FREE_CHAT_REQUEST: CreateSessionRunRequest = {
  workflow: "shared_session_v1",
  name: "Launch checklist session",
  objective: FREE_CHAT_OBJECTIVE,
  agents: SESSION_PARTICIPANTS.map((agent) => agent.id),
  policy: {
    // Pinned to the deterministic policy this fixture has always described.
    // Phase 14 changed the *default* to "coordinator" (P14-05); every test
    // built on this fixture asserts round-robin or parallel-wave mechanics,
    // which is exactly what "round_robin" continues to name.
    sessionPlanning: "round_robin",
    sessionProtocol: "free_chat",
    maxTurns: FREE_CHAT_FIXTURE_TURNS,
  },
};

/** A free-chat session that plans each round through its first participant. */
export const CREATE_PLANNED_SESSION_REQUEST: CreateSessionRunRequest = {
  ...CREATE_FREE_CHAT_REQUEST,
  name: "Planned session",
  policy: {
    sessionPlanning: "coordinator",
    sessionProtocol: "free_chat",
    maxTurns: FREE_CHAT_FIXTURE_TURNS,
  },
};

/* ------------------------------------------------------------------ *
 * Free-chat payloads and the done signal.
 * ------------------------------------------------------------------ */

export const freeChatPayload = (content: string, done?: boolean): SessionMessagePayload =>
  done === undefined
    ? { schemaVersion: 1, type: "session_message", content }
    : { schemaVersion: 1, type: "session_message", content, done };

/* ------------------------------------------------------------------ *
 * Message-shape fixtures.
 *
 * These pin the shared-session *message* protocol -- size, emptiness, fences,
 * prose, forged provenance -- independently of any protocol rule. They were
 * countdown payloads until P14-07 deleted that protocol; the shapes they test
 * are unchanged, so they were retargeted at free chat rather than deleted.
 * ------------------------------------------------------------------ */

export const EMPTY_CONTENT_OUTPUT = JSON.stringify({
  schemaVersion: 1,
  type: "session_message",
  content: "",
});

export const OVERSIZE_CONTENT_OUTPUT = JSON.stringify({
  schemaVersion: 1,
  type: "session_message",
  content: "x".repeat(SESSION_LIMITS.messageMaxChars + 1),
});

/** Agent-supplied identity is ignored; the backend constructs provenance. */
export const FORGED_PROVENANCE_OUTPUT = JSON.stringify({
  schemaVersion: 1,
  type: "session_message",
  content: "Seller verification first.",
  id: "artifact-forged",
  createdByAgentId: PARTICIPANT_THREE.id,
});

export const FREE_CHAT_TRANSCRIPT: readonly SessionMessagePayload[] = [
  freeChatPayload("Start with seller verification before any listing goes live."),
  freeChatPayload("Add an escrow hold so payment releases only on delivery."),
  freeChatPayload("Third point: a reporting route that a moderator reads daily."),
];

export const VALID_FREE_CHAT_OUTPUT = JSON.stringify(FREE_CHAT_TRANSCRIPT[0]);

export const FENCED_MESSAGE_OUTPUT = `\`\`\`json\n${VALID_FREE_CHAT_OUTPUT}\n\`\`\``;

/** Prose around the JSON: rejected, because the parser never searches prose. */
export const PROSE_MESSAGE_OUTPUT = `Sure! Here you go:\n${VALID_FREE_CHAT_OUTPUT}`;

/**
 * A unanimous round: every participant's latest message carries `done: true`,
 * which is the only state in which the workflow completes a free-chat run
 * before `maxTurns`.
 */
export const UNANIMOUS_DONE_ROUND: readonly SessionMessagePayload[] = [
  freeChatPayload("All three points are covered; nothing outstanding from me.", true),
  freeChatPayload("Agreed, the checklist is complete.", true),
  freeChatPayload("No further additions.", true),
];

/**
 * A partial round: one participant signalled and another has not, so the run
 * must keep going. This is the case that proves an Agent cannot end a run alone.
 */
export const PARTIAL_DONE_ROUND: readonly SessionMessagePayload[] = [
  freeChatPayload("Done from my side.", true),
  freeChatPayload("Not yet -- we have no refund step.", false),
  freeChatPayload("Adding a refund window before we close."),
];

/**
 * A signal withdrawn: the same participant's later message omits `done`, which
 * clears its own earlier signal.
 */
export const WITHDRAWN_DONE_SEQUENCE: readonly SessionMessagePayload[] = [
  freeChatPayload("Looks complete to me.", true),
  freeChatPayload("On reflection, the reporting route needs an owner."),
];

export const DONE_SIGNAL_OUTPUT = JSON.stringify(
  freeChatPayload("All three points are covered; nothing outstanding from me.", true),
);

/* ------------------------------------------------------------------ *
 * Committed artifacts.
 * ------------------------------------------------------------------ */

const sessionArtifact = (
  id: string,
  turnId: string,
  agent: CoordinationAgentView,
  payload: SessionMessagePayload,
): CoordinationArtifact => ({
  id,
  runId: "run-session",
  turnId,
  type: "session_message",
  payload,
  createdByRole: "participant",
  createdByAgentId: agent.id,
  sizeChars: JSON.stringify(payload).length,
  createdAt: FIXED_NOW,
});

/**
 * A stored pre-Phase-14 countdown run, exactly as it sits in an existing JSON
 * database (P14-07).
 *
 * The engine no longer has a countdown protocol, so this shape is no longer
 * constructible through the type: the cast is the point. Deletion applied to
 * the engine, not to the ledger, and this fixture is what proves a stored run
 * still loads, renders, and reads back through the API unchanged.
 */
export const LEGACY_COUNTDOWN_RUN = {
  id: "run-legacy-countdown",
  name: "Test Relay",
  objective: "Count down from 10 to 1 together, one number per turn.",
  requiredSections: [],
  participants: SESSION_PARTICIPANTS.map((agent) => ({
    role: "participant",
    agentId: agent.id,
    agentNameSnapshot: agent.name,
  })),
  policy: {
    workflow: "shared_session_v1",
    maxRevisions: 0,
    maxTurns: 10,
    maxAttemptsPerTurn: 2,
    perAttemptTimeoutMs: 120_000,
    contextMaxChars: 40_000,
    outputMaxChars: 20_000,
    sessionProtocol: "countdown",
    sessionStartValue: 10,
    sessionParallel: false,
    maxParallelTurns: 3,
  },
  status: "completed",
  phase: "done",
  revision: 0,
  nextTurnSequence: 11,
  activeTurnIds: [],
  sharedState: { nextExpectedNumber: 0 },
  version: 21,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
} as unknown as CoordinationRun;

export const FREE_CHAT_ARTIFACT = sessionArtifact(
  "artifact-free-chat-1",
  "turn-free-chat-1",
  PARTICIPANT_ONE,
  freeChatPayload("Start with seller verification before any listing goes live."),
);

export const DONE_SIGNAL_ARTIFACT = sessionArtifact(
  "artifact-free-chat-done",
  "turn-free-chat-4",
  PARTICIPANT_ONE,
  freeChatPayload("All three points are covered; nothing outstanding from me.", true),
);

/* ------------------------------------------------------------------ *
 * Session plans (P14-01).
 * ------------------------------------------------------------------ */

export const planAssignment = (
  agent: CoordinationAgentView,
  position: number,
  instruction = `Contribute step ${position}.`,
): SessionPlanAssignment => ({ agentId: agent.id, position, instruction });

export const planPayload = (
  mode: SessionPlanMode,
  assignments: SessionPlanAssignment[],
): SessionPlanPayload => ({
  schemaVersion: 1,
  type: "session_plan",
  mode,
  assignments,
});

/** Every participant, in roster order, as a plan of the given mode. */
export const fullRosterPlan = (mode: SessionPlanMode): SessionPlanPayload =>
  planPayload(
    mode,
    SESSION_PARTICIPANTS.map((agent, index) => planAssignment(agent, index + 1)),
  );

export const VALID_SEQUENTIAL_PLAN_OUTPUT = JSON.stringify(fullRosterPlan("sequential"));
export const VALID_PARALLEL_PLAN_OUTPUT = JSON.stringify(fullRosterPlan("parallel"));

export const planArtifact = (
  id: string,
  turnId: string,
  agent: CoordinationAgentView,
  payload: SessionPlanPayload,
  transcriptSequence?: number,
): CoordinationArtifact => ({
  id,
  runId: "run-session",
  turnId,
  type: "session_plan",
  payload,
  createdByRole: "participant",
  createdByAgentId: agent.id,
  sizeChars: JSON.stringify(payload).length,
  createdAt: FIXED_NOW,
  ...(transcriptSequence === undefined ? {} : { transcriptSequence }),
});

/* ------------------------------------------------------------------ *
 * Expected event sequences.
 *
 * Every member is an existing frozen `CoordinationEventType`: the session
 * extension adds no event type, so the Phase 4 evidence timeline renders a
 * session run without change.
 * ------------------------------------------------------------------ */

/** One committed turn: schedule, start, commit. */
const COMMITTED_TURN_EVENTS: readonly CoordinationEventType[] = [
  "turn.scheduled",
  "attempt.started",
  "turn.committed",
];

/** A free-chat run that reaches `maxTurns` with no retries. */
export const NORMAL_FREE_CHAT_EVENT_SEQUENCE: readonly CoordinationEventType[] = [
  "run.created",
  "run.started",
  ...Array.from({ length: FREE_CHAT_FIXTURE_TURNS }, () => COMMITTED_TURN_EVENTS).flat(),
  "run.completed",
];

/** A rejected attempt followed by a retry that commits. */
export const INVALID_THEN_RETRY_EVENT_SEQUENCE: readonly CoordinationEventType[] = [
  "turn.scheduled",
  "attempt.started",
  "attempt.invalid_output",
  "attempt.started",
  "turn.committed",
];
