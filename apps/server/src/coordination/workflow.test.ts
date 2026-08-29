import { describe, expect, it } from "vitest";
import type { WorkflowView } from "./contracts.js";
import type {
  CoordinationArtifact,
  CoordinationRun,
  CoordinationTurn,
} from "./types.js";
import { DEFAULT_COORDINATION_POLICY } from "./types.js";
import {
  selectLatestCommittedFinal,
  selectLatestCommittedProposal,
  selectLatestCommittedReview,
  VerifiedHandoffWorkflowV1,
} from "./workflow.js";
import {
  APPROVING_REVIEW_ARTIFACT,
  REJECTING_REVIEW_ARTIFACT,
  VALID_FINAL_ARTIFACT,
  VALID_PROPOSAL_ARTIFACT,
} from "./testing/fixtures.js";

const run: CoordinationRun = {
  id: "run-0001",
  name: "Launch plan review",
  objective: "Produce a launch plan",
  requiredSections: [],
  participants: [],
  policy: { ...DEFAULT_COORDINATION_POLICY },
  status: "running",
  phase: "drafting",
  revision: 0,
  nextTurnSequence: 1,
  version: 1,
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

const committedTurn = (
  sequence: number,
  artifact: CoordinationArtifact,
): CoordinationTurn => ({
  id: artifact.turnId,
  runId: artifact.runId,
  sequence,
  role: artifact.createdByRole,
  agentId: artifact.createdByAgentId,
  kind:
    artifact.type === "proposal"
      ? "initial_proposal"
      : artifact.type === "review"
        ? "proposal_review"
        : "finalization",
  status: "committed",
  attemptCount: 1,
  inputArtifactIds: [],
  outputArtifactId: artifact.id,
  lastValidationErrors: [],
  createdAt: artifact.createdAt,
  completedAt: artifact.createdAt,
});

const view = (
  artifacts: CoordinationArtifact[],
  turns: CoordinationTurn[],
): WorkflowView => ({
  run: {
    ...run,
    nextTurnSequence:
      Math.max(0, ...turns.filter((turn) => turn.runId === run.id).map((turn) => turn.sequence)) +
      1,
  },
  artifacts,
  turns,
});

describe("latest committed artifact selectors", () => {
  it("returns undefined when no committed artifact has the requested type", () => {
    expect(selectLatestCommittedProposal(view([], []))).toBeUndefined();
    expect(
      selectLatestCommittedReview(
        view([VALID_PROPOSAL_ARTIFACT], [committedTurn(0, VALID_PROPOSAL_ARTIFACT)]),
      ),
    ).toBeUndefined();
  });

  it("selects the greatest committed turn sequence regardless of input or timestamp order", () => {
    const older = {
      ...VALID_PROPOSAL_ARTIFACT,
      id: "artifact-proposal-older",
      turnId: "turn-proposal-older",
      createdAt: "2099-01-01T00:00:00.000Z",
    };
    const latest = {
      ...VALID_PROPOSAL_ARTIFACT,
      id: "artifact-proposal-latest",
      turnId: "turn-proposal-latest",
      createdAt: "2000-01-01T00:00:00.000Z",
    };

    expect(
      selectLatestCommittedProposal(
        view(
          [latest, older],
          [committedTurn(4, latest), committedTurn(1, older)],
        ),
      )?.id,
    ).toBe(latest.id);
  });

  it("ignores uncommitted turns and turns that do not name the artifact as output", () => {
    const uncommitted = {
      ...VALID_PROPOSAL_ARTIFACT,
      id: "artifact-uncommitted",
      turnId: "turn-uncommitted",
    };
    const mismatched = {
      ...VALID_PROPOSAL_ARTIFACT,
      id: "artifact-mismatched",
      turnId: "turn-mismatched",
    };
    const validTurn = committedTurn(1, VALID_PROPOSAL_ARTIFACT);
    const uncommittedTurn = {
      ...committedTurn(3, uncommitted),
      status: "running" as const,
    };
    const mismatchedTurn = {
      ...committedTurn(2, mismatched),
      outputArtifactId: "another-artifact",
    };

    expect(
      selectLatestCommittedProposal(
        view(
          [uncommitted, mismatched, VALID_PROPOSAL_ARTIFACT],
          [uncommittedTurn, mismatchedTurn, validTurn],
        ),
      )?.id,
    ).toBe(VALID_PROPOSAL_ARTIFACT.id);
  });

  it("ignores cross-run records and selects each artifact type independently", () => {
    const otherRunFinal = {
      ...VALID_FINAL_ARTIFACT,
      id: "artifact-other-final",
      runId: "run-other",
      turnId: "turn-other-final",
    };

    const result = view(
      [otherRunFinal, APPROVING_REVIEW_ARTIFACT, VALID_FINAL_ARTIFACT],
      [
        committedTurn(9, otherRunFinal),
        committedTurn(3, APPROVING_REVIEW_ARTIFACT),
        committedTurn(4, VALID_FINAL_ARTIFACT),
      ],
    );

    expect(selectLatestCommittedReview(result)?.id).toBe(
      APPROVING_REVIEW_ARTIFACT.id,
    );
    expect(selectLatestCommittedFinal(result)?.id).toBe(VALID_FINAL_ARTIFACT.id);
    expect(selectLatestCommittedProposal(result)).toBeUndefined();
  });
});

const revisedProposal: CoordinationArtifact = {
  ...VALID_PROPOSAL_ARTIFACT,
  id: "artifact-proposal-revision",
  turnId: "turn-proposal-revision",
};

const withRun = (
  input: WorkflowView,
  overrides: Omit<Partial<CoordinationRun>, "policy"> & {
    policy?: Partial<CoordinationRun["policy"]>;
  },
): WorkflowView => ({
  ...input,
  run: {
    ...input.run,
    ...overrides,
    policy: { ...input.run.policy, ...overrides.policy },
  },
});

const proposalView = (): WorkflowView =>
  view(
    [VALID_PROPOSAL_ARTIFACT],
    [committedTurn(1, VALID_PROPOSAL_ARTIFACT)],
  );

const reviewView = (review: CoordinationArtifact): WorkflowView =>
  view(
    [VALID_PROPOSAL_ARTIFACT, review],
    [committedTurn(1, VALID_PROPOSAL_ARTIFACT), committedTurn(2, review)],
  );

const finalView = (review: CoordinationArtifact): WorkflowView =>
  view(
    [VALID_PROPOSAL_ARTIFACT, review, VALID_FINAL_ARTIFACT],
    [
      committedTurn(1, VALID_PROPOSAL_ARTIFACT),
      committedTurn(2, review),
      committedTurn(3, VALID_FINAL_ARTIFACT),
    ],
  );

describe("VerifiedHandoffWorkflowV1 routing decision table", () => {
  const workflow = new VerifiedHandoffWorkflowV1();
  const cases = [
    {
      name: "new run schedules Planner",
      input: () => view([], []),
      expected: {
        kind: "schedule",
        role: "planner",
        turnKind: "initial_proposal",
        phase: "drafting",
        revision: 0,
        inputArtifactIds: [],
        expectedArtifactType: "proposal",
      },
    },
    {
      name: "proposal schedules Critic",
      input: proposalView,
      expected: {
        kind: "schedule",
        role: "critic",
        turnKind: "proposal_review",
        phase: "reviewing",
        revision: 0,
        inputArtifactIds: [VALID_PROPOSAL_ARTIFACT.id],
        expectedArtifactType: "review",
      },
    },
    {
      name: "reject schedules Planner revision",
      input: () => reviewView(REJECTING_REVIEW_ARTIFACT),
      expected: {
        kind: "schedule",
        role: "planner",
        turnKind: "proposal_revision",
        phase: "revising",
        revision: 1,
        inputArtifactIds: [VALID_PROPOSAL_ARTIFACT.id, REJECTING_REVIEW_ARTIFACT.id],
        expectedArtifactType: "proposal",
      },
    },
    {
      name: "revised proposal schedules another Critic review",
      input: () =>
        withRun(
          view(
            [revisedProposal, REJECTING_REVIEW_ARTIFACT, VALID_PROPOSAL_ARTIFACT],
            [
              committedTurn(3, revisedProposal),
              committedTurn(2, REJECTING_REVIEW_ARTIFACT),
              committedTurn(1, VALID_PROPOSAL_ARTIFACT),
            ],
          ),
          { revision: 1 },
        ),
      expected: {
        kind: "schedule",
        role: "critic",
        turnKind: "proposal_review",
        phase: "reviewing",
        revision: 1,
        inputArtifactIds: [revisedProposal.id],
        expectedArtifactType: "review",
      },
    },
    {
      name: "approve schedules Finaliser",
      input: () => reviewView(APPROVING_REVIEW_ARTIFACT),
      expected: {
        kind: "schedule",
        role: "finalizer",
        turnKind: "finalization",
        phase: "finalizing",
        revision: 0,
        inputArtifactIds: [VALID_PROPOSAL_ARTIFACT.id, APPROVING_REVIEW_ARTIFACT.id],
        expectedArtifactType: "final",
      },
    },
    {
      name: "final artifact completes the run",
      input: () => finalView(APPROVING_REVIEW_ARTIFACT),
      expected: { kind: "complete", finalArtifactId: VALID_FINAL_ARTIFACT.id },
    },
    {
      name: "reject at revision limit fails",
      input: () =>
        withRun(reviewView(REJECTING_REVIEW_ARTIFACT), {
          revision: 2,
          policy: { maxRevisions: 2 },
        }),
      expected: { kind: "fail", code: "MAX_REVISIONS_EXCEEDED" },
    },
    {
      name: "schedule above turn limit fails",
      input: () => withRun(proposalView(), { policy: { maxTurns: 1 } }),
      expected: { kind: "fail", code: "MAX_TURNS_EXCEEDED" },
    },
    {
      name: "completion at turn limit remains valid",
      input: () =>
        withRun(finalView(APPROVING_REVIEW_ARTIFACT), {
          policy: { maxTurns: 3 },
        }),
      expected: { kind: "complete", finalArtifactId: VALID_FINAL_ARTIFACT.id },
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(workflow.decideNext(input())).toMatchObject(expected);
  });
});

describe("VerifiedHandoffWorkflowV1 invalid-state table", () => {
  const workflow = new VerifiedHandoffWorkflowV1();
  const cases = [
    {
      name: "non-running run",
      input: () => withRun(view([], []), { status: "completed" }),
    },
    {
      name: "active turn",
      input: () => withRun(view([], []), { activeTurnId: "turn-active" }),
    },
    {
      name: "invalid next sequence",
      input: () => withRun(view([], []), { nextTurnSequence: 0 }),
    },
    {
      name: "negative revision",
      input: () => withRun(view([], []), { revision: -1 }),
    },
    {
      name: "next sequence behind committed history",
      input: () => withRun(proposalView(), { nextTurnSequence: 1 }),
    },
    {
      name: "duplicate turn sequence",
      input: () =>
        view(
          [VALID_PROPOSAL_ARTIFACT, APPROVING_REVIEW_ARTIFACT],
          [
            committedTurn(1, VALID_PROPOSAL_ARTIFACT),
            committedTurn(1, APPROVING_REVIEW_ARTIFACT),
          ],
        ),
    },
    {
      name: "duplicate artifact identity",
      input: () =>
        view(
          [VALID_PROPOSAL_ARTIFACT, VALID_PROPOSAL_ARTIFACT],
          [committedTurn(1, VALID_PROPOSAL_ARTIFACT)],
        ),
    },
    {
      name: "artifact on uncommitted turn",
      input: () =>
        view(
          [VALID_PROPOSAL_ARTIFACT],
          [
            {
              ...committedTurn(1, VALID_PROPOSAL_ARTIFACT),
              status: "running",
            },
          ],
        ),
    },
    {
      name: "committed turn without its output artifact",
      input: () => view([], [committedTurn(1, VALID_PROPOSAL_ARTIFACT)]),
    },
    {
      name: "artifact role does not match turn",
      input: () =>
        view(
          [VALID_PROPOSAL_ARTIFACT],
          [
            {
              ...committedTurn(1, VALID_PROPOSAL_ARTIFACT),
              role: "critic",
            },
          ],
        ),
    },
    {
      name: "review without proposal",
      input: () =>
        view(
          [APPROVING_REVIEW_ARTIFACT],
          [committedTurn(1, APPROVING_REVIEW_ARTIFACT)],
        ),
    },
    {
      name: "final after rejecting review",
      input: () => finalView(REJECTING_REVIEW_ARTIFACT),
    },
    {
      name: "proposal supersedes approving review",
      input: () =>
        view(
          [revisedProposal, APPROVING_REVIEW_ARTIFACT, VALID_PROPOSAL_ARTIFACT],
          [
            committedTurn(3, revisedProposal),
            committedTurn(2, APPROVING_REVIEW_ARTIFACT),
            committedTurn(1, VALID_PROPOSAL_ARTIFACT),
          ],
        ),
    },
  ];

  it.each(cases)("$name fails safely", ({ input }) => {
    expect(workflow.decideNext(input())).toMatchObject({
      kind: "fail",
      code: "INVALID_STATE",
    });
  });
});
