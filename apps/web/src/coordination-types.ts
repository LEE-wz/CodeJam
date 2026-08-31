export type CoordinationRole = "planner" | "critic" | "finalizer" | "participant";
export type CoordinationPhase =
  | "drafting"
  | "reviewing"
  | "revising"
  | "finalizing"
  | "sessioning"
  | "done";
export type CoordinationRunStatus =
  | "created"
  | "running"
  | "stop_requested"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "stopped";
export type CoordinationTurnKind =
  | "initial_proposal"
  | "proposal_revision"
  | "proposal_review"
  | "finalization"
  | "session_turn"
  | "session_plan";
export type CoordinationTurnStatus =
  | "scheduled"
  | "running"
  | "committed"
  | "failed"
  | "cancelled";
export type CoordinationAttemptStatus =
  | "running"
  | "succeeded"
  | "invalid_output"
  | "timed_out"
  | "failed"
  | "cancelled"
  | "stale_ignored";
export type CoordinationWorkflowKind = "verified_handoff_v1" | "shared_session_v1";
/**
 * `countdown` was deleted from the engine in Phase 14 (P14-07) but is retained
 * here: stored pre-Phase-14 runs still carry it, and the legacy render path
 * from P10-07 still displays them read-only. Nothing creatable uses it.
 */
export type SessionProtocol = "countdown" | "free_chat";

/** How a session decides who answers each user message (P14-05). */
export type SessionPlanningPolicy = "coordinator" | "round_robin";

export interface SessionPlanAssignment {
  agentId: string;
  position: number;
  instruction: string;
}

export interface SessionPlanPayload {
  schemaVersion: 1;
  type: "session_plan";
  mode: "parallel" | "sequential";
  assignments: SessionPlanAssignment[];
}
export type CoordinationEventType =
  | "run.created" | "run.started" | "turn.scheduled" | "attempt.started"
  | "attempt.invalid_output" | "attempt.timed_out" | "attempt.failed"
  | "attempt.cancelled" | "attempt.stale_ignored" | "turn.committed"
  | "review.approved" | "review.rejected" | "run.stop_requested"
  | "run.stopped" | "run.completed" | "run.failed" | "run.interrupted"
  | "run.reconciled" | "user.message_appended" | "run.awaiting_input";

export const SESSION_LIMITS = {
  minParticipants: 2,
  maxParticipants: 10,
  minSessionTurns: 3,
  maxSessionTurns: 100_000,
  defaultSessionTurns: 200,
  maxParallelTurns: 10,
} as const;

export interface RequiredSection {
  key: string;
  title: string;
}

export interface CoordinationPolicy {
  workflow: CoordinationWorkflowKind;
  maxRevisions: number;
  maxTurns: number;
  maxAttemptsPerTurn: number;
  perAttemptTimeoutMs: number;
  contextMaxChars: number;
  outputMaxChars: number;
  sessionProtocol?: SessionProtocol;
  /** Legacy: stored pre-Phase-14 countdown runs only (P14-07). */
  sessionStartValue?: number;
  sessionParallel?: boolean;
  maxParallelTurns?: number;
  /** Absent on stored sessions created before Phase 14; read as round robin. */
  sessionPlanning?: SessionPlanningPolicy;
}

export interface CoordinationParticipant {
  role: CoordinationRole;
  agentId: string;
  agentNameSnapshot: string;
}

export interface CoordinationRun {
  id: string;
  name: string;
  objective: string;
  requiredSections: RequiredSection[];
  participants: CoordinationParticipant[];
  policy: CoordinationPolicy;
  status: CoordinationRunStatus;
  phase: CoordinationPhase;
  revision: number;
  nextTurnSequence: number;
  activeTurnIds: string[];
  latestProposalArtifactId?: string;
  latestReviewArtifactId?: string;
  finalArtifactId?: string;
  lastUserArtifactId?: string;
  endedByUser?: boolean;
  sharedState?: { nextExpectedNumber: number };
  version: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  stoppedAt?: string;
}

export interface CoordinationTurn {
  id: string;
  runId: string;
  sequence: number;
  role: CoordinationRole;
  agentId: string;
  kind: CoordinationTurnKind;
  status: CoordinationTurnStatus;
  attemptCount: number;
  activeAttemptId?: string;
  inputArtifactIds: string[];
  outputArtifactId?: string;
  lastValidationErrors: string[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CoordinationAttempt {
  id: string;
  runId: string;
  turnId: string;
  number: number;
  agentId: string;
  status: CoordinationAttemptStatus;
  agentRunId?: string;
  promptDigest?: string;
  outputDigest?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  finishedAt?: string;
}

export interface ProposalPayload {
  schemaVersion: 1;
  type: "proposal";
  summary: string;
  sections: Array<{ key: string; title: string; content: string }>;
}

export interface ReviewPayload {
  schemaVersion: 1;
  type: "review";
  decision: "approve" | "reject";
  issues: Array<{ code: string; sectionKey?: string; message: string }>;
  feedback: string;
}

export interface FinalPayload {
  schemaVersion: 1;
  type: "final";
  title: string;
  content: string;
}

export interface SessionMessagePayload {
  schemaVersion: 1;
  type: "session_message";
  content: string;
  done?: boolean;
}

interface CoordinationArtifactBase {
  id: string;
  runId: string;
  turnId: string;
  createdByRole: CoordinationRole;
  createdByAgentId: string;
  sizeChars: number;
  createdAt: string;
  transcriptSequence?: number;
}

export interface UserMessagePayload {
  schemaVersion: 1;
  type: "user_message";
  content: string;
}

interface UserMessageArtifact {
  id: string;
  runId: string;
  type: "user_message";
  payload: UserMessagePayload;
  createdBy: { kind: "user" };
  clientMessageId?: string;
  transcriptSequence: number;
  sizeChars: number;
  createdAt: string;
}

export type CoordinationArtifact =
  | (CoordinationArtifactBase & { type: "proposal"; payload: ProposalPayload })
  | (CoordinationArtifactBase & { type: "review"; payload: ReviewPayload })
  | (CoordinationArtifactBase & { type: "final"; payload: FinalPayload })
  | (CoordinationArtifactBase & { type: "session_message"; payload: SessionMessagePayload })
  | (CoordinationArtifactBase & { type: "session_plan"; payload: SessionPlanPayload })
  | UserMessageArtifact;

export interface CoordinationEvent {
  id: string;
  runId: string;
  sequence: number;
  type: CoordinationEventType;
  actor: { type: "system" | "user" | "agent"; agentId?: string; role?: CoordinationRole };
  turnId?: string;
  attemptId?: string;
  artifactId?: string;
  message: string;
  details: Record<string, string | number | boolean | null | string[]>;
  createdAt: string;
}

export interface CoordinationRunDetails {
  run: CoordinationRun;
  turns: CoordinationTurn[];
  attempts: CoordinationAttempt[];
  artifacts: CoordinationArtifact[];
  events: CoordinationEvent[];
  cursor?: number;
}

/**
 * The session create contract is the only one this app sends. The
 * verified-handoff create body was removed with its UI (P10-06); the run and
 * artifact types above are retained because runs created by that workflow are
 * still rendered read-only.
 */
export interface CreateSessionRunRequest {
  workflow: "shared_session_v1";
  name: string;
  objective: string;
  agents: string[];
  policy?: {
    sessionProtocol?: "free_chat";
    sessionPlanning?: SessionPlanningPolicy;
    maxTurns?: number;
    perAttemptTimeoutMs?: number;
  };
}

export type CreateRunRequest = CreateSessionRunRequest;
