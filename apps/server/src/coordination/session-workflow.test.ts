import { describe, expect, it } from "vitest";
import type { WorkflowView } from "./contracts.js";
import { SharedSessionWorkflowV1 } from "./session-workflow.js";
import {
  PARTICIPANT_ONE,
  PARTICIPANT_TWO,
  SESSION_PARTICIPANTS,
  countdownPayload,
  freeChatPayload,
} from "./testing/session-fixtures.js";
import type {
  CoordinationArtifact,
  CoordinationRun,
  CoordinationTurn,
  SessionMessagePayload,
} from "./types.js";
import { DEFAULT_COORDINATION_POLICY } from "./types.js";

const now = "2026-08-30T00:00:00.000Z";

const sessionRun = (
  protocol: "countdown" | "free_chat",
  overrides: Partial<CoordinationRun> = {},
): CoordinationRun => ({
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
    maxTurns: protocol === "countdown" ? 3 : 6,
    ...(protocol === "countdown" ? { sessionStartValue: 3 } : {}),
  },
  status: "running",
  phase: "sessioning",
  revision: 0,
  nextTurnSequence: 1,
  ...(protocol === "countdown" ? { sharedState: { nextExpectedNumber: 3 } } : {}),
  version: 1,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const committedView = (
  protocol: "countdown" | "free_chat",
  payloads: readonly SessionMessagePayload[],
): WorkflowView => {
  const artifacts: CoordinationArtifact[] = payloads.map((payload, index) => ({
    id: `artifact-${index + 1}`,
    runId: "run-session",
    turnId: `turn-${index + 1}`,
    type: "session_message",
    payload,
    createdByRole: "participant",
    createdByAgentId: SESSION_PARTICIPANTS[index % SESSION_PARTICIPANTS.length]!.id,
    sizeChars: payload.content.length,
    createdAt: now,
  }));
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
    run: sessionRun(protocol, {
      nextTurnSequence: payloads.length + 1,
      ...(protocol === "countdown"
        ? { sharedState: { nextExpectedNumber: 3 - payloads.length } }
        : {}),
    }),
    turns,
    artifacts,
  };
};

describe("SharedSessionWorkflowV1 P6-01 routing", () => {
  const workflow = new SharedSessionWorkflowV1();

  it("selects the next participant from committed turn count and exposes the transcript", () => {
    expect(workflow.decideNext(committedView("countdown", [countdownPayload(3)]))).toEqual({
      kind: "schedule",
      role: "participant",
      agentId: PARTICIPANT_TWO.id,
      turnKind: "session_turn",
      phase: "sessioning",
      revision: 0,
      inputArtifactIds: ["artifact-1"],
      expectedArtifactType: "session_message",
    });
  });

  it("completes countdown at one with the last message as final artifact", () => {
    expect(
      workflow.decideNext(
        committedView("countdown", [countdownPayload(3), countdownPayload(2), countdownPayload(1)]),
      ),
    ).toEqual({ kind: "complete", finalArtifactId: "artifact-3" });
  });

  it("completes free chat only after every participant's latest signal is done", () => {
    const partial = committedView("free_chat", [
      freeChatPayload("Ready", true),
      freeChatPayload("Ready", true),
      freeChatPayload("Still working"),
    ]);
    expect(workflow.decideNext(partial)).toMatchObject({
      kind: "schedule",
      agentId: PARTICIPANT_ONE.id,
    });

    const unanimous = committedView("free_chat", [
      freeChatPayload("Ready", true),
      freeChatPayload("Ready", true),
      freeChatPayload("Ready", true),
    ]);
    expect(workflow.decideNext(unanimous)).toEqual({
      kind: "complete",
      finalArtifactId: "artifact-3",
    });
  });

  it("fails safely when countdown shared state disagrees with the transcript", () => {
    const view = committedView("countdown", [countdownPayload(3)]);
    view.run.sharedState = { nextExpectedNumber: 1 };
    expect(workflow.decideNext(view)).toMatchObject({
      kind: "fail",
      code: "INVALID_STATE",
    });
  });
});
