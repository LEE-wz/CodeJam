import type {
  CoordinationArtifact,
  CoordinationAttempt,
  CoordinationEvent,
  CoordinationEventType,
  CoordinationRunDetails,
  CoordinationRunStatus,
  CoordinationTurn,
  SessionProtocol,
} from "../coordination-types";

export type UiFixtureName = "completed" | "rejectionRevision" | "retry" | "timeout" | "stopped" | "failed" | "interrupted";
export type UiSessionFixtureName =
  | "countdownRunning"
  | "countdownRetry"
  | "freeChatPartial"
  | "freeChatUnanimous"
  | "freeChatWithdrawn"
  | "sessionStopped"
  | "sessionFailed"
  | "sessionInterrupted"
  | "sessionCompleted";

export type UiAuctionFixtureName = "auctionAwarded" | "auctionBidding" | "auctionFallback";

const now = "2026-08-30T04:00:00.000Z";
const participants = [
  { role: "planner" as const, agentId: "agent-planner", agentNameSnapshot: "Relay Planner" },
  { role: "critic" as const, agentId: "agent-critic", agentNameSnapshot: "Relay Critic" },
  { role: "finalizer" as const, agentId: "agent-finalizer", agentNameSnapshot: "Relay Finaliser" },
];
const sessionParticipants = [
  { role: "participant" as const, agentId: "agent-planner", agentNameSnapshot: "Relay Planner" },
  { role: "participant" as const, agentId: "agent-critic", agentNameSnapshot: "Relay Critic" },
  { role: "participant" as const, agentId: "agent-finalizer", agentNameSnapshot: "Relay Finaliser" },
];

