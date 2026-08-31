/**
 * Phase 5 session contract proof (P5-07).
 *
 * Deliberately narrow: this asserts that the additive session contracts compile,
 * that `CoordinationService` accepts both workflows in its dispatch, and that a
 * session create initialises the durable shape the later phases depend on. It
 * asserts no session *behaviour* -- routing, countdown validation, transcript
 * context and the free-chat completion rule are Phase 6 (P6-01 onwards).
 */
import { describe, expect, it } from "vitest";
import { CoordinationService } from "./service.js";
import { SharedSessionWorkflowV1 } from "./session-workflow.js";
import { DeterministicIdGenerator, FIXED_NOW, FixedClock } from "./testing/controls.js";
import {
  FakeAgentDirectory,
  FakeArtifactProtocol,
  FakeContextBuilder,
  FakeCoordinationRepository,
  FakeWorkflow,
  ScriptedCoordinationRuntime,
} from "./testing/fakes.js";
import { InMemoryCoordinationRepository } from "./testing/memory-repository.js";
import { CREATE_RUN_REQUEST } from "./testing/fixtures.js";
import {
  CREATE_COUNTDOWN_REQUEST,
  CREATE_FREE_CHAT_REQUEST,
  PARTIAL_DONE_ROUND,
  PARTICIPANT_ONE,
  SESSION_PARTICIPANTS,
  SESSION_START_VALUE,
  UNANIMOUS_DONE_ROUND,
  sessionParticipantRoster,
  WITHDRAWN_DONE_SEQUENCE,
  countdownPayload,
} from "./testing/session-fixtures.js";
import { DEFAULT_COORDINATION_POLICY, SESSION_LIMITS } from "./types.js";

const buildServiceWith = (agents: readonly { id: string; name: string; status: "ready" }[]) =>
  new CoordinationService({
    agentDirectory: new FakeAgentDirectory(agents.map((agent) => ({ ...agent }))),
    repository: new InMemoryCoordinationRepository(new FixedClock()),
    workflow: new FakeWorkflow(),
    sessionWorkflow: new SharedSessionWorkflowV1(),
    contextBuilder: new FakeContextBuilder(),
    artifactProtocol: new FakeArtifactProtocol(),
    runtime: new ScriptedCoordinationRuntime(),
    clock: new FixedClock(),
    ids: new DeterministicIdGenerator(),
  });

const buildService = () => buildServiceWith(SESSION_PARTICIPANTS);

describe("Phase 5 session contracts", () => {
  it("constructs CoordinationService with both workflows registered", () => {
    expect(buildService()).toBeInstanceOf(CoordinationService);
  });

  it("still constructs without a session workflow, so existing compositions are unchanged", () => {
    const service = new CoordinationService({
      agentDirectory: new FakeAgentDirectory(),
      repository: new FakeCoordinationRepository(),
      workflow: new FakeWorkflow(),
      contextBuilder: new FakeContextBuilder(),
      artifactProtocol: new FakeArtifactProtocol(),
      runtime: new ScriptedCoordinationRuntime(),
      clock: new FixedClock(),
      ids: new DeterministicIdGenerator(),
    });
    expect(service).toBeInstanceOf(CoordinationService);
  });
});

