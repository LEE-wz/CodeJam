import type { SharedSessionWorkflow, WorkflowDecision, WorkflowView } from "./contracts.js";
import type {
  CoordinationArtifact,
  CoordinationArtifactId,
  CoordinationParticipant,
} from "./types.js";
import { SESSION_LIMITS } from "./types.js";

export type { SharedSessionWorkflow } from "./contracts.js";

type SessionArtifact = Extract<CoordinationArtifact, { type: "session_message" }>;
type UserArtifact = Extract<CoordinationArtifact, { type: "user_message" }>;

const invalidState = (message: string): WorkflowDecision => ({
  kind: "fail",
  code: "INVALID_STATE",
  message,
});

const isPositiveInteger = (value: number): boolean =>
  Number.isInteger(value) && value > 0;

interface ValidSessionView {
  participants: CoordinationParticipant[];
  committedArtifacts: SessionArtifact[];
  transcriptArtifacts: Array<SessionArtifact | UserArtifact>;
}

const validateSessionView = (
  view: WorkflowView,
): ValidSessionView | WorkflowDecision => {
  const { run } = view;
  if (run.policy.workflow !== "shared_session_v1") {
    return invalidState("Shared session workflow requires a shared-session run");
  }
  if (
    (run.status !== "running" && run.status !== "awaiting_input") ||
    run.phase !== "sessioning"
  ) {
    return invalidState("Session decisions require a live session run");
  }
  if (run.activeTurnId) {
    return invalidState("Session workflow cannot schedule while a turn is active");
  }
  if (!isPositiveInteger(run.nextTurnSequence) || run.revision !== 0) {
    return invalidState("Session run has invalid sequence or revision state");
  }
  if (
    !isPositiveInteger(run.policy.maxTurns) ||
    (run.policy.sessionProtocol !== "countdown" &&
      run.policy.sessionProtocol !== "free_chat")
  ) {
    return invalidState("Session run has an invalid policy");
  }

  const participants = run.participants;
  const participantIds = new Set(participants.map(({ agentId }) => agentId));
  if (
    participants.length < SESSION_LIMITS.minParticipants ||
    participants.length > SESSION_LIMITS.maxParticipants ||
    participantIds.size !== participants.length ||
    participants.some(({ role }) => role !== "participant")
  ) {
    return invalidState("Session run has invalid participants");
  }

  const turns = view.turns.filter(({ runId }) => runId === run.id);
  const artifacts = view.artifacts.filter(({ runId }) => runId === run.id);
  if (artifacts.some(({ type }) => type !== "session_message" && type !== "user_message")) {
    return invalidState("Session run contains a non-session artifact");
  }

  const turnIds = new Set<string>();
  const sequences = new Set<number>();
  for (const turn of turns) {
    if (
      turnIds.has(turn.id) ||
      sequences.has(turn.sequence) ||
      !isPositiveInteger(turn.sequence) ||
      turn.sequence >= run.nextTurnSequence ||
      turn.kind !== "session_turn" ||
      turn.role !== "participant" ||
      !["committed", "cancelled", "failed"].includes(turn.status)
    ) {
      return invalidState("Session run contains an invalid turn");
    }
    turnIds.add(turn.id);
    sequences.add(turn.sequence);
  }

  const artifactIds = new Set<string>();
  const artifactsById = new Map<string, SessionArtifact>();
  for (const artifact of artifacts) {
    if (artifactIds.has(artifact.id)) {
      return invalidState("Session run has duplicate artifact identity");
    }
    artifactIds.add(artifact.id);
    if (artifact.type === "session_message") artifactsById.set(artifact.id, artifact);
  }

  const committedTurns = [...turns].sort((left, right) => left.sequence - right.sequence);
  const committedArtifacts: SessionArtifact[] = [];
  for (const turn of committedTurns) {
    if (turn.status !== "committed") continue;
    const expectedParticipant = participants[committedArtifacts.length % participants.length];
    const artifact = turn.outputArtifactId
      ? artifactsById.get(turn.outputArtifactId)
      : undefined;
    if (
      !expectedParticipant ||
      turn.agentId !== expectedParticipant.agentId ||
      !artifact ||
      artifact.turnId !== turn.id ||
      artifact.createdByRole !== "participant" ||
      artifact.createdByAgentId !== turn.agentId
    ) {
      return invalidState("Committed session turn has invalid routing or output");
    }
    committedArtifacts.push(artifact);
  }
  const userArtifacts = artifacts.filter(
    (artifact): artifact is UserArtifact => artifact.type === "user_message",
  );
  if (committedArtifacts.length + userArtifacts.length !== artifacts.length) {
    return invalidState("Session run contains an uncommitted artifact");
  }

  const transcriptArtifacts = [...committedArtifacts, ...userArtifacts].sort((left, right) => {
    const leftSequence = left.transcriptSequence ?? Number.MIN_SAFE_INTEGER;
    const rightSequence = right.transcriptSequence ?? Number.MIN_SAFE_INTEGER;
    return leftSequence - rightSequence || left.createdAt.localeCompare(right.createdAt);
  });

  return { participants, committedArtifacts, transcriptArtifacts };
};