const verifiedBase = (
  name: UiFixtureName,
  status: CoordinationRunStatus,
  eventTypes: CoordinationEventType[],
): CoordinationRunDetails => {
  const runId = `run-${name}`;
  const turn: CoordinationTurn = {
    id: `turn-${name}`,
    runId,
    sequence: 1,
    role: "planner",
    agentId: participants[0]!.agentId,
    kind: "initial_proposal",
    status: status === "completed" ? "committed" : status === "running" ? "running" : "failed",
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
  const artifacts: CoordinationArtifact[] = [];
  if (status === "completed") {
    artifacts.push(name === "rejectionRevision" ? {
      id: `artifact-${name}`,
      runId,
      turnId: turn.id,
      createdByRole: "critic",
      createdByAgentId: participants[1]!.agentId,
      sizeChars: 120,
      createdAt: now,
      type: "review",
      payload: { schemaVersion: 1, type: "review", decision: "reject", issues: [{ code: "NEEDS_DETAIL", message: "Add measurable safeguards." }], feedback: "Revise the risks." },
    } : {
      id: `artifact-${name}`,
      runId,
      turnId: turn.id,
      createdByRole: "planner",
      createdByAgentId: participants[0]!.agentId,
      sizeChars: 120,
      createdAt: now,
      type: "proposal",
      payload: { schemaVersion: 1, type: "proposal", summary: "A measured launch.", sections: [{ key: "summary", title: "Summary", content: "Launch with a focused cohort." }] },
    });
  }
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
      activeTurnIds: [],
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
    usageTotals: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    artifacts,
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

interface SessionMessageFixture {
  agent: number;
  content: string;
  done?: boolean;
  rejectedContent?: string;
}

const sessionBase = (
  name: UiSessionFixtureName,
  protocol: SessionProtocol,
  status: CoordinationRunStatus,
  messages: SessionMessageFixture[],
): CoordinationRunDetails => {
  const runId = `run-${name}`;
  const turns: CoordinationTurn[] = [];
  const attempts: CoordinationAttempt[] = [];
  const artifacts: CoordinationArtifact[] = [];
  const events: CoordinationEvent[] = [{
    id: `event-${name}-1`, runId, sequence: 1, type: "run.created", actor: { type: "user" },
    message: "Shared session created", details: { workflow: "shared_session_v1" }, createdAt: now,
  }];

  messages.forEach((message, index) => {
    const turnId = `turn-${name}-${index + 1}`;
    const artifactId = `artifact-${name}-${index + 1}`;
    const validationError = message.rejectedContent
      ? `Expected the next number ${message.content}, received ${message.rejectedContent}`
      : undefined;
    turns.push({
      id: turnId,
      runId,
      sequence: index + 1,
      role: "participant",
      agentId: sessionParticipants[message.agent]!.agentId,
      kind: "session_turn",
      status: "committed",
      attemptCount: validationError ? 2 : 1,
      inputArtifactIds: artifacts.map(({ id }) => id),
      outputArtifactId: artifactId,
      lastValidationErrors: validationError ? [validationError] : [],
      createdAt: now,
      completedAt: now,
    });
    if (validationError) {
      attempts.push({
        id: `attempt-${name}-${index + 1}-1`, runId, turnId, number: 1,
        agentId: sessionParticipants[message.agent]!.agentId, status: "invalid_output",
        errorCode: "INVALID_AGENT_OUTPUT", errorMessage: validationError, createdAt: now, finishedAt: now,
      });
      events.push({
        id: `event-${name}-${events.length + 1}`, runId, sequence: events.length + 1,
        type: "attempt.invalid_output", actor: { type: "agent", agentId: sessionParticipants[message.agent]!.agentId, role: "participant" },
        turnId, message: validationError, details: { attemptNumber: 1 }, createdAt: now,
      });
    }
    attempts.push({
      id: `attempt-${name}-${index + 1}-${validationError ? 2 : 1}`, runId, turnId,
      number: validationError ? 2 : 1, agentId: sessionParticipants[message.agent]!.agentId,
      status: "succeeded", createdAt: now, finishedAt: now,
    });
    artifacts.push({
      id: artifactId,
      runId,
      turnId,
      createdByRole: "participant",
      createdByAgentId: sessionParticipants[message.agent]!.agentId,
      sizeChars: message.content.length,
      createdAt: now,
      type: "session_message",
      payload: {
        schemaVersion: 1,
        type: "session_message",
        content: message.content,
        ...(message.done === undefined ? {} : { done: message.done }),
      },
    });
    events.push({
      id: `event-${name}-${events.length + 1}`, runId, sequence: events.length + 1,
      type: "turn.committed", actor: { type: "agent", agentId: sessionParticipants[message.agent]!.agentId, role: "participant" },
      turnId, artifactId, message: `${sessionParticipants[message.agent]!.agentNameSnapshot} committed a session message`,
      details: { turnSequence: index + 1 }, createdAt: now,
    });
  });

  if (status === "failed" || status === "stopped") {
    const terminalTurnId = `turn-${name}-terminal`;
    const terminalAttemptStatus = name === "sessionFailed" ? "failed" : "cancelled";
    turns.push({
      id: terminalTurnId, runId, sequence: turns.length + 1, role: "participant",
      agentId: sessionParticipants[turns.length % sessionParticipants.length]!.agentId,
      kind: "session_turn", status: name === "sessionFailed" ? "failed" : "cancelled",
      attemptCount: 1, inputArtifactIds: artifacts.map(({ id }) => id), lastValidationErrors: [], createdAt: now,
    });
    attempts.push({
      id: `attempt-${name}-terminal`, runId, turnId: terminalTurnId, number: 1,
      agentId: sessionParticipants[turns.length % sessionParticipants.length]!.agentId,
      status: terminalAttemptStatus, errorMessage: name === "sessionFailed" ? "Agent execution failed" : "Attempt cancelled",
      createdAt: now, finishedAt: now,
    });
  }

  if (status === "completed") {
    events.push({ id: `event-${name}-complete`, runId, sequence: events.length + 1, type: "run.completed", actor: { type: "system" }, message: "Shared session completed", details: {}, createdAt: now });
  } else if (status === "stopped") {
    events.push({ id: `event-${name}-stop`, runId, sequence: events.length + 1, type: "run.stopped", actor: { type: "system" }, message: "Shared session stopped", details: {}, createdAt: now });
  } else if (status === "failed") {
    events.push({ id: `event-${name}-fail`, runId, sequence: events.length + 1, type: name === "sessionInterrupted" ? "run.interrupted" : "run.failed", actor: { type: "system" }, message: name === "sessionInterrupted" ? "Server restart interrupted the session" : "Shared session failed", details: {}, createdAt: now });
  }

  const latestCountdown = protocol === "countdown" && messages.length > 0
    ? Number(messages[messages.length - 1]!.content) - 1
    : undefined;
  return {
    run: {
      id: runId,
      name: `${name} session`,
      objective: protocol === "countdown" ? "Count down together in exact round-robin order." : "Agree a concise launch checklist together.",
      requiredSections: [],
      participants: sessionParticipants,
      policy: {
        workflow: "shared_session_v1",
        maxRevisions: 0,
        maxTurns: protocol === "countdown" ? Math.max(3, messages.length + 2) : 9,
        maxAttemptsPerTurn: 2,
        perAttemptTimeoutMs: 120_000,
        contextMaxChars: 12_000,
        outputMaxChars: 20_000,
        sessionProtocol: protocol,
        ...(protocol === "countdown" ? { sessionStartValue: Number(messages[0]?.content ?? 10) } : {}),
      },
      status,
      phase: status === "completed" ? "done" : "sessioning",
      revision: 0,
      nextTurnSequence: turns.length + 1,
      activeTurnIds: [],
      ...(latestCountdown === undefined ? {} : { sharedState: { nextExpectedNumber: latestCountdown } }),
      version: events.length,
      ...(status === "stopped" ? { errorCode: "STOPPED_BY_USER", errorMessage: "The run was stopped by the user." } : {}),
      ...(status === "failed" ? {
        errorCode: name === "sessionInterrupted" ? "SERVER_RESTARTED" : "MAX_ATTEMPTS_EXCEEDED",
        errorMessage: name === "sessionInterrupted" ? "The run was interrupted by a server restart." : "The turn exhausted its retry limit.",
      } : {}),
      createdAt: now,
      updatedAt: now,
    },
    turns,
    attempts,
    usageTotals: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    artifacts,
    events,
  };
};

export const UI_COORDINATION_FIXTURES: Record<UiFixtureName, CoordinationRunDetails> = {
  completed: verifiedBase("completed", "completed", ["run.created", "turn.committed", "run.completed"]),
  rejectionRevision: verifiedBase("rejectionRevision", "completed", ["run.created", "review.rejected", "review.approved", "run.completed"]),
  retry: verifiedBase("retry", "completed", ["run.created", "attempt.invalid_output", "turn.committed", "run.completed"]),
  timeout: verifiedBase("timeout", "completed", ["run.created", "attempt.timed_out", "turn.committed", "run.completed"]),
  stopped: verifiedBase("stopped", "stopped", ["run.created", "run.stop_requested", "attempt.cancelled", "run.stopped"]),
  failed: verifiedBase("failed", "failed", ["run.created", "attempt.failed", "run.failed"]),
  interrupted: verifiedBase("interrupted", "failed", ["run.created", "attempt.cancelled", "run.interrupted", "run.failed"]),
};

/**
 * One settled auction round: three bids, one award, one executed answer.
 *
 * The losing bids stay in `artifacts` because they are inspectable evidence;
 * every transcript assertion in the UI tests depends on them being excluded
 * from the rendered conversation.
 */
const auctionBase = (
  name: UiAuctionFixtureName,
  status: CoordinationRunStatus,
  options: {
    awarded?: boolean;
    fallback?: boolean;
    activeBidTurn?: boolean;
    executed?: boolean;
  } = {},
): CoordinationRunDetails => {
  const runId = `run-${name}`;
  const userArtifactId = `artifact-${name}-user`;
  const awardId = `artifact-${name}-award`;
  const turns: CoordinationTurn[] = [];
  const attempts: CoordinationAttempt[] = [];
  const artifacts: CoordinationArtifact[] = [
    {
      id: userArtifactId,
      runId,
      type: "user_message",
      payload: { schemaVersion: 1, type: "user_message", content: "Draft the rollback plan." },
      createdBy: { kind: "user" },
      transcriptSequence: 1,
      sizeChars: 24,
      createdAt: now,
    },
  ];
  const events: CoordinationEvent[] = [
    {
      id: `event-${name}-1`, runId, sequence: 1, type: "user.message_appended",
      actor: { type: "user" }, artifactId: userArtifactId,
      message: "User message appended.", details: { transcriptSequence: 1 }, createdAt: now,
    },
  ];

  sessionParticipants.forEach((participant, index) => {
    const turnId = `turn-${name}-bid-${index + 1}`;
    const bidId = `artifact-${name}-bid-${index + 1}`;
    turns.push({
      id: turnId, runId, sequence: index + 1, role: "participant",
      agentId: participant.agentId, kind: "session_bid", wavePurpose: "session_bidding",
      status: options.activeBidTurn ? "scheduled" : options.fallback ? "failed" : "committed",
      attemptCount: 1, inputArtifactIds: [userArtifactId],
      ...(options.activeBidTurn || options.fallback ? {} : { outputArtifactId: bidId }),
      lastValidationErrors: [], createdAt: now,
    });
    attempts.push({
      id: `attempt-${name}-bid-${index + 1}`, runId, turnId, number: 1,
      agentId: participant.agentId,
      status: options.activeBidTurn ? "running" : options.fallback ? "invalid_output" : "succeeded",
      usage: { inputTokens: 120, cachedInputTokens: 0, outputTokens: 60 },
      createdAt: now,
    });
    if (options.activeBidTurn || options.fallback) return;
    artifacts.push({
      id: bidId, runId, turnId, createdByRole: "participant",
      createdByAgentId: participant.agentId, type: "session_bid",
      payload: {
        schemaVersion: 1,
        type: "session_bid",
        recommendation: "auction",
        plan: {
          summary: `Plan from ${participant.agentNameSnapshot}.`,
          mode: "single",
          assignments: [
            { agentId: participant.agentId, position: 1, instruction: "Answer the request." },
          ],
          risks: [],
          assumptions: [],
        },
        confidenceBps: 7_000 + index * 500,
        estimatedOutputTokens: 900,
      },
      sizeChars: 200, createdAt: now,
    });
  });

  if (options.awarded || options.fallback) {
    const winner = sessionParticipants[options.fallback ? 0 : 2]!;
    artifacts.push({
      id: awardId,
      runId,
      type: "session_award",
      createdBy: { kind: "system" },
      payload: {
        schemaVersion: 1,
        type: "session_award",
        userArtifactId,
        ...(options.fallback ? {} : { winningBidArtifactId: `artifact-${name}-bid-3` }),
        selectedAgentId: winner.agentId,
        outcome: options.fallback ? "fallback_execution" : "execute_plan",
        scoringVersion: "confidence_cost_v1",
        scoreBps: options.fallback ? 0 : 5_600,
        components: {
          calibratedConfidenceBps: options.fallback ? 0 : 7_500,
          normalizedProjectedCostBps: options.fallback ? 0 : 800,
          reliabilityPenaltyBps: 0,
        },
        estimatedExecution: { inputTokens: 2_400, outputTokens: 900 },
        ...(options.fallback ? { fallback: "round_robin" as const } : {}),
      },
      sizeChars: 300,
      createdAt: now,
    });
    events.push({
      id: `event-${name}-award`, runId, sequence: events.length + 1, type: "award.created",
      actor: { type: "system" }, artifactId: awardId, message: "Session award committed.",
      details: { agentId: winner.agentId, outcome: options.fallback ? "fallback_execution" : "execute_plan", scoreBps: options.fallback ? 0 : 5_600 },
      createdAt: now,
    });

    if (options.executed !== false) {
      const executionTurnId = `turn-${name}-exec`;
      const messageId = `artifact-${name}-message`;
      turns.push({
        id: executionTurnId, runId, sequence: turns.length + 1, role: "participant",
        agentId: winner.agentId, kind: "session_turn", wavePurpose: "session_execution",
        status: "committed", attemptCount: 1,
        inputArtifactIds: [userArtifactId, awardId], outputArtifactId: messageId,
        lastValidationErrors: [], createdAt: now,
      });
      attempts.push({
        id: `attempt-${name}-exec`, runId, turnId: executionTurnId, number: 1,
        agentId: winner.agentId, status: "succeeded",
        usage: { inputTokens: 2_600, cachedInputTokens: 100, outputTokens: 1_100 },
        createdAt: now,
      });
      artifacts.push({
        id: messageId, runId, turnId: executionTurnId, createdByRole: "participant",
        createdByAgentId: winner.agentId, type: "session_message",
        payload: { schemaVersion: 1, type: "session_message", content: "Roll back in three staged steps." },
        transcriptSequence: 2, sizeChars: 33, createdAt: now,
      });
    }
  }

  return {
    run: {
      id: runId,
      name: `${name} session`,
      objective: "Answer operational questions together.",
      requiredSections: [],
      participants: sessionParticipants,
      policy: {
        workflow: "shared_session_v1",
        maxRevisions: 0,
        maxTurns: 20,
        maxAttemptsPerTurn: 2,
        perAttemptTimeoutMs: 120_000,
        contextMaxChars: 40_000,
        outputMaxChars: 20_000,
        sessionProtocol: "free_chat",
        auctionPolicy: {
          routingMode: "auction",
          directConfidenceThresholdBps: 8_000,
          directOutputTokenBudget: 4_000,
          minimumValidBids: 2,
          maxBidOutputTokens: 2_048,
          maxBidAttempts: 2,
          auctionExecutionTokenBudget: 4_000,
          auctionOnDirectFailure: false,
          fallback: "round_robin",
          scoringVersion: "confidence_cost_v1",
        },
      },
      status,
      phase: "sessioning",
      revision: 0,
      nextTurnSequence: turns.length + 1,
      activeTurnIds: options.activeBidTurn ? turns.map(({ id }) => id) : [],
      lastUserArtifactId: userArtifactId,
      version: events.length,
      createdAt: now,
      updatedAt: now,
    },
    turns,
    attempts,
    usageTotals: { inputTokens: 2_960, cachedInputTokens: 100, outputTokens: 1_280 },
    auctionUsage: {
      actualBidding: { inputTokens: 360, cachedInputTokens: 0, outputTokens: 180 },
      actualExecution: { inputTokens: 2_600, cachedInputTokens: 100, outputTokens: 1_100 },
      projectedExecution: { inputTokens: 2_400, outputTokens: 900 },
    },
    artifacts,
    events,
  };
};

export const UI_AUCTION_FIXTURES: Record<UiAuctionFixtureName, CoordinationRunDetails> = {
  auctionAwarded: auctionBase("auctionAwarded", "awaiting_input", { awarded: true }),
  auctionBidding: auctionBase("auctionBidding", "running", { activeBidTurn: true }),
  auctionFallback: auctionBase("auctionFallback", "awaiting_input", { fallback: true }),
};

export const UI_SESSION_FIXTURES: Record<UiSessionFixtureName, CoordinationRunDetails> = {
  countdownRunning: sessionBase("countdownRunning", "countdown", "running", [
    { agent: 0, content: "10" }, { agent: 1, content: "9" }, { agent: 2, content: "8" },
  ]),
  countdownRetry: sessionBase("countdownRetry", "countdown", "running", [
    { agent: 0, content: "10" }, { agent: 1, content: "9", rejectedContent: "8" },
  ]),
  freeChatPartial: sessionBase("freeChatPartial", "free_chat", "running", [
    { agent: 0, content: "Start with a small invited cohort.", done: true },
    { agent: 1, content: "Add a support escalation path." },
    { agent: 2, content: "I will refine the launch metrics next." },
  ]),
  freeChatUnanimous: sessionBase("freeChatUnanimous", "free_chat", "completed", [
    { agent: 0, content: "The cohort plan is ready.", done: true },
    { agent: 1, content: "The support path is ready.", done: true },
    { agent: 2, content: "The metrics are ready.", done: true },
  ]),
  freeChatWithdrawn: sessionBase("freeChatWithdrawn", "free_chat", "running", [
    { agent: 0, content: "Initial plan is ready.", done: true },
    { agent: 1, content: "Support plan is ready.", done: true },
    { agent: 2, content: "One risk still needs work." },
    { agent: 0, content: "I am revising the cohort plan." },
  ]),
  sessionStopped: sessionBase("sessionStopped", "free_chat", "stopped", [
    { agent: 0, content: "Drafting the cohort plan." },
  ]),
  sessionFailed: sessionBase("sessionFailed", "countdown", "failed", [
    { agent: 0, content: "10" },
  ]),
  sessionInterrupted: sessionBase("sessionInterrupted", "free_chat", "failed", [
    { agent: 0, content: "Drafting the cohort plan." },
  ]),
  sessionCompleted: sessionBase("sessionCompleted", "countdown", "completed", [
    { agent: 0, content: "3" }, { agent: 1, content: "2" }, { agent: 2, content: "1" },
  ]),
};
