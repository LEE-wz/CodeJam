import { describe, expect, it } from "vitest";
import type { ArtifactValidationResult } from "./contracts.js";
import {
  EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND,
  VerifiedHandoffArtifactProtocol,
} from "./artifact-protocol.js";
import type {
  CoordinationAttempt,
  CoordinationRun,
  CoordinationTurn,
  CoordinationTurnKind,
} from "./types.js";
import { DEFAULT_COORDINATION_POLICY } from "./types.js";
import { DeterministicIdGenerator, FIXED_NOW, FixedClock } from "./testing/controls.js";
import {
  APPROVING_REVIEW_OUTPUT,
  CRITIC_AGENT,
  FINALIZER_AGENT,
  INVALID_ARTIFACT_OUTPUT,
  OBJECTIVE,
  PLANNER_AGENT,
  REJECTING_REVIEW_OUTPUT,
  REQUIRED_SECTIONS,
  VALID_FINAL_OUTPUT,
  VALID_PROPOSAL_OUTPUT,
  VALID_PROPOSAL_PAYLOAD,
} from "./testing/fixtures.js";

const run: CoordinationRun = {
  id: "run-0001",
  name: "Launch plan review",
  objective: OBJECTIVE,
  requiredSections: REQUIRED_SECTIONS.map((section) => ({ ...section })),
  participants: [
    { role: "planner", agentId: PLANNER_AGENT.id, agentNameSnapshot: PLANNER_AGENT.name },
    { role: "critic", agentId: CRITIC_AGENT.id, agentNameSnapshot: CRITIC_AGENT.name },
    {
      role: "finalizer",
      agentId: FINALIZER_AGENT.id,
      agentNameSnapshot: FINALIZER_AGENT.name,
    },
  ],
  policy: { ...DEFAULT_COORDINATION_POLICY },
  status: "running",
  phase: "drafting",
  revision: 0,
  nextTurnSequence: 2,
  version: 1,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
};

const TURN_OWNER = {
  initial_proposal: { role: "planner", agentId: PLANNER_AGENT.id },
  proposal_revision: { role: "planner", agentId: PLANNER_AGENT.id },
  proposal_review: { role: "critic", agentId: CRITIC_AGENT.id },
  finalization: { role: "finalizer", agentId: FINALIZER_AGENT.id },
} as const;

const turnFor = (kind: CoordinationTurnKind): CoordinationTurn => ({
  id: `turn-${kind}`,
  runId: run.id,
  sequence: 1,
  role: TURN_OWNER[kind].role,
  agentId: TURN_OWNER[kind].agentId,
  kind,
  status: "running",
  attemptCount: 1,
  inputArtifactIds: [],
  lastValidationErrors: [],
  createdAt: FIXED_NOW,
});

const attemptFor = (turn: CoordinationTurn): CoordinationAttempt => ({
  id: "attempt-0001",
  runId: run.id,
  turnId: turn.id,
  number: 1,
  agentId: turn.agentId,
  leaseToken: "lease-0001",
  status: "running",
  createdAt: FIXED_NOW,
});

const validate = (
  kind: CoordinationTurnKind,
  rawOutput: string,
  overrides?: Partial<CoordinationRun>,
): ArtifactValidationResult => {
  const turn = turnFor(kind);
  const protocol = new VerifiedHandoffArtifactProtocol({
    clock: new FixedClock(),
    ids: new DeterministicIdGenerator(),
  });
  return protocol.validate({
    run: { ...run, ...overrides },
    turn,
    attempt: attemptFor(turn),
    rawOutput,
  });
};

const expectAccepted = (result: ArtifactValidationResult) => {
  if (!result.ok) {
    throw new Error(
      `expected an accepted artifact, received ${result.code}: ${result.errors
        .map((error) => `${error.path}/${error.code}`)
        .join(", ")}`,
    );
  }
  return result.artifact;
};

const expectRejected = (result: ArtifactValidationResult) => {
  if (result.ok) {
    throw new Error("expected the output to be rejected");
  }
  return result;
};

const codesAndPaths = (result: ArtifactValidationResult) =>
  expectRejected(result).errors.map((error) => `${error.path}/${error.code}`);

const fenced = (body: string, info = "json"): string => `\`\`\`${info}\n${body}\n\`\`\``;