describe("Phase 5 session create", () => {
  it("initialises a countdown run with shared state from sessionStartValue", async () => {
    const run = await buildService().createRun(CREATE_COUNTDOWN_REQUEST);

    expect(run.status).toBe("created");
    expect(run.phase).toBe("sessioning");
    expect(run.policy.workflow).toBe("shared_session_v1");
    expect(run.policy.sessionProtocol).toBe("countdown");
    expect(run.policy.sessionStartValue).toBe(SESSION_START_VALUE);
    expect(run.sharedState).toEqual({ nextExpectedNumber: SESSION_START_VALUE });
    expect(run.revision).toBe(0);
    expect(run.requiredSections).toEqual([]);
  });

  it("preserves selection order as the round-robin turn order", async () => {
    const run = await buildService().createRun(CREATE_COUNTDOWN_REQUEST);

    expect(run.participants.map((participant) => participant.agentId)).toEqual(
      SESSION_PARTICIPANTS.map((agent) => agent.id),
    );
    expect(run.participants.map((participant) => participant.role)).toEqual([
      "participant",
      "participant",
      "participant",
    ]);
    expect(run.participants.map((participant) => participant.agentNameSnapshot)).toEqual(
      SESSION_PARTICIPANTS.map((agent) => agent.name),
    );
  });

  it("initialises a free-chat run with no shared state and the default turn limit", async () => {
    // The fixture pins its own short ceiling, so the default is asserted from a
    // request that omits maxTurns entirely (P10-04).
    const run = await buildService().createRun({
      ...CREATE_FREE_CHAT_REQUEST,
      policy: { sessionProtocol: "free_chat" },
    });

    expect(run.policy.sessionProtocol).toBe("free_chat");
    expect(run.policy.sessionStartValue).toBeUndefined();
    expect(run.sharedState).toBeUndefined();
    expect(run.policy.maxTurns).toBe(SESSION_LIMITS.defaultSessionTurns);
  });

  it("rejects a participant list outside the frozen bounds", async () => {
    await expect(
      buildService().createRun({
        ...CREATE_COUNTDOWN_REQUEST,
        agents: [SESSION_PARTICIPANTS[0].id],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  // P10-03: the widened participant range, asserted at both boundaries and one
  // past the ceiling. The service reads SESSION_LIMITS rather than its own
  // literals, so these cases also prove there is a single source of truth.
  it.each([SESSION_LIMITS.minParticipants, SESSION_LIMITS.maxParticipants])(
    "accepts a session with %i participants",
    async (count) => {
      const roster = sessionParticipantRoster(count);
      const run = await buildServiceWith(roster).createRun({
        ...CREATE_FREE_CHAT_REQUEST,
        agents: roster.map((agent) => agent.id),
        policy: { sessionProtocol: "free_chat" },
      });
      expect(run.participants).toHaveLength(count);
      expect(run.participants.map(({ agentId }) => agentId)).toEqual(
        roster.map((agent) => agent.id),
      );
    },
  );

  it("rejects a session with more than the maximum participants", async () => {
    const roster = sessionParticipantRoster(SESSION_LIMITS.maxParticipants + 1);
    await expect(
      buildServiceWith(roster).createRun({
        ...CREATE_FREE_CHAT_REQUEST,
        agents: roster.map((agent) => agent.id),
        policy: { sessionProtocol: "free_chat" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects duplicate participants", async () => {
    await expect(
      buildService().createRun({
        ...CREATE_COUNTDOWN_REQUEST,
        agents: [SESSION_PARTICIPANTS[0].id, SESSION_PARTICIPANTS[0].id],
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_AGENT" });
  });

  it("rejects an unknown participant", async () => {
    await expect(
      buildService().createRun({
        ...CREATE_COUNTDOWN_REQUEST,
        agents: [SESSION_PARTICIPANTS[0].id, "agent-missing"],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("leaves verified-handoff create unchanged", async () => {
    const service = new CoordinationService({
      agentDirectory: new FakeAgentDirectory(),
      repository: new InMemoryCoordinationRepository(new FixedClock()),
      workflow: new FakeWorkflow(),
      sessionWorkflow: new SharedSessionWorkflowV1(),
      contextBuilder: new FakeContextBuilder(),
      artifactProtocol: new FakeArtifactProtocol(),
      runtime: new ScriptedCoordinationRuntime(),
      clock: new FixedClock(),
      ids: new DeterministicIdGenerator(),
    });

    const run = await service.createRun(CREATE_RUN_REQUEST);

    expect(run.policy.workflow).toBe("verified_handoff_v1");
    expect(run.phase).toBe("drafting");
    expect(run.sharedState).toBeUndefined();
    expect(run.participants.map((participant) => participant.role)).toEqual([
      "planner",
      "critic",
      "finalizer",
    ]);
  });
});

describe("Phase 5 session message payload", () => {
  it("omits done on a countdown message", () => {
    expect(countdownPayload(10)).toEqual({
      schemaVersion: 1,
      type: "session_message",
      content: "10",
    });
  });

  it("carries done on every message of a unanimous round", () => {
    expect(UNANIMOUS_DONE_ROUND.every((message) => message.done === true)).toBe(true);
    expect(UNANIMOUS_DONE_ROUND).toHaveLength(SESSION_PARTICIPANTS.length);
  });

  it("models a partial round where at least one participant has not signalled", () => {
    expect(PARTIAL_DONE_ROUND.some((message) => message.done !== true)).toBe(true);
  });

  it("models a signal withdrawn by a later message from the same participant", () => {
    expect(WITHDRAWN_DONE_SEQUENCE[0]?.done).toBe(true);
    expect(WITHDRAWN_DONE_SEQUENCE[1]?.done).toBeUndefined();
  });

  it("bounds message content by the frozen session limits", () => {
    expect(SESSION_LIMITS.messageMinChars).toBe(1);
    expect(SESSION_LIMITS.messageMaxChars).toBe(500);
    expect(SESSION_LIMITS.minParticipants).toBe(2);
    expect(SESSION_LIMITS.maxParticipants).toBe(10);
    expect(SESSION_LIMITS.minSessionTurns).toBe(3);
    expect(SESSION_LIMITS.maxSessionTurns).toBe(100_000);
    expect(SESSION_LIMITS.defaultSessionTurns).toBe(200);
  });
});

describe("shared session workflow registration", () => {
  it("routes a valid new countdown run to the first participant", () => {
    const workflow = new SharedSessionWorkflowV1();

    expect(workflow.decideNext({
      run: {
        id: "run-session-contract",
        name: CREATE_COUNTDOWN_REQUEST.name,
        objective: CREATE_COUNTDOWN_REQUEST.objective,
        requiredSections: [],
        participants: SESSION_PARTICIPANTS.map((agent) => ({
          role: "participant" as const,
          agentId: agent.id,
          agentNameSnapshot: agent.name,
        })),
        policy: {
          ...DEFAULT_COORDINATION_POLICY,
          workflow: "shared_session_v1",
          sessionProtocol: "countdown",
          sessionStartValue: SESSION_START_VALUE,
          maxTurns: SESSION_START_VALUE,
        },
        status: "running",
        phase: "sessioning",
        revision: 0,
        nextTurnSequence: 1,
        activeTurnIds: [],
        sharedState: { nextExpectedNumber: SESSION_START_VALUE },
        version: 1,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
      turns: [],
      artifacts: [],
    })).toMatchObject({
      kind: "schedule",
      role: "participant",
      agentId: PARTICIPANT_ONE.id,
      turnKind: "session_turn",
      expectedArtifactType: "session_message",
    });
  });
});
