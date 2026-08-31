import { describe, expect, it } from "vitest";
import type { WorkflowView } from "./contracts.js";
import { CoordinationWorkflowDispatchV1 } from "./service.js";
import {
  buildSessionBidWaveDecision,
  SharedSessionWorkflowV1,
} from "./session-workflow.js";
import { FakeWorkflow } from "./testing/fakes.js";
import {
  PARTICIPANT_FOUR,
  PARTICIPANT_ONE,
  PARTICIPANT_THREE,
  PARTICIPANT_TWO,
  countdownPayload,
  freeChatPayload,
} from "./testing/session-fixtures.js";
import type {
  CoordinationArtifact,
  CoordinationParticipant,
  CoordinationRun,
  CoordinationTurn,
  SessionMessagePayload,
} from "./types.js";
import {
  DEFAULT_COORDINATION_POLICY,
  DEFAULT_SESSION_AUCTION_POLICY,
} from "./types.js";

const now = "2026-08-30T00:00:00.000Z";
const agents = [PARTICIPANT_ONE, PARTICIPANT_TWO, PARTICIPANT_THREE, PARTICIPANT_FOUR];

const participants = (count = 3): CoordinationParticipant[] =>
  agents.slice(0, count).map((agent) => ({
    role: "participant",
    agentId: agent.id,
    agentNameSnapshot: agent.name,
  }));

const sessionRun = (
  protocol: "countdown" | "free_chat",
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
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const committedView = (
  protocol: "countdown" | "free_chat",
  payloads: readonly SessionMessagePayload[],
  options: {
    participantCount?: number;
    maxTurns?: number;
    startValue?: number;
  } = {},
): WorkflowView => {
  const runParticipants = participants(options.participantCount);
  const startValue = options.startValue ?? 10;
  const artifacts: CoordinationArtifact[] = payloads.map((payload, index) => ({
    id: `artifact-${index + 1}`,
    runId: "run-session",
    turnId: `turn-${index + 1}`,
    type: "session_message",
    payload,
    createdByRole: "participant",
    createdByAgentId: runParticipants[index % runParticipants.length]!.agentId,
    transcriptSequence: protocol === "free_chat" ? index + 2 : index + 1,
    sizeChars: payload.content.length,
    createdAt: now,
  }));
  const userArtifact: CoordinationArtifact | undefined = protocol === "free_chat"
    ? {
        id: "user-artifact-1",
        runId: "run-session",
        type: "user_message",
        payload: { schemaVersion: 1, type: "user_message", content: "Help with this request" },
        createdBy: { kind: "user" },
        transcriptSequence: 1,
        sizeChars: 22,
        createdAt: now,
      }
    : undefined;
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
      participants: runParticipants,
      nextTurnSequence: payloads.length + 1,
      activeTurnIds: [],
      policy: {
        ...DEFAULT_COORDINATION_POLICY,
        workflow: "shared_session_v1",
        sessionProtocol: protocol,
        maxTurns: options.maxTurns ?? (protocol === "countdown" ? startValue : 6),
        ...(protocol === "countdown" ? { sessionStartValue: startValue } : {}),
      },
      ...(protocol === "countdown"
        ? { sharedState: { nextExpectedNumber: startValue - payloads.length } }
        : { lastUserArtifactId: userArtifact!.id }),
    }),
    turns,
    artifacts: userArtifact ? [userArtifact, ...artifacts] : artifacts,
  };
};

const countdown = (start: number, count: number): SessionMessagePayload[] =>
  Array.from({ length: count }, (_unused, index) => countdownPayload(start - index));

