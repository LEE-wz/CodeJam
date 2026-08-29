export type CoordinationRunId = string;
export type CoordinationTurnId = string;
export type CoordinationAttemptId = string;
export type CoordinationArtifactId = string;
export type CoordinationEventId = string;
export type AgentId = string;
export type AgentRunId = string;

export type CoordinationRole = "planner" | "critic" | "finalizer";
export type CoordinationPhase =
  | "drafting"
  | "reviewing"
  | "revising"
  | "finalizing"
  | "done";

export type CoordinationRunStatus =
  | "created"
  | "running"
  | "stop_requested"
  | "completed"
  | "failed"
  | "stopped";

export type CoordinationTurnKind =
  | "initial_proposal"
  | "proposal_revision"
  | "proposal_review"
  | "finalization";

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

export type ArtifactType = "proposal" | "review" | "final";
export type ReviewDecision = "approve" | "reject";

export type CoordinationErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "DUPLICATE_AGENT"
  | "AGENT_NOT_READY"
  | "AGENT_RESERVED"
  | "ACTIVE_RUN_CONFLICT"
  | "ATTEMPT_TIMED_OUT"
  | "AGENT_EXECUTION_FAILED"
  | "INVALID_AGENT_OUTPUT"
  | "OUTPUT_TOO_LARGE"
  | "MAX_ATTEMPTS_EXCEEDED"
  | "MAX_REVISIONS_EXCEEDED"
  | "MAX_TURNS_EXCEEDED"
  | "SERVER_RESTARTED"
  | "STOPPED_BY_USER"
  | "INTERNAL_ERROR";

export interface CoordinationParticipant {
  role: CoordinationRole;
  agentId: AgentId;
  agentNameSnapshot: string;
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

export const DEFAULT_COORDINATION_POLICY: CoordinationPolicy = {
  workflow: "verified_handoff_v1",
  maxRevisions: 2,
  maxTurns: 8,
  maxAttemptsPerTurn: 2,
  perAttemptTimeoutMs: 120_000,
  contextMaxChars: 12_000,
  outputMaxChars: 20_000,
};

export interface RequiredSection {
  key: string;
  title: string;
}

export interface CoordinationRun {
  id: CoordinationRunId;
  name: string;
  objective: string;
  requiredSections: RequiredSection[];
  participants: CoordinationParticipant[];
  policy: CoordinationPolicy;
  status: CoordinationRunStatus;
  phase: CoordinationPhase;
  revision: number;
  nextTurnSequence: number;
  activeTurnId?: CoordinationTurnId;
  latestProposalArtifactId?: CoordinationArtifactId;
  latestReviewArtifactId?: CoordinationArtifactId;
  finalArtifactId?: CoordinationArtifactId;
  version: number;
  errorCode?: CoordinationErrorCode;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  stoppedAt?: string;
}

export interface CoordinationTurn {
  id: CoordinationTurnId;
  runId: CoordinationRunId;
  sequence: number;
  role: CoordinationRole;
  agentId: AgentId;
  kind: CoordinationTurnKind;
  status: CoordinationTurnStatus;
  attemptCount: number;
  activeAttemptId?: CoordinationAttemptId;
  inputArtifactIds: CoordinationArtifactId[];
  outputArtifactId?: CoordinationArtifactId;
  lastValidationErrors: string[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CoordinationAttempt {
  id: CoordinationAttemptId;
  runId: CoordinationRunId;
  turnId: CoordinationTurnId;
  number: number;
  agentId: AgentId;
  leaseToken: string;
  status: CoordinationAttemptStatus;
  agentRunId?: AgentRunId;
  promptDigest?: string;
  outputDigest?: string;
  errorCode?: CoordinationErrorCode;
  errorMessage?: string;
  createdAt: string;
  finishedAt?: string;
}

export interface ProposalSection {
  key: string;
  title: string;
  content: string;
}

export interface ProposalPayload {
  schemaVersion: 1;
  type: "proposal";
  summary: string;
  sections: ProposalSection[];
}

export interface ReviewIssue {
  code: string;
  sectionKey?: string;
  message: string;
}

export interface ReviewPayload {
  schemaVersion: 1;
  type: "review";
  decision: ReviewDecision;
  issues: ReviewIssue[];
  feedback: string;
}

export interface FinalPayload {
  schemaVersion: 1;
  type: "final";
  title: string;
  content: string;
}

export type ArtifactPayload = ProposalPayload | ReviewPayload | FinalPayload;

export interface CoordinationArtifactBase {
  id: CoordinationArtifactId;
  runId: CoordinationRunId;
  turnId: CoordinationTurnId;
  createdByRole: CoordinationRole;
  createdByAgentId: AgentId;
  sizeChars: number;
  createdAt: string;
}

export type CoordinationArtifact =
  | (CoordinationArtifactBase & { type: "proposal"; payload: ProposalPayload })
  | (CoordinationArtifactBase & { type: "review"; payload: ReviewPayload })
  | (CoordinationArtifactBase & { type: "final"; payload: FinalPayload });

export type CoordinationEventType =
  | "run.created"
  | "run.started"
  | "turn.scheduled"
  | "attempt.started"
  | "attempt.invalid_output"
  | "attempt.timed_out"
  | "attempt.failed"
  | "attempt.cancelled"
  | "attempt.stale_ignored"
  | "turn.committed"
  | "review.approved"
  | "review.rejected"
  | "run.stop_requested"
  | "run.stopped"
  | "run.completed"
  | "run.failed"
  | "run.interrupted";

export type CoordinationEventActor =
  | { type: "system" }
  | { type: "user" }
  | { type: "agent"; agentId: AgentId; role: CoordinationRole };

export type SafeEventValue = string | number | boolean | null | string[];

export interface CoordinationEvent {
  id: CoordinationEventId;
  runId: CoordinationRunId;
  sequence: number;
  type: CoordinationEventType;
  actor: CoordinationEventActor;
  turnId?: CoordinationTurnId;
  attemptId?: CoordinationAttemptId;
  artifactId?: CoordinationArtifactId;
  message: string;
  details: Record<string, SafeEventValue>;
  createdAt: string;
}

export interface CoordinationRunDetails {
  run: CoordinationRun;
  turns: CoordinationTurn[];
  attempts: CoordinationAttempt[];
  artifacts: CoordinationArtifact[];
  events: CoordinationEvent[];
}

export interface RoleAgentSelection {
  plannerAgentId: AgentId;
  criticAgentId: AgentId;
  finalizerAgentId: AgentId;
}

export interface CreateCoordinationRunRequest {
  name: string;
  objective: string;
  requiredSections: RequiredSection[];
  agents: RoleAgentSelection;
  policy?:
    | {
        maxRevisions?: number | undefined;
        maxTurns?: number | undefined;
        perAttemptTimeoutMs?: number | undefined;
      }
    | undefined;
}

export interface ListCoordinationRunsResponse {
  runs: CoordinationRun[];
}

export interface GetCoordinationRunResponse extends CoordinationRunDetails {}

export interface CreateCoordinationRunResponse {
  run: CoordinationRun;
}

export interface StartCoordinationRunResponse {
  run: CoordinationRun;
  accepted: true;
}

export interface StopCoordinationRunResponse {
  run: CoordinationRun;
  accepted: true;
}

export interface ApiErrorResponse {
  error: {
    code: CoordinationErrorCode;
    message: string;
    fieldErrors?: Record<string, string[]>;
    requestId?: string;
  };
}
