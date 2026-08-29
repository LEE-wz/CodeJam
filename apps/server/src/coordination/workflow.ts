import type { WorkflowView } from "./contracts.js";
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