describe("artifact protocol: expected type by turn kind", () => {
  it("maps every turn kind to the artifact type the backend requires", () => {
    expect(EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND).toEqual({
      initial_proposal: "proposal",
      proposal_revision: "proposal",
      proposal_review: "review",
      finalization: "final",
    });
  });

  it("accepts the valid output for each turn kind", () => {
    expect(expectAccepted(validate("initial_proposal", VALID_PROPOSAL_OUTPUT)).type).toBe(
      "proposal",
    );
    expect(expectAccepted(validate("proposal_revision", VALID_PROPOSAL_OUTPUT)).type).toBe(
      "proposal",
    );
    expect(expectAccepted(validate("proposal_review", REJECTING_REVIEW_OUTPUT)).type).toBe(
      "review",
    );
    expect(expectAccepted(validate("proposal_review", APPROVING_REVIEW_OUTPUT)).type).toBe(
      "review",
    );
    expect(expectAccepted(validate("finalization", VALID_FINAL_OUTPUT)).type).toBe("final");
  });

  it("rejects a well-formed artifact of the wrong type for the turn", () => {
    expect(codesAndPaths(validate("proposal_review", VALID_PROPOSAL_OUTPUT))).toEqual([
      "type/unexpected_artifact_type",
    ]);
    expect(codesAndPaths(validate("finalization", APPROVING_REVIEW_OUTPUT))).toEqual([
      "type/unexpected_artifact_type",
    ]);
    expect(codesAndPaths(validate("initial_proposal", VALID_FINAL_OUTPUT))).toEqual([
      "type/unexpected_artifact_type",
    ]);
  });
});

describe("artifact protocol: parsing order", () => {
  it("rejects oversize output before parsing it", () => {
    const oversize = "x".repeat(DEFAULT_COORDINATION_POLICY.outputMaxChars + 1);
    const result = expectRejected(validate("initial_proposal", oversize));

    expect(result.code).toBe("OUTPUT_TOO_LARGE");
    expect(result.errors).toEqual([
      {
        path: "output",
        code: "output_too_large",
        message: `Agent output exceeds the ${DEFAULT_COORDINATION_POLICY.outputMaxChars} character limit`,
      },
    ]);
  });

  it("reports the size limit rather than schema errors for oversize valid JSON", () => {
    const oversize = JSON.stringify({
      schemaVersion: 1,
      type: "proposal",
      summary: "y".repeat(DEFAULT_COORDINATION_POLICY.outputMaxChars),
      sections: [],
    });
    expect(oversize.length).toBeGreaterThan(DEFAULT_COORDINATION_POLICY.outputMaxChars);

    expect(expectRejected(validate("initial_proposal", oversize)).code).toBe(
      "OUTPUT_TOO_LARGE",
    );
  });

  it("measures the size limit against the run policy", () => {
    const output = VALID_PROPOSAL_OUTPUT;

    expect(
      expectRejected(
        validate("initial_proposal", output, {
          policy: { ...DEFAULT_COORDINATION_POLICY, outputMaxChars: output.length - 1 },
        }),
      ).code,
    ).toBe("OUTPUT_TOO_LARGE");
    expect(
      expectAccepted(
        validate("initial_proposal", output, {
          policy: { ...DEFAULT_COORDINATION_POLICY, outputMaxChars: output.length },
        }),
      ).type,
    ).toBe("proposal");
  });

  it("accepts surrounding whitespace and exactly one outer JSON code fence", () => {
    expect(
      expectAccepted(validate("initial_proposal", `\n\n  ${VALID_PROPOSAL_OUTPUT}  \n`)).type,
    ).toBe("proposal");
    expect(
      expectAccepted(validate("initial_proposal", fenced(VALID_PROPOSAL_OUTPUT))).type,
    ).toBe("proposal");
    expect(
      expectAccepted(validate("initial_proposal", fenced(VALID_PROPOSAL_OUTPUT, ""))).type,
    ).toBe("proposal");
    expect(
      expectAccepted(
        validate("initial_proposal", `  ${fenced(VALID_PROPOSAL_OUTPUT, "JSON")}  `),
      ).type,
    ).toBe("proposal");
  });

  it("does not extract JSON from surrounding commentary", () => {
    const cases = [
      `Here is the proposal:\n${VALID_PROPOSAL_OUTPUT}`,
      `${VALID_PROPOSAL_OUTPUT}\nLet me know if that works.`,
      `Sure!\n${fenced(VALID_PROPOSAL_OUTPUT)}`,
      `${fenced(VALID_PROPOSAL_OUTPUT)}\nHope that helps.`,
    ];

    for (const raw of cases) {
      expect(codesAndPaths(validate("initial_proposal", raw))).toEqual([
        "output/invalid_json",
      ]);
    }
  });

  it("strips only one outer fence and only a json info string", () => {
    const twoFences = `${fenced(VALID_PROPOSAL_OUTPUT)}\n${fenced(VALID_PROPOSAL_OUTPUT)}`;

    expect(codesAndPaths(validate("initial_proposal", twoFences))).toEqual([
      "output/invalid_json",
    ]);
    expect(
      codesAndPaths(validate("initial_proposal", fenced(VALID_PROPOSAL_OUTPUT, "javascript"))),
    ).toEqual(["output/invalid_json"]);
  });

  it("rejects malformed JSON and JSON that is not one object", () => {
    expect(codesAndPaths(validate("initial_proposal", ""))).toEqual([
      "output/invalid_json",
    ]);
    expect(codesAndPaths(validate("initial_proposal", "{ not json }"))).toEqual([
      "output/invalid_json",
    ]);
    expect(
      codesAndPaths(validate("initial_proposal", `[${VALID_PROPOSAL_OUTPUT}]`)),
    ).toEqual(["output/not_an_object"]);
    expect(codesAndPaths(validate("initial_proposal", "null"))).toEqual([
      "output/not_an_object",
    ]);
    expect(codesAndPaths(validate("initial_proposal", '"proposal"'))).toEqual([
      "output/not_an_object",
    ]);
  });

  it("checks the artifact type before the schema version", () => {
    const wrongTypeAndVersion = JSON.stringify({
      schemaVersion: 2,
      type: "review",
      sections: [],
    });

    expect(codesAndPaths(validate("initial_proposal", wrongTypeAndVersion))).toEqual([
      "type/unexpected_artifact_type",
    ]);
  });

  it("checks the schema version before the bounded schema", () => {
    const futureVersion = JSON.stringify({
      schemaVersion: 2,
      type: "proposal",
      sections: [],
    });

    expect(codesAndPaths(validate("initial_proposal", futureVersion))).toEqual([
      "schemaVersion/unsupported_schema_version",
    ]);
  });

  it("reports bounded schema failures with concise field paths", () => {
    const paths = codesAndPaths(validate("initial_proposal", INVALID_ARTIFACT_OUTPUT));

    expect(paths).toContain("summary/invalid_type");
    expect(paths).toContain("sections/too_small");
    expect(expectRejected(validate("initial_proposal", INVALID_ARTIFACT_OUTPUT)).code).toBe(
      "INVALID_AGENT_OUTPUT",
    );
  });

  it("reports nested schema failures with indexed paths", () => {
    const badSectionKey = JSON.stringify({
      ...VALID_PROPOSAL_PAYLOAD,
      sections: [{ key: "Not A Slug", title: "Target Users", content: "Students." }],
    });

    expect(codesAndPaths(validate("initial_proposal", badSectionKey))).toEqual([
      "sections[0].key/invalid_format",
    ]);
  });

  it("rejects unknown fields at the artifact root", () => {
    const withUnknownField = JSON.stringify({
      ...VALID_PROPOSAL_PAYLOAD,
      id: "artifact-supplied-by-agent",
    });

    expect(codesAndPaths(validate("initial_proposal", withUnknownField))).toEqual([
      "output/unrecognized_keys",
    ]);
  });
});

