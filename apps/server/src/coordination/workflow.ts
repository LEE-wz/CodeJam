import type {
  VerifiedHandoffWorkflow,
  WorkflowDecision,
  WorkflowView,
} from "./contracts.js";
import type { ArtifactType, CoordinationArtifact } from "./types.js";

export type {
  VerifiedHandoffWorkflow,
  WorkflowDecision,
  WorkflowView,
} from "./contracts.js";

type ArtifactOfType<T extends ArtifactType> = Extract<
  CoordinationArtifact,
  { type: T }
>;

const selectLatestCommittedArtifact = <T extends ArtifactType>(
  view: WorkflowView,
  type: T,
): ArtifactOfType<T> | undefined => {
  const committedSequences = new Map(
    view.turns
      .filter((turn) => turn.runId === view.run.id && turn.status === "committed")
      .map((turn) => [turn.id, turn] as const),
  );

  let latest: { artifact: ArtifactOfType<T>; sequence: number } | undefined;
  for (const artifact of view.artifacts) {
    if (artifact.runId !== view.run.id || artifact.type !== type) continue;

    const turn = committedSequences.get(artifact.turnId);
    if (!turn || turn.outputArtifactId !== artifact.id) continue;

    if (!latest || turn.sequence > latest.sequence) {
      latest = { artifact: artifact as ArtifactOfType<T>, sequence: turn.sequence };
    }
  }

  return latest?.artifact;
};

export const selectLatestCommittedProposal = (
  view: WorkflowView,
): ArtifactOfType<"proposal"> | undefined =>
  selectLatestCommittedArtifact(view, "proposal");

export const selectLatestCommittedReview = (
  view: WorkflowView,
): ArtifactOfType<"review"> | undefined =>
  selectLatestCommittedArtifact(view, "review");

export const selectLatestCommittedFinal = (
  view: WorkflowView,
): ArtifactOfType<"final"> | undefined =>
  selectLatestCommittedArtifact(view, "final");

const committedSequence = (
  view: WorkflowView,
  artifact: CoordinationArtifact,
): number | undefined =>
  view.turns.find(
    (turn) =>
      turn.runId === view.run.id &&
      turn.id === artifact.turnId &&
      turn.status === "committed" &&
      turn.outputArtifactId === artifact.id,
  )?.sequence;

const invalidState = (message: string): WorkflowDecision => ({
  kind: "fail",
  code: "INVALID_STATE",
  message,
});

const validateView = (view: WorkflowView): WorkflowDecision | undefined => {
  if (view.run.status !== "running") {
    return invalidState("Workflow decisions require a running coordination run");
  }
  if (view.run.activeTurnId) {
    return invalidState("Workflow cannot schedule while a turn is active");
  }
  if (!Number.isInteger(view.run.nextTurnSequence) || view.run.nextTurnSequence < 1) {
    return invalidState("Run has an invalid next turn sequence");
  }
  if (!Number.isInteger(view.run.revision) || view.run.revision < 0) {
    return invalidState("Run has an invalid revision");
  }

  const turns = view.turns.filter((turn) => turn.runId === view.run.id);
  const artifacts = view.artifacts.filter((artifact) => artifact.runId === view.run.id);
  const turnIds = new Set<string>();
  const sequences = new Set<number>();
  for (const turn of turns) {
    if (
      turnIds.has(turn.id) ||
      !Number.isInteger(turn.sequence) ||
      turn.sequence < 1 ||
      sequences.has(turn.sequence)
    ) {
      return invalidState("Run has duplicate or invalid turn identity");
    }
    turnIds.add(turn.id);
    sequences.add(turn.sequence);
    if (turn.sequence >= view.run.nextTurnSequence) {
      return invalidState("Run next turn sequence does not follow existing turns");
    }
  }

  const artifactsById = new Map<string, CoordinationArtifact>();
  for (const artifact of artifacts) {
    if (artifactsById.has(artifact.id)) {
      return invalidState("Run has duplicate artifact identity");
    }
    artifactsById.set(artifact.id, artifact);
    const turn = turns.find((candidate) => candidate.id === artifact.turnId);
    if (
      !turn ||
      turn.status !== "committed" ||
      turn.outputArtifactId !== artifact.id
    ) {
      return invalidState("Artifact does not belong to its committed output turn");
    }
  }

  const expectedOutput = {
    initial_proposal: { role: "planner", type: "proposal" },
    proposal_revision: { role: "planner", type: "proposal" },
    proposal_review: { role: "critic", type: "review" },
    finalization: { role: "finalizer", type: "final" },
  } as const;
  for (const turn of turns) {
    if (turn.status !== "committed") continue;
    const artifact = turn.outputArtifactId
      ? artifactsById.get(turn.outputArtifactId)
      : undefined;
    const expected = expectedOutput[turn.kind];
    if (
      !artifact ||
      artifact.turnId !== turn.id ||
      turn.role !== expected.role ||
      artifact.createdByRole !== expected.role ||
      artifact.createdByAgentId !== turn.agentId ||
      artifact.type !== expected.type
    ) {
      return invalidState("Committed turn has an invalid role or artifact output");
    }
  }

  return undefined;
};

