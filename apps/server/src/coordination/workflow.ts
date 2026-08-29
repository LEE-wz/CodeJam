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

export class VerifiedHandoffWorkflowV1 implements VerifiedHandoffWorkflow {
  decideNext(view: WorkflowView): WorkflowDecision {
    const proposal = selectLatestCommittedProposal(view);
    const review = selectLatestCommittedReview(view);
    const finalArtifact = selectLatestCommittedFinal(view);

    if (finalArtifact) {
      return { kind: "complete", finalArtifactId: finalArtifact.id };
    }

    if (!proposal) {
      return {
        kind: "schedule",
        role: "planner",
        turnKind: "initial_proposal",
        phase: "drafting",
        revision: view.run.revision,
        inputArtifactIds: [],
        expectedArtifactType: "proposal",
      };
    }

    const proposalSequence = committedSequence(view, proposal);
    const reviewSequence = review ? committedSequence(view, review) : undefined;
    if (!review || proposalSequence! > reviewSequence!) {
      return {
        kind: "schedule",
        role: "critic",
        turnKind: "proposal_review",
        phase: "reviewing",
        revision: view.run.revision,
        inputArtifactIds: [proposal.id],
        expectedArtifactType: "review",
      };
    }

    if (review.payload.decision === "reject") {
      return {
        kind: "schedule",
        role: "planner",
        turnKind: "proposal_revision",
        phase: "revising",
        revision: view.run.revision + 1,
        inputArtifactIds: [proposal.id, review.id],
        expectedArtifactType: "proposal",
      };
    }

    return {
      kind: "schedule",
      role: "finalizer",
      turnKind: "finalization",
      phase: "finalizing",
      revision: view.run.revision,
      inputArtifactIds: [proposal.id, review.id],
      expectedArtifactType: "final",
    };
  }
}