describe("artifact protocol: accepted artifact", () => {
  it("constructs identity and provenance in backend code", () => {
    const artifact = expectAccepted(
      validate("proposal_review", REJECTING_REVIEW_OUTPUT),
    );

    expect(artifact).toEqual({
      id: "artifact-0001",
      runId: run.id,
      turnId: "turn-proposal_review",
      createdByRole: "critic",
      createdByAgentId: CRITIC_AGENT.id,
      sizeChars: REJECTING_REVIEW_OUTPUT.length,
      createdAt: FIXED_NOW,
      type: "review",
      payload: JSON.parse(REJECTING_REVIEW_OUTPUT),
    });
  });

  it("records the raw output length even when the output was fenced", () => {
    const raw = fenced(VALID_FINAL_OUTPUT);
    const artifact = expectAccepted(validate("finalization", raw));

    expect(artifact.sizeChars).toBe(raw.length);
    expect(artifact.createdByRole).toBe("finalizer");
    expect(artifact.createdByAgentId).toBe(FINALIZER_AGENT.id);
  });

  it("stores the normalized parsed payload rather than the raw model text", () => {
    const padded = JSON.stringify({
      schemaVersion: 1,
      type: "final",
      title: "  Student Marketplace Launch Plan  ",
      content: "  A focused launch plan.  ",
    });
    const artifact = expectAccepted(validate("finalization", padded));

    expect(artifact.payload).toEqual({
      schemaVersion: 1,
      type: "final",
      title: "Student Marketplace Launch Plan",
      content: "A focused launch plan.",
    });
  });
});