const validateCountdownState = (
  view: WorkflowView,
  artifacts: SessionArtifact[],
): WorkflowDecision | undefined => {
  const { run } = view;
  const startValue = run.policy.sessionStartValue;
  const nextExpectedNumber = run.sharedState?.nextExpectedNumber;
  if (
    !isPositiveInteger(startValue ?? 0) ||
    typeof nextExpectedNumber !== "number" ||
    !Number.isInteger(nextExpectedNumber)
  ) {
    return invalidState("Countdown session has missing or invalid shared state");
  }

  for (const [index, artifact] of artifacts.entries()) {
    const value = Number(artifact.payload.content);
    if (
      !Number.isInteger(value) ||
      value !== startValue! - index ||
      artifact.payload.done !== undefined
    ) {
      return invalidState("Countdown transcript is inconsistent with shared state");
    }
  }
  if (nextExpectedNumber !== startValue! - artifacts.length) {
    return invalidState("Countdown transcript is inconsistent with shared state");
  }
  return undefined;
};

const finalArtifactId = (
  artifacts: SessionArtifact[],
): CoordinationArtifactId | undefined => artifacts.at(-1)?.id;

export class SharedSessionWorkflowV1 implements SharedSessionWorkflow {
  decideNext(view: WorkflowView): WorkflowDecision {
    const validated = validateSessionView(view);
    if ("kind" in validated) return validated;

    const { run } = view;
    const { participants, committedArtifacts, transcriptArtifacts } = validated;
    const lastArtifactId = finalArtifactId(committedArtifacts);

    if (run.policy.sessionProtocol === "countdown") {
      const invalid = validateCountdownState(view, committedArtifacts);
      if (invalid) return invalid;
      if (Number(committedArtifacts.at(-1)?.payload.content) === 1) {
        return lastArtifactId
          ? { kind: "complete", finalArtifactId: lastArtifactId }
          : invalidState("Completed session has no final artifact");
      }
      if (run.nextTurnSequence > run.policy.maxTurns) {
        return {
          kind: "fail",
          code: "MAX_TURNS_EXCEEDED",
          message: "Countdown session reached its turn limit",
        };
      }
    } else {
      if (run.sharedState !== undefined || run.policy.sessionStartValue !== undefined) {
        return invalidState("Free-chat session must not carry countdown state");
      }

      if (committedArtifacts.length >= run.policy.maxTurns) {
        return {
          kind: "fail",
          code: "MAX_TURNS_EXCEEDED",
          message: "Session reached its hard turn limit",
        };
      }

      const activeUser = run.lastUserArtifactId
        ? transcriptArtifacts.find(
            (artifact): artifact is UserArtifact =>
              artifact.type === "user_message" && artifact.id === run.lastUserArtifactId,
          )
        : undefined;
      const activeSequence = activeUser?.transcriptSequence ?? Number.MIN_SAFE_INTEGER;
      const currentWave = committedArtifacts.filter(
        (artifact) => (artifact.transcriptSequence ?? Number.MIN_SAFE_INTEGER) > activeSequence,
      );
      const latestByParticipant = new Map<string, SessionArtifact>();
      for (const artifact of currentWave) {
        latestByParticipant.set(artifact.createdByAgentId, artifact);
      }
      const unanimous =
        currentWave.length >= participants.length &&
        participants.every(
          ({ agentId }) => latestByParticipant.get(agentId)?.payload.done === true,
        );
      if (unanimous) {
        return { kind: "await_input" };
      }
    }

    const participant = participants[committedArtifacts.length % participants.length];
    if (!participant) return invalidState("Session run has no next participant");

    return {
      kind: "schedule",
      role: "participant",
      agentId: participant.agentId,
      turnKind: "session_turn",
      phase: "sessioning",
      revision: 0,
      inputArtifactIds: transcriptArtifacts.map(({ id }) => id),
      expectedArtifactType: "session_message",
    };
  }
}
