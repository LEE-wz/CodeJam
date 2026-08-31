import type { CoordinationAgentView } from "../contracts.js";
import type {
  CoordinationArtifact,
  CreateCoordinationRunRequest,
  FinalPayload,
  ProposalPayload,
  ReviewPayload,
} from "../types.js";
import { FIXED_NOW } from "./controls.js";

export const PLANNER_AGENT: CoordinationAgentView = {
  id: "agent-planner",
  name: "Relay Planner",
  status: "ready",
};

export const CRITIC_AGENT: CoordinationAgentView = {
  id: "agent-critic",
  name: "Relay Critic",
  status: "ready",
};

export const FINALIZER_AGENT: CoordinationAgentView = {
  id: "agent-finalizer",
  name: "Relay Finaliser",
  status: "ready",
};

export const COORDINATION_AGENTS = [
  PLANNER_AGENT,
  CRITIC_AGENT,
  FINALIZER_AGENT,
] as const;

export const OBJECTIVE = "Produce a practical launch plan for a student marketplace.";

export const REQUIRED_SECTIONS = [
  { key: "users", title: "Target Users" },
  { key: "workflow", title: "Core Workflow" },
  { key: "risks", title: "Risks and Mitigations" },
] as const;

export const CREATE_RUN_REQUEST: CreateCoordinationRunRequest = {
  name: "Launch plan review",
  objective: OBJECTIVE,
  requiredSections: REQUIRED_SECTIONS.map((section) => ({ ...section })),
  agents: {
    plannerAgentId: PLANNER_AGENT.id,
    criticAgentId: CRITIC_AGENT.id,
    finalizerAgentId: FINALIZER_AGENT.id,
  },
};

export const VALID_PROPOSAL_PAYLOAD: ProposalPayload = {
  schemaVersion: 1,
  type: "proposal",
  summary: "Launch with a focused student cohort and measured safeguards.",
  sections: [
    { key: "users", title: "Target Users", content: "University students." },
    { key: "workflow", title: "Core Workflow", content: "List, discover, and trade." },
    { key: "risks", title: "Risks and Mitigations", content: "Verify users and moderate listings." },
  ],
};

export const REJECTING_REVIEW_PAYLOAD: ReviewPayload = {
  schemaVersion: 1,
  type: "review",
  decision: "reject",
  issues: [
    {
      code: "RISK_DETAIL_MISSING",
      sectionKey: "risks",
      message: "Add a measurable response for fraudulent listings.",
    },
  ],
  feedback: "Strengthen the risks section before finalization.",
};

export const APPROVING_REVIEW_PAYLOAD: ReviewPayload = {
  schemaVersion: 1,
  type: "review",
  decision: "approve",
  issues: [],
  feedback: "The proposal covers every required section.",
};

export const VALID_FINAL_PAYLOAD: FinalPayload = {
  schemaVersion: 1,
  type: "final",
  title: "Student Marketplace Launch Plan",
  content: "A focused launch plan with user, workflow, and risk controls.",
};

const artifactBase = {
  runId: "run-0001",
  createdByAgentId: PLANNER_AGENT.id,
  sizeChars: 256,
  createdAt: FIXED_NOW,
};

export const VALID_PROPOSAL_ARTIFACT: Extract<CoordinationArtifact, { type: "proposal" }> = {
  ...artifactBase,
  id: "artifact-proposal",
  turnId: "turn-proposal",
  createdByRole: "planner",
  type: "proposal",
  payload: VALID_PROPOSAL_PAYLOAD,
};

export const REJECTING_REVIEW_ARTIFACT: Extract<CoordinationArtifact, { type: "review" }> = {
  ...artifactBase,
  id: "artifact-review-reject",
  turnId: "turn-review-reject",
  createdByRole: "critic",
  createdByAgentId: CRITIC_AGENT.id,
  type: "review",
  payload: REJECTING_REVIEW_PAYLOAD,
};

export const APPROVING_REVIEW_ARTIFACT: Extract<CoordinationArtifact, { type: "review" }> = {
  ...artifactBase,
  id: "artifact-review-approve",
  turnId: "turn-review-approve",
  createdByRole: "critic",
  createdByAgentId: CRITIC_AGENT.id,
  type: "review",
  payload: APPROVING_REVIEW_PAYLOAD,
};

export const VALID_FINAL_ARTIFACT: Extract<CoordinationArtifact, { type: "final" }> = {
  ...artifactBase,
  id: "artifact-final",
  turnId: "turn-final",
  createdByRole: "finalizer",
  createdByAgentId: FINALIZER_AGENT.id,
  type: "final",
  payload: VALID_FINAL_PAYLOAD,
};

export const VALID_PROPOSAL_OUTPUT = JSON.stringify(VALID_PROPOSAL_PAYLOAD);
export const REJECTING_REVIEW_OUTPUT = JSON.stringify(REJECTING_REVIEW_PAYLOAD);
export const APPROVING_REVIEW_OUTPUT = JSON.stringify(APPROVING_REVIEW_PAYLOAD);
export const VALID_FINAL_OUTPUT = JSON.stringify(VALID_FINAL_PAYLOAD);
export const INVALID_ARTIFACT_OUTPUT = '{"schemaVersion":1,"type":"proposal","sections":[]}';