describe("SharedSessionWorkflowV1 routing decision table", () => {
  const workflow = new SharedSessionWorkflowV1();

  for (const participantCount of [2, 3, 4]) {
    it(`cycles deterministically over ${participantCount} participants`, () => {
      const payloads = countdown(10, participantCount + 1);
      const view = committedView("countdown", payloads, { participantCount });
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
        expect(first.inputArtifactIds).toEqual(payloads.map((_payload, index) => `artifact-${index + 1}`));
      }
    });
  }

  it("completes countdown at one with the last message as final artifact", () => {
    expect(workflow.decideNext(committedView("countdown", countdown(3, 3), { startValue: 3 })))
      .toEqual({ kind: "complete", finalArtifactId: "artifact-3" });
  });

  it("fails countdown when scheduling would exceed maxTurns", () => {
    expect(
      workflow.decideNext(committedView("countdown", countdown(4, 3), {
        startValue: 4,
        maxTurns: 3,
      })),
    ).toMatchObject({ kind: "fail", code: "MAX_TURNS_EXCEEDED" });
  });

  it("awaits another prompt after a unanimous latest done wave", () => {
    const view = committedView("free_chat", [
      freeChatPayload("Ready", true),
      freeChatPayload("Ready", true),
      freeChatPayload("Ready", true),
    ]);
    expect(workflow.decideNext(view)).toEqual({ kind: "await_input" });
  });

  it("continues for partial signals and cannot complete before every participant speaks", () => {
    const view = committedView("free_chat", [
      freeChatPayload("Ready", true),
      freeChatPayload("Ready", true),
    ]);
    expect(workflow.decideNext(view)).toMatchObject({
      kind: "schedule",
      agentId: PARTICIPANT_THREE.id,
    });
  });

  it("treats a later omitted done flag as a withdrawn signal", () => {
    const view = committedView("free_chat", [
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
    const view = committedView("free_chat", [
      freeChatPayload("One"),
      freeChatPayload("Two"),
      freeChatPayload("Three"),
    ], { maxTurns: 3 });
    expect(workflow.decideNext(view)).toMatchObject({
      kind: "fail",
      code: "MAX_TURNS_EXCEEDED",
    });
  });

  it("routes explicit direct mode to exactly one ordinary execution turn", () => {
    const view = committedView("free_chat", [], { participantCount: 3 });
    view.run.participants = view.run.participants.map((participant, index) => ({
      ...participant,
      ...(index === 1
        ? {
            specializationSnapshot: {
              perspective: "Security reviewer",
              focusAreas: ["security"],
              biddingInstructions: "Prefer concrete mitigations.",
            },
          }
        : {}),
    }));
    view.run.policy = {
      ...view.run.policy,
      auctionPolicy: {
        ...DEFAULT_SESSION_AUCTION_POLICY,
        routingMode: "direct",
      },
    };
    const user = view.artifacts.find(({ type }) => type === "user_message");
    if (!user || user.type !== "user_message") throw new Error("Missing user fixture");
    user.payload = { ...user.payload, content: "Please perform a security review" };

    expect(workflow.decideNext(view)).toEqual({
      kind: "schedule",
      role: "participant",
      agentId: PARTICIPANT_TWO.id,
      turnKind: "session_turn",
      phase: "sessioning",
      revision: 0,
      inputArtifactIds: [user.id],
      expectedArtifactType: "session_message",
    });
  });

  it("schedules one atomic bid opportunity for every explicit-auction participant", () => {
    const view = committedView("free_chat", [], { participantCount: 3 });
    view.run.policy = {
      ...view.run.policy,
      maxTurns: 10,
      auctionPolicy: {
        ...DEFAULT_SESSION_AUCTION_POLICY,
        routingMode: "auction",
      },
    };
    const userId = view.run.lastUserArtifactId!;

    expect(workflow.decideNext(view)).toEqual({
      kind: "schedule_wave",
      wavePurpose: "session_bidding",
      phase: "sessioning",
      revision: 0,
      members: participants(3).map(({ agentId }) => ({
        role: "participant",
        agentId,
        turnKind: "session_bid",
        inputArtifactIds: [userId],
        expectedArtifactType: "session_bid",
      })),
    });
  });

  it("builds an Auto escalation wave from only participants without a prior bid", () => {
    const decision = buildSessionBidWaveDecision({
      participants: participants(3),
      inputArtifactIds: ["user-artifact-1"],
      priorBidAgentIds: new Set([PARTICIPANT_ONE.id]),
    });
    expect(decision.members.map(({ agentId }) => agentId)).toEqual([
      PARTICIPANT_TWO.id,
      PARTICIPANT_THREE.id,
    ]);
    expect(decision.members.every(
      ({ turnKind, expectedArtifactType }) =>
        turnKind === "session_bid" && expectedArtifactType === "session_bid",
    )).toBe(true);
  });

  it("never creates a second bid opportunity for the same user-message round", () => {
    const view = committedView("free_chat", [], { participantCount: 3 });
    const userId = view.run.lastUserArtifactId!;
    view.run.policy = {
      ...view.run.policy,
      maxTurns: 10,
      auctionPolicy: {
        ...DEFAULT_SESSION_AUCTION_POLICY,
        routingMode: "auction",
      },
    };
    view.turns = participants(3).map(({ agentId }, index) => ({
      id: `bid-turn-${index + 1}`,
      runId: view.run.id,
      sequence: index + 1,
      role: "participant",
      agentId,
      kind: "session_bid",
      wavePurpose: "session_bidding",
      status: "failed",
      attemptCount: DEFAULT_SESSION_AUCTION_POLICY.maxBidAttempts,
      inputArtifactIds: [userId],
      lastValidationErrors: [],
      createdAt: now,
      completedAt: now,
    }));
    view.run.nextTurnSequence = 4;

    expect(workflow.decideNext(view)).toMatchObject({
      kind: "fail",
      code: "INVALID_STATE",
      message: "Settled bids require the PA14 award decision",
    });
  });

  it("keeps auto routing fail-closed until the primary-candidate phase", () => {
    const view = committedView("free_chat", []);
    view.run.policy = {
      ...view.run.policy,
      auctionPolicy: DEFAULT_SESSION_AUCTION_POLICY,
    };
    expect(workflow.decideNext(view)).toMatchObject({
      kind: "fail",
      code: "INVALID_STATE",
      message: "Auto routing requires the PA14 primary-candidate implementation",
    });
  });

  it.each([
    ["missing", undefined],
    ["non-integer", { nextExpectedNumber: 2.5 }],
    ["inconsistent", { nextExpectedNumber: 1 }],
  ])("fails safely for %s countdown shared state", (_name, sharedState) => {
    const view = committedView("countdown", countdown(3, 1), { startValue: 3 });
    view.run.sharedState = sharedState;
    expect(workflow.decideNext(view)).toMatchObject({ kind: "fail", code: "INVALID_STATE" });
  });

  it("rejects non-session artifacts in a session run", () => {
    const view = committedView("free_chat", [freeChatPayload("One")]);
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
    expect(dispatch.forRun(sessionRun("countdown"))).toBe(session);
    expect(dispatch.forRun({
      ...sessionRun("countdown"),
      policy: { ...DEFAULT_COORDINATION_POLICY },
    })).toBe(verified);
  });

  it("fails loudly when a session workflow is not registered", () => {
    const dispatch = new CoordinationWorkflowDispatchV1(new FakeWorkflow());
    expect(() => dispatch.forRun(sessionRun("countdown"))).toThrow(
      "Shared session workflow is not registered",
    );
  });
});
