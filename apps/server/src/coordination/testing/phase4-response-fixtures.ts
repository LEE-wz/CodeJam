import type {
  CoordinationAttemptResponse,
  CoordinationEvent,
  CoordinationEventType,
  CoordinationTurn,
  GetCoordinationRunResponse,
} from "../types.js";
import { PHASE3_COMPLETED_RESPONSE } from "./phase3-completed-response.js";
import {
  APPROVING_REVIEW_ARTIFACT,
  CRITIC_AGENT,
  PLANNER_AGENT,
  REJECTING_REVIEW_ARTIFACT,
  VALID_PROPOSAL_ARTIFACT,
  VALID_PROPOSAL_PAYLOAD,
} from "./fixtures.js";

export type Phase4FixtureName =
  | "completed"
  | "rejectionRevision"
  | "retry"
  | "timeout"
  | "stopped"
  | "failed"
  | "interrupted";

const createdAt = "2026-08-30T04:00:00.000Z";
const finishedAt = "2026-08-30T04:01:00.000Z";

const cloneCompleted = (): GetCoordinationRunResponse =>
  structuredClone(PHASE3_COMPLETED_RESPONSE);

const resequenceEvents = (
  runId: string,
  eventTypes: CoordinationEventType[],
): CoordinationEvent[] =>
  eventTypes.map((type, index) => ({
    id: `${runId}-event-${index + 1}`,
    runId,
    sequence: index + 1,
    type,
    actor: { type: "system" },
    message: type.replaceAll(".", " "),
    details: {},
    createdAt,
  }));

const withRunId = (
  response: GetCoordinationRunResponse,
  runId: string,
): GetCoordinationRunResponse => {
  response.run.id = runId;
  for (const turn of response.turns) turn.runId = runId;
  for (const attempt of response.attempts) attempt.runId = runId;
  for (const artifact of response.artifacts) artifact.runId = runId;
  for (const event of response.events) event.runId = runId;
  return response;
};

const completed = withRunId(cloneCompleted(), "run-phase4-completed");

const rejectionRevision = (() => {
  const response = withRunId(cloneCompleted(), "run-phase4-rejection-revision");
  const runId = response.run.id;
  const revisionProposal: CoordinationTurn = {
    ...response.turns[0]!,
    id: "turn-proposal-revision",
    sequence: 3,
    kind: "proposal_revision",
    inputArtifactIds: ["artifact-proposal", "artifact-review-reject"],
    outputArtifactId: "artifact-proposal-revision",
  };
  const approvingReview: CoordinationTurn = {
    ...response.turns[1]!,
    id: "turn-review-approve",
    sequence: 4,
    inputArtifactIds: ["artifact-proposal-revision"],
  };
  const finalTurn: CoordinationTurn = {
    ...response.turns[2]!,
    sequence: 5,
    inputArtifactIds: ["artifact-proposal-revision", "artifact-review-approve"],
  };
  const rejectingReview: CoordinationTurn = {
    ...response.turns[1]!,
    id: "turn-review-reject",
    sequence: 2,
    inputArtifactIds: ["artifact-proposal"],
    outputArtifactId: "artifact-review-reject",
  };

  response.run.name = "Rejected then revised fixture";
  response.run.revision = 1;
  response.run.nextTurnSequence = 6;
  response.run.latestProposalArtifactId = "artifact-proposal-revision";
  response.turns = [response.turns[0]!, rejectingReview, revisionProposal, approvingReview, finalTurn];
  response.attempts = response.turns.map((turn, index) => ({
    id: `attempt-revision-${index + 1}`,
    runId,
    turnId: turn.id,
    number: 1,
    agentId: turn.agentId,
    status: "succeeded",
    agentRunId: `agent-run-revision-${index + 1}`,
    promptDigest: `sha256:revision-prompt-${index + 1}`,
    outputDigest: `sha256:revision-output-${index + 1}`,
    createdAt,
    finishedAt,
  }));
  response.artifacts = [
    { ...VALID_PROPOSAL_ARTIFACT, runId },
    { ...REJECTING_REVIEW_ARTIFACT, runId },
    {
      ...VALID_PROPOSAL_ARTIFACT,
      id: "artifact-proposal-revision",
      runId,
      turnId: revisionProposal.id,
      createdByRole: "planner",
      createdByAgentId: PLANNER_AGENT.id,
      type: "proposal",
      payload: {
        ...VALID_PROPOSAL_PAYLOAD,
        summary: "Revised launch with measurable fraud-response safeguards.",
      },
    },
    { ...APPROVING_REVIEW_ARTIFACT, runId },
    { ...response.artifacts[2]!, runId },
  ];
  response.events = resequenceEvents(runId, [
    "run.created", "run.started", "turn.scheduled", "attempt.started", "turn.committed",
    "turn.scheduled", "attempt.started", "turn.committed", "review.rejected",
    "turn.scheduled", "attempt.started", "turn.committed", "turn.scheduled",
    "attempt.started", "turn.committed", "review.approved", "turn.scheduled",
    "attempt.started", "turn.committed", "run.completed",
  ]);
  return response;
})();

