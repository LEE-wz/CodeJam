import { describe, expect, it } from "vitest";
import type { WorkflowView } from "./contracts.js";
import { CoordinationWorkflowDispatchV1 } from "./service.js";
import { SharedSessionWorkflowV1 } from "./session-workflow.js";
import { FakeWorkflow } from "./testing/fakes.js";
import {
  PARTICIPANT_FOUR,
  PARTICIPANT_ONE,
  PARTICIPANT_THREE,
  PARTICIPANT_TWO,
  freeChatPayload,
} from "./testing/session-fixtures.js";
import type {
  CoordinationArtifact,
  CoordinationParticipant,
  CoordinationRun,
  CoordinationTurn,
  SessionMessagePayload,
} from "./types.js";
import { DEFAULT_COORDINATION_POLICY } from "./types.js";

const now = "2026-08-30T00:00:00.000Z";
const agents = [PARTICIPANT_ONE, PARTICIPANT_TWO, PARTICIPANT_THREE, PARTICIPANT_FOUR];

const participants = (count = 3): CoordinationParticipant[] =>
  agents.slice(0, count).map((agent) => ({
    role: "participant",
    agentId: agent.id,
    agentNameSnapshot: agent.name,
  }));

const sessionRun = (
  overrides: Partial<CoordinationRun> = {},
): CoordinationRun => ({
  id: "run-session",
  name: "Session",
  objective: "Work together",
  requiredSections: [],
  participants: participants(),
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
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const committedView = (
  payloads: readonly SessionMessagePayload[],
  options: {
    participantCount?: number;
    maxTurns?: number;
  } = {},
): WorkflowView => {
  const runParticipants = participants(options.participantCount);
  const artifacts: CoordinationArtifact[] = payloads.map((payload, index) => ({
    id: `artifact-${index + 1}`,
    runId: "run-session",
    turnId: `turn-${index + 1}`,
    type: "session_message",
    payload,
    createdByRole: "participant",
    createdByAgentId: runParticipants[index % runParticipants.length]!.agentId,
    transcriptSequence: index + 2,
    sizeChars: payload.content.length,
    createdAt: now,
  }));
  const userArtifact: CoordinationArtifact = {
    id: "user-artifact-1",
    runId: "run-session",
    type: "user_message",
    payload: { schemaVersion: 1, type: "user_message", content: "Help with this request" },
    createdBy: { kind: "user" },
    transcriptSequence: 1,
    sizeChars: 22,
    createdAt: now,
  };
  const turns: CoordinationTurn[] = artifacts.map((artifact, index) => ({
    id: artifact.turnId,
    runId: artifact.runId,
    sequence: index + 1,
    role: "participant",
    agentId: artifact.createdByAgentId,
    kind: "session_turn",
    status: "committed",
    attemptCount: 1,
    inputArtifactIds: artifacts.slice(0, index).map(({ id }) => id),
    outputArtifactId: artifact.id,
    lastValidationErrors: [],
    createdAt: now,
    completedAt: now,
  }));
  return {
    run: sessionRun({
      participants: runParticipants,
      nextTurnSequence: payloads.length + 1,
      policy: {
        ...DEFAULT_COORDINATION_POLICY,
        workflow: "shared_session_v1",
        sessionProtocol: "free_chat",
        maxTurns: options.maxTurns ?? 6,
      },
      lastUserArtifactId: userArtifact.id,
    }),
    turns,
    artifacts: [userArtifact, ...artifacts],
  };
};

describe("SharedSessionWorkflowV1 routing decision table", () => {
  const workflow = new SharedSessionWorkflowV1();

  for (const participantCount of [2, 3, 4]) {
    it(`cycles deterministically over ${participantCount} participants`, () => {
      const payloads = Array.from({ length: participantCount + 1 }, (_unused, index) =>
        freeChatPayload(`Contribution ${index + 1}`),
      );
      const view = committedView(payloads, { participantCount });
      const expected = participants(participantCount)[payloads.length % participantCount]!;
      const first = workflow.decideNext(view);
      const second = workflow.decideNext({
        ...view,
        turns: [...view.turns].reverse(),
        artifacts: [...view.artifacts].reverse(),
      });
      expect(first).toMatchObject({ kind: "schedule", agentId: expected.agentId });
      expect(second).toEqual(first);
      if (first.kind === "schedule") {
        // A free-chat round is driven by a user message, so the transcript the
        // next participant reads opens with it.
        expect(first.inputArtifactIds).toEqual([
          "user-artifact-1",
          ...payloads.map((_payload, index) => `artifact-${index + 1}`),
        ]);
      }
    });
  }

  it("awaits another prompt after a unanimous latest done wave", () => {
    const view = committedView([
      freeChatPayload("Ready", true),
      freeChatPayload("Ready", true),
      freeChatPayload("Ready", true),
    ]);
    expect(workflow.decideNext(view)).toEqual({ kind: "await_input" });
  });

  it("continues for partial signals and cannot complete before every participant speaks", () => {
    const view = committedView([
      freeChatPayload("Ready", true),
      freeChatPayload("Ready", true),
    ]);
    expect(workflow.decideNext(view)).toMatchObject({
      kind: "schedule",
      agentId: PARTICIPANT_THREE.id,
    });
  });

  it("returns one deterministic wave for every participant missing the active prompt", () => {
    const view = committedView([]);
    view.run.policy.sessionParallel = true;
    view.run.activeTurnIds = ["turn-other-wave"];

    const decision = workflow.decideNext(view);
    expect(decision).toMatchObject({ kind: "schedule_wave" });
    if (decision.kind !== "schedule_wave") return;
    expect(decision.turns.map(({ agentId }) => agentId)).toEqual([
      PARTICIPANT_ONE.id,
      PARTICIPANT_TWO.id,
      PARTICIPANT_THREE.id,
    ]);
    expect(new Set(decision.turns.map(({ agentId }) => agentId)).size).toBe(3);
  });

  it("accepts parallel committed history without a strict round-robin turn order", () => {
    const view = committedView([
      freeChatPayload("Planner response"),
      freeChatPayload("Finaliser response"),
    ]);
    view.run.policy.sessionParallel = true;
    view.turns[1]!.agentId = PARTICIPANT_THREE.id;
    const finaliserArtifact = view.artifacts.find(({ id }) => id === "artifact-2");
    if (!finaliserArtifact || finaliserArtifact.type !== "session_message") {
      throw new Error("expected second session artifact");
    }
    finaliserArtifact.createdByAgentId = PARTICIPANT_THREE.id;

    expect(workflow.decideNext(view)).toMatchObject({
      kind: "schedule",
      agentId: PARTICIPANT_TWO.id,
    });
  });

  it.each([
    {
      label: "a foreign turn",
      corrupt: (view: WorkflowView) => {
        view.turns.push({ ...view.turns[0]!, id: "turn-foreign", runId: "other-run", sequence: 9 });
      },
    },
    {
      label: "an unknown participant",
      corrupt: (view: WorkflowView) => {
        view.turns[0]!.agentId = "unknown-agent";
      },
    },
    {
      label: "a duplicate turn identity",
      corrupt: (view: WorkflowView) => {
        view.turns.push({ ...view.turns[0]! });
      },
    },
    {
      label: "an artifact without a committed turn",
      corrupt: (view: WorkflowView) => {
        view.artifacts.push({ ...view.artifacts[1]!, id: "artifact-uncommitted", turnId: "missing-turn" });
      },
    },
  ])("rejects $label in a parallel session view", ({ corrupt }) => {
    const view = committedView([freeChatPayload("One")]);
    view.run.policy.sessionParallel = true;
    corrupt(view);
    expect(workflow.decideNext(view)).toMatchObject({ kind: "fail", code: "INVALID_STATE" });
  });

  it("treats a later omitted done flag as a withdrawn signal", () => {
    const view = committedView([
      freeChatPayload("Ready", true),
      freeChatPayload("Ready", true),
      freeChatPayload("Ready", true),
      freeChatPayload("Actually, one concern remains"),
    ]);
    expect(workflow.decideNext(view)).toMatchObject({
      kind: "schedule",
      agentId: PARTICIPANT_TWO.id,
    });
  });

  it("fails free chat at the hard maxTurns ceiling", () => {
    const view = committedView([
      freeChatPayload("One"),
      freeChatPayload("Two"),
      freeChatPayload("Three"),
    ], { maxTurns: 3 });
    expect(workflow.decideNext(view)).toMatchObject({
      kind: "fail",
      code: "MAX_TURNS_EXCEEDED",
    });
  });

  it("rejects non-session artifacts in a session run", () => {
    const view = committedView([freeChatPayload("One")]);
    view.artifacts.push({
      ...view.artifacts[0]!,
      id: "artifact-proposal",
      type: "proposal",
      payload: {
        schemaVersion: 1,
        type: "proposal",
        summary: "Unexpected",
        sections: [{ key: "x", title: "X", content: "X" }],
      },
    });
    expect(workflow.decideNext(view)).toMatchObject({ kind: "fail", code: "INVALID_STATE" });
  });
});

describe("CoordinationWorkflowDispatchV1", () => {
  it("selects the decision source solely from the durable workflow id", () => {
    const verified = new FakeWorkflow();
    const session = new SharedSessionWorkflowV1();
    const dispatch = new CoordinationWorkflowDispatchV1(verified, session);
    expect(dispatch.forRun(sessionRun())).toBe(session);
    expect(dispatch.forRun({
      ...sessionRun(),
      policy: { ...DEFAULT_COORDINATION_POLICY },
    })).toBe(verified);
  });

  it("fails loudly when a session workflow is not registered", () => {
    const dispatch = new CoordinationWorkflowDispatchV1(new FakeWorkflow());
    expect(() => dispatch.forRun(sessionRun())).toThrow(
      "Shared session workflow is not registered",
    );
  });
});
