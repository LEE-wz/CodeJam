import { describe, expect, it } from "vitest";
import type { WorkflowView } from "./contracts.js";
import type {
  CoordinationArtifact,
  CoordinationRun,
  CoordinationTurn,
} from "./types.js";
import {
  selectLatestCommittedFinal,
  selectLatestCommittedProposal,
  selectLatestCommittedReview,
} from "./workflow.js";
import {
  APPROVING_REVIEW_ARTIFACT,
  VALID_FINAL_ARTIFACT,
  VALID_PROPOSAL_ARTIFACT,
} from "./testing/fixtures.js";

const run = {
  id: "run-0001",
} as CoordinationRun;

const committedTurn = (
  sequence: number,
  artifact: CoordinationArtifact,
): CoordinationTurn =>
  ({
    id: artifact.turnId,
    runId: artifact.runId,
    sequence,
    status: "committed",
    outputArtifactId: artifact.id,
  }) as CoordinationTurn;

const view = (
  artifacts: CoordinationArtifact[],
  turns: CoordinationTurn[],
): WorkflowView => ({ run, artifacts, turns });

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