const withRecoveredAttempt = (
  name: "retry" | "timeout",
  failedStatus: "invalid_output" | "timed_out",
  eventType: "attempt.invalid_output" | "attempt.timed_out",
): GetCoordinationRunResponse => {
  const response = withRunId(cloneCompleted(), `run-phase4-${name}`);
  const firstTurn = response.turns[0]!;
  firstTurn.attemptCount = 2;
  const recoveredAttempt = response.attempts[0]!;
  recoveredAttempt.id = `attempt-${name}-2`;
  recoveredAttempt.number = 2;
  const failedAttempt: CoordinationAttemptResponse = {
    id: `attempt-${name}-1`,
    runId: response.run.id,
    turnId: firstTurn.id,
    number: 1,
    agentId: firstTurn.agentId,
    status: failedStatus,
    agentRunId: `agent-run-${name}-1`,
    promptDigest: `sha256:${name}-prompt-1`,
    errorCode: failedStatus === "timed_out" ? "ATTEMPT_TIMED_OUT" : "INVALID_AGENT_OUTPUT",
    errorMessage: failedStatus === "timed_out"
      ? "The attempt exceeded the configured deadline."
      : "The Agent response did not match the required artifact schema.",
    createdAt,
    finishedAt,
  };
  response.run.name = name === "retry" ? "Recovered validation retry fixture" : "Recovered timeout fixture";
  response.attempts = [failedAttempt, ...response.attempts];
  response.events = resequenceEvents(response.run.id, [
    "run.created", "run.started", "turn.scheduled", "attempt.started", eventType,
    "attempt.started", "turn.committed", "turn.scheduled", "attempt.started",
    "turn.committed", "review.approved", "turn.scheduled", "attempt.started",
    "turn.committed", "run.completed",
  ]);
  return response;
};

const terminalFailure = (
  name: "stopped" | "failed" | "interrupted",
): GetCoordinationRunResponse => {
  const response = withRunId(cloneCompleted(), `run-phase4-${name}`);
  const turn = response.turns[0]!;
  const attempt = response.attempts[0]!;
  const isStopped = name === "stopped";
  const isInterrupted = name === "interrupted";

  response.run.name = `${name[0]!.toUpperCase()}${name.slice(1)} fixture`;
  response.run.status = isStopped ? "stopped" : "failed";
  response.run.phase = "drafting";
  response.run.nextTurnSequence = 2;
  response.run.activeTurnIds = [];
  delete response.run.latestProposalArtifactId;
  delete response.run.latestReviewArtifactId;
  delete response.run.finalArtifactId;
  delete response.run.completedAt;
  response.run.errorCode = isStopped
    ? "STOPPED_BY_USER"
    : isInterrupted
      ? "SERVER_RESTARTED"
      : "MAX_ATTEMPTS_EXCEEDED";
  response.run.errorMessage = isStopped
    ? "The run was stopped by the user."
    : isInterrupted
      ? "The active run was interrupted by a server restart."
      : "The proposal turn exhausted its retry limit.";
  if (isStopped) response.run.stoppedAt = finishedAt;
  else response.run.failedAt = finishedAt;

  turn.status = isStopped || isInterrupted ? "cancelled" : "failed";
  turn.attemptCount = isStopped || isInterrupted ? 1 : 2;
  delete turn.outputArtifactId;
  turn.completedAt = finishedAt;
  attempt.status = isStopped || isInterrupted ? "cancelled" : "failed";
  attempt.errorCode = response.run.errorCode;
  attempt.errorMessage = response.run.errorMessage;
  attempt.finishedAt = finishedAt;
  response.turns = [turn];
  response.attempts = isStopped || isInterrupted
    ? [attempt]
    : [
        { ...attempt, id: "attempt-failed-1", number: 1 },
        { ...attempt, id: "attempt-failed-2", number: 2 },
      ];
  response.artifacts = [];
  response.events = resequenceEvents(response.run.id, isStopped
    ? ["run.created", "run.started", "turn.scheduled", "attempt.started", "run.stop_requested", "attempt.cancelled", "run.stopped"]
    : isInterrupted
      ? ["run.created", "run.started", "turn.scheduled", "attempt.started", "attempt.cancelled", "run.interrupted", "run.failed"]
      : ["run.created", "run.started", "turn.scheduled", "attempt.started", "attempt.failed", "attempt.started", "attempt.failed", "run.failed"]);
  return response;
};

/** Redacted API responses covering every state required by the Phase 4 UI gate. */
export const PHASE4_RESPONSE_FIXTURES: Readonly<Record<Phase4FixtureName, GetCoordinationRunResponse>> = {
  completed,
  rejectionRevision,
  retry: withRecoveredAttempt("retry", "invalid_output", "attempt.invalid_output"),
  timeout: withRecoveredAttempt("timeout", "timed_out", "attempt.timed_out"),
  stopped: terminalFailure("stopped"),
  failed: terminalFailure("failed"),
  interrupted: terminalFailure("interrupted"),
};
