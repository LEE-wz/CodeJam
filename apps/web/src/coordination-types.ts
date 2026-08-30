export type CoordinationRole = "planner" | "critic" | "finalizer";
export type CoordinationPhase = "drafting" | "reviewing" | "revising" | "finalizing" | "done";
export type CoordinationRunStatus = "created" | "running" | "stop_requested" | "completed" | "failed" | "stopped";
export type CoordinationTurnKind = "initial_proposal" | "proposal_revision" | "proposal_review" | "finalization";
export type CoordinationTurnStatus = "scheduled" | "running" | "committed" | "failed" | "cancelled";
export type CoordinationAttemptStatus = "running" | "succeeded" | "invalid_output" | "timed_out" | "failed" | "cancelled" | "stale_ignored";
export type CoordinationEventType =
  | "run.created" | "run.started" | "turn.scheduled" | "attempt.started"
  | "attempt.invalid_output" | "attempt.timed_out" | "attempt.failed"
  | "attempt.cancelled" | "attempt.stale_ignored" | "turn.committed"
  | "review.approved" | "review.rejected" | "run.stop_requested"
  | "run.stopped" | "run.completed" | "run.failed" | "run.interrupted";

export interface RequiredSection {
  key: string;
  title: string;
}

export interface CoordinationPolicy {
  workflow: "verified_handoff_v1";
  maxRevisions: number;
  maxTurns: number;
  maxAttemptsPerTurn: number;
  perAttemptTimeoutMs: number;
  contextMaxChars: number;
  outputMaxChars: number;
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
  activeTurnId?: string;
  latestProposalArtifactId?: string;
  latestReviewArtifactId?: string;
  finalArtifactId?: string;
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

export interface CoordinationArtifact {
  id: string;
  runId: string;
  turnId: string;
  createdByRole: CoordinationRole;
  createdByAgentId: string;
  sizeChars: number;
  createdAt: string;
  type: "proposal" | "review" | "final";
  payload: ProposalPayload | ReviewPayload | FinalPayload;
}

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
}

export interface CreateCoordinationRunRequest {
  name: string;
  objective: string;
  requiredSections: RequiredSection[];
  agents: {
    plannerAgentId: string;
    criticAgentId: string;
    finalizerAgentId: string;
  };
  policy?: {
    maxRevisions?: number;
    maxTurns?: number;
    perAttemptTimeoutMs?: number;
  };
}
