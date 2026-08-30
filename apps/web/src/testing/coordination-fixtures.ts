import type {
  CoordinationAttempt,
  CoordinationEventType,
  CoordinationRunDetails,
  CoordinationRunStatus,
} from "../coordination-types";

export type UiFixtureName = "completed" | "rejectionRevision" | "retry" | "timeout" | "stopped" | "failed" | "interrupted";

const now = "2026-08-30T04:00:00.000Z";
const participants = [
  { role: "planner" as const, agentId: "agent-planner", agentNameSnapshot: "Relay Planner" },
  { role: "critic" as const, agentId: "agent-critic", agentNameSnapshot: "Relay Critic" },
  { role: "finalizer" as const, agentId: "agent-finalizer", agentNameSnapshot: "Relay Finaliser" },
];

const base = (
  name: UiFixtureName,
  status: CoordinationRunStatus,
  eventTypes: CoordinationEventType[],
): CoordinationRunDetails => {
  const runId = `run-${name}`;
  const turn = {
    id: `turn-${name}`,
    runId,
    sequence: 1,
    role: "planner" as const,
    agentId: participants[0].agentId,
    kind: "initial_proposal" as const,
    status: status === "completed" ? "committed" as const : status === "running" ? "running" as const : "failed" as const,
    attemptCount: name === "retry" || name === "timeout" || name === "failed" ? 2 : 1,
    inputArtifactIds: [],
    lastValidationErrors: [],
    createdAt: now,
  };
  const attempts: CoordinationAttempt[] = [{
    id: `attempt-${name}-1`, runId, turnId: turn.id, number: 1,
    agentId: turn.agentId,
    status: name === "retry" ? "invalid_output" : name === "timeout" ? "timed_out" : name === "stopped" || name === "interrupted" ? "cancelled" : status === "completed" ? "succeeded" : "failed",
    createdAt: now,
  }];
  if (["retry", "timeout", "failed"].includes(name)) attempts.push({
    id: `attempt-${name}-2`, runId, turnId: turn.id, number: 2,
    agentId: turn.agentId, status: status === "completed" ? "succeeded" : "failed", createdAt: now,
  });
  const isTerminalFailure = status === "failed" || status === "stopped";
  return {
    run: {
      id: runId,
      name: `${name} fixture`,
      objective: "Produce a practical launch plan.",
      requiredSections: [{ key: "summary", title: "Summary" }],
      participants,
      policy: { workflow: "verified_handoff_v1", maxRevisions: 2, maxTurns: 8, maxAttemptsPerTurn: 2, perAttemptTimeoutMs: 120_000, contextMaxChars: 12_000, outputMaxChars: 20_000 },
      status,
      phase: status === "completed" ? "done" : "drafting",
      revision: name === "rejectionRevision" ? 1 : 0,
      nextTurnSequence: 2,
      version: 2,
      ...(isTerminalFailure ? {
        errorCode: name === "interrupted" ? "SERVER_RESTARTED" : name === "stopped" ? "STOPPED_BY_USER" : "MAX_ATTEMPTS_EXCEEDED",
        errorMessage: name === "interrupted" ? "The run was interrupted by a server restart." : name === "stopped" ? "The run was stopped by the user." : "The turn exhausted its retry limit.",
      } : {}),
      createdAt: now,
      updatedAt: now,
    },
    turns: [turn],
    attempts,
    artifacts: status === "completed" ? [{
      id: `artifact-${name}`,
      runId,
      turnId: turn.id,
      createdByRole: name === "rejectionRevision" ? "critic" : "planner",
      createdByAgentId: name === "rejectionRevision" ? participants[1].agentId : participants[0].agentId,
      sizeChars: 120,
      createdAt: now,
      type: name === "rejectionRevision" ? "review" : "proposal",
      payload: name === "rejectionRevision"
        ? { schemaVersion: 1, type: "review", decision: "reject", issues: [{ code: "NEEDS_DETAIL", message: "Add measurable safeguards." }], feedback: "Revise the risks." }
        : { schemaVersion: 1, type: "proposal", summary: "A measured launch.", sections: [{ key: "summary", title: "Summary", content: "Launch with a focused cohort." }] },
    }] : [],
    events: eventTypes.map((type, index) => ({
      id: `event-${name}-${index + 1}`,
      runId,
      sequence: index + 1,
      type,
      actor: { type: "system" },
      ...(type.startsWith("run.") ? {} : { turnId: turn.id }),
      message: type.replaceAll(".", " "),
      details: {},
      createdAt: now,
    })),
  };
};

export const UI_COORDINATION_FIXTURES: Record<UiFixtureName, CoordinationRunDetails> = {
  completed: base("completed", "completed", ["run.created", "turn.committed", "run.completed"]),
  rejectionRevision: base("rejectionRevision", "completed", ["run.created", "review.rejected", "review.approved", "run.completed"]),
  retry: base("retry", "completed", ["run.created", "attempt.invalid_output", "turn.committed", "run.completed"]),
  timeout: base("timeout", "completed", ["run.created", "attempt.timed_out", "turn.committed", "run.completed"]),
  stopped: base("stopped", "stopped", ["run.created", "run.stop_requested", "attempt.cancelled", "run.stopped"]),
  failed: base("failed", "failed", ["run.created", "attempt.failed", "run.failed"]),
  interrupted: base("interrupted", "failed", ["run.created", "attempt.cancelled", "run.interrupted", "run.failed"]),
};