export class VerifiedHandoffWorkflowV1 implements VerifiedHandoffWorkflow {
  decideNext(view: WorkflowView): WorkflowDecision {
    const invalid = validateView(view);
    if (invalid) return invalid;

    const proposal = selectLatestCommittedProposal(view);
    const review = selectLatestCommittedReview(view);
    const finalArtifact = selectLatestCommittedFinal(view);

    const proposalSequence = proposal ? committedSequence(view, proposal) : undefined;
    const reviewSequence = review ? committedSequence(view, review) : undefined;
    const finalSequence = finalArtifact
      ? committedSequence(view, finalArtifact)
      : undefined;

    if (review && !proposal) {
      return invalidState("A review exists without a proposal");
    }

    if (finalArtifact) {
      if (
        !proposal ||
        !review ||
        review.payload.decision !== "approve" ||
        proposalSequence! >= reviewSequence! ||
        reviewSequence! >= finalSequence!
      ) {
        return invalidState("Final artifact does not follow an approving review");
      }
      return { kind: "complete", finalArtifactId: finalArtifact.id };
    }

    if (
      proposal &&
      review?.payload.decision === "approve" &&
      proposalSequence! > reviewSequence!
    ) {
      return invalidState("A proposal cannot supersede an approving review");
    }

    let decision: Extract<WorkflowDecision, { kind: "schedule" }>;
    if (!proposal) {
      decision = {
        kind: "schedule",
        role: "planner",
        turnKind: "initial_proposal",
        phase: "drafting",
        revision: view.run.revision,
        inputArtifactIds: [],
        expectedArtifactType: "proposal",
      };
    } else if (!review || proposalSequence! > reviewSequence!) {
      decision = {
        kind: "schedule",
        role: "critic",
        turnKind: "proposal_review",
        phase: "reviewing",
        revision: view.run.revision,
        inputArtifactIds: [proposal.id],
        expectedArtifactType: "review",
      };
    } else if (review.payload.decision === "reject") {
      if (view.run.revision >= view.run.policy.maxRevisions) {
        return {
          kind: "fail",
          code: "MAX_REVISIONS_EXCEEDED",
          message: "Coordination run reached its revision limit",
        };
      }
      decision = {
        kind: "schedule",
        role: "planner",
        turnKind: "proposal_revision",
        phase: "revising",
        revision: view.run.revision + 1,
        inputArtifactIds: [proposal.id, review.id],
        expectedArtifactType: "proposal",
      };
    } else {
      decision = {
        kind: "schedule",
        role: "finalizer",
        turnKind: "finalization",
        phase: "finalizing",
        revision: view.run.revision,
        inputArtifactIds: [proposal.id, review.id],
        expectedArtifactType: "final",
      };
    }

    if (view.run.nextTurnSequence > view.run.policy.maxTurns) {
      return {
        kind: "fail",
        code: "MAX_TURNS_EXCEEDED",
        message: "Coordination run reached its turn limit",
      };
    }
    return decision;
  }
}
