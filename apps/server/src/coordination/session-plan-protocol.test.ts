/**
 * P14-09: the mechanical plan validator.
 *
 * Every rejection here is structural. The middleware never asks whether a plan
 * is a *good* plan -- whether the right Agent got the right job, or whether an
 * instruction is sensible -- only whether it is a well-formed, executable one.
 * Each rejection must also be retry-safe: it names the rule that failed and
 * never quotes the Agent's own text back into the prompt, because that text is
 * exactly the untrusted material the validator exists to refuse.
 */
import { describe, expect, it } from "vitest";
import type { ArtifactValidationResult } from "./contracts.js";
import { SharedSessionArtifactProtocol } from "./artifact-protocol.js";
import { RoleScopedContextBuilder } from "./context-builder.js";
import { DeterministicIdGenerator, FIXED_NOW, FixedClock } from "./testing/controls.js";
import {
  PARTICIPANT_ONE,
  PARTICIPANT_THREE,
  PARTICIPANT_TWO,
  SESSION_PARTICIPANTS,
  VALID_FREE_CHAT_OUTPUT,
  VALID_PARALLEL_PLAN_OUTPUT,
  VALID_SEQUENTIAL_PLAN_OUTPUT,
  fullRosterPlan,
  planAssignment,
  planPayload,
} from "./testing/session-fixtures.js";
import type {
  CoordinationAttempt,
  CoordinationRun,
  CoordinationTurn,
  SessionPlanAssignment,
} from "./types.js";
import { DEFAULT_COORDINATION_POLICY, SESSION_LIMITS } from "./types.js";

const planRun: CoordinationRun = {
  id: "run-session",
  name: "Session",
  objective: "Work together",
  requiredSections: [],
  participants: SESSION_PARTICIPANTS.map((agent) => ({
    role: "participant",
    agentId: agent.id,
    agentNameSnapshot: agent.name,
  })),
  policy: {
    ...DEFAULT_COORDINATION_POLICY,
    workflow: "shared_session_v1",
    sessionProtocol: "free_chat",
    sessionPlanning: "coordinator",
    maxTurns: 20,
  },
  status: "running",
  phase: "sessioning",
  revision: 0,
  nextTurnSequence: 2,
  activeTurnIds: [],
  version: 1,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
};

const planTurn: CoordinationTurn = {
  id: "turn-plan",
  runId: "run-session",
  sequence: 1,
  role: "participant",
  agentId: PARTICIPANT_ONE.id,
  kind: "session_plan",
  status: "running",
  attemptCount: 1,
  inputArtifactIds: [],
  lastValidationErrors: [],
  createdAt: FIXED_NOW,
};

const messageTurn: CoordinationTurn = { ...planTurn, id: "turn-message", kind: "session_turn" };

const attempt: CoordinationAttempt = {
  id: "attempt-plan",
  runId: "run-session",
  turnId: planTurn.id,
  number: 1,
  agentId: PARTICIPANT_ONE.id,
  leaseToken: "lease-plan",
  status: "running",
  createdAt: FIXED_NOW,
};

const protocol = new SharedSessionArtifactProtocol({
  clock: new FixedClock(),
  ids: new DeterministicIdGenerator(),
});

const validate = (
  rawOutput: string,
  turn: CoordinationTurn = planTurn,
): ArtifactValidationResult => protocol.validate({ run: planRun, turn, attempt, rawOutput });

const rejected = (result: ArtifactValidationResult) => {
  if (result.ok) throw new Error("Expected the plan to be rejected");
  return result;
};

const accepted = (result: ArtifactValidationResult) => {
  if (!result.ok) throw new Error(`Expected the plan to be accepted: ${result.errors[0]?.message}`);
  return result.artifact;
};

const planOutput = (
  mode: "sequential" | "parallel",
  assignments: SessionPlanAssignment[],
): string => JSON.stringify(planPayload(mode, assignments));

describe("session plan protocol: accepted plans", () => {
  it("accepts a valid sequential plan and builds provenance in backend code", () => {
    const artifact = accepted(validate(VALID_SEQUENTIAL_PLAN_OUTPUT));

    expect(artifact).toMatchObject({
      id: "artifact-0001",
      runId: "run-session",
      turnId: "turn-plan",
      type: "session_plan",
      createdByRole: "participant",
      createdByAgentId: PARTICIPANT_ONE.id,
      createdAt: FIXED_NOW,
    });
    expect(artifact.payload).toEqual({
      schemaVersion: 1,
      type: "session_plan",
      mode: "sequential",
      assignments: [
        { agentId: PARTICIPANT_ONE.id, position: 1, instruction: "Contribute step 1." },
        { agentId: PARTICIPANT_TWO.id, position: 2, instruction: "Contribute step 2." },
        { agentId: PARTICIPANT_THREE.id, position: 3, instruction: "Contribute step 3." },
      ],
    });
    // The raw output length is what was measured against outputMaxChars.
    expect(artifact.sizeChars).toBe(VALID_SEQUENTIAL_PLAN_OUTPUT.length);
  });

  it("accepts a valid parallel plan", () => {
    expect(accepted(validate(VALID_PARALLEL_PLAN_OUTPUT)).payload).toMatchObject({
      type: "session_plan",
      mode: "parallel",
    });
  });

  it("accepts a plan that assigns fewer participants than the roster holds", () => {
    const artifact = accepted(
      validate(planOutput("sequential", [planAssignment(PARTICIPANT_TWO, 1)])),
    );
    expect(artifact.payload).toMatchObject({ assignments: [{ position: 1 }] });
  });

  it("accepts positions given out of array order as long as they are contiguous", () => {
    const artifact = accepted(
      validate(
        planOutput("sequential", [
          planAssignment(PARTICIPANT_THREE, 3),
          planAssignment(PARTICIPANT_ONE, 1),
          planAssignment(PARTICIPANT_TWO, 2),
        ]),
      ),
    );
    // The protocol stores what the Agent proposed; the workflow orders it.
    expect(artifact.payload).toMatchObject({ assignments: [{ position: 3 }, { position: 1 }, { position: 2 }] });
  });

  it("strips exactly one enclosing JSON fence, as it does for every artifact", () => {
    const fenced = `\`\`\`json\n${VALID_SEQUENTIAL_PLAN_OUTPUT}\n\`\`\``;
    expect(accepted(validate(fenced)).payload).toMatchObject({ mode: "sequential" });
    // The raw length, not the unfenced length, is the recorded size.
    expect(accepted(validate(fenced)).sizeChars).toBe(fenced.length);
  });
});

describe("session plan protocol: structural rejections", () => {
  const expectRetrySafe = (result: ReturnType<typeof rejected>, ...forbidden: string[]) => {
    expect(result.code).toBe("INVALID_AGENT_OUTPUT");
    const rendered = result.errors.map((error) => `${error.path} ${error.code} ${error.message}`).join("\n");
    expect(rendered.trim().length).toBeGreaterThan(0);
    for (const value of forbidden) expect(rendered).not.toContain(value);
  };

  it("rejects an agentId that is not a participant without echoing it", () => {
    const result = rejected(
      validate(
        planOutput("sequential", [
          { agentId: "agent-not-in-this-session", position: 1, instruction: "Go." },
        ]),
      ),
    );
    expect(result.errors[0]).toMatchObject({ code: "unknown_participant" });
    // The forged id is Agent-supplied text and must never reach the retry prompt.
    expectRetrySafe(result, "agent-not-in-this-session");
  });

  it("rejects duplicate agent ids", () => {
    const result = rejected(
      validate(
        planOutput("parallel", [
          planAssignment(PARTICIPANT_ONE, 1),
          planAssignment(PARTICIPANT_ONE, 2),
        ]),
      ),
    );
    expect(result.errors.map(({ code }) => code)).toContain("duplicate_participant");
  });

  it("rejects positions that start at 0", () => {
    const result = rejected(
      validate(
        JSON.stringify({
          schemaVersion: 1,
          type: "session_plan",
          mode: "sequential",
          assignments: [
            { agentId: PARTICIPANT_ONE.id, position: 0, instruction: "First." },
            { agentId: PARTICIPANT_TWO.id, position: 1, instruction: "Second." },
          ],
        }),
      ),
    );
    // 0 is out of the schema's own bound, so this is refused before the
    // contiguity rule ever runs. Either way the plan never executes.
    expect(result.code).toBe("INVALID_AGENT_OUTPUT");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects positions with a gap", () => {
    const result = rejected(
      validate(
        planOutput("sequential", [
          planAssignment(PARTICIPANT_ONE, 1),
          planAssignment(PARTICIPANT_TWO, 3),
        ]),
      ),
    );
    expect(result.errors[0]).toMatchObject({
      code: "non_contiguous_positions",
      message: "Assignment positions must be contiguous from 1",
    });
  });

  it("rejects duplicated positions even when every participant is distinct", () => {
    const result = rejected(
      validate(
        planOutput("sequential", [
          planAssignment(PARTICIPANT_ONE, 1),
          planAssignment(PARTICIPANT_TWO, 1),
        ]),
      ),
    );
    expect(result.errors.map(({ code }) => code)).toContain("non_contiguous_positions");
  });

  it("rejects more assignments than the run has participants", () => {
    const roster = SESSION_PARTICIPANTS.length;
    const result = rejected(
      validate(
        JSON.stringify({
          schemaVersion: 1,
          type: "session_plan",
          mode: "parallel",
          assignments: Array.from({ length: roster + 1 }, (_unused, index) => ({
            agentId: SESSION_PARTICIPANTS[index % roster]!.id,
            position: index + 1,
            instruction: "Contribute.",
          })),
        }),
      ),
    );
    expect(result.errors.map(({ code }) => code)).toContain("too_many_assignments");
  });

  it("rejects a plan with zero assignments", () => {
    const result = rejected(validate(planOutput("parallel", [])));
    expect(result.code).toBe("INVALID_AGENT_OUTPUT");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects an oversized instruction", () => {
    const result = rejected(
      validate(
        planOutput("sequential", [
          {
            agentId: PARTICIPANT_ONE.id,
            position: 1,
            instruction: "x".repeat(SESSION_LIMITS.planInstructionMaxChars + 1),
          },
        ]),
      ),
    );
    expect(result.code).toBe("INVALID_AGENT_OUTPUT");
    expect(result.errors[0]?.path).toContain("assignments");
  });

  it("rejects an empty instruction", () => {
    const result = rejected(
      validate(
        planOutput("sequential", [
          { agentId: PARTICIPANT_ONE.id, position: 1, instruction: "   " },
        ]),
      ),
    );
    expect(result.code).toBe("INVALID_AGENT_OUTPUT");
  });

  it("rejects an unrecognised mode", () => {
    const result = rejected(
      validate(
        JSON.stringify({
          schemaVersion: 1,
          type: "session_plan",
          mode: "broadcast",
          assignments: [{ agentId: PARTICIPANT_ONE.id, position: 1, instruction: "Go." }],
        }),
      ),
    );
    expect(result.code).toBe("INVALID_AGENT_OUTPUT");
  });

  it("rejects a prose-wrapped plan and never mines prose for an object", () => {
    const result = rejected(validate(`Here is my plan!\n${VALID_SEQUENTIAL_PLAN_OUTPUT}`));
    expect(result.errors[0]).toMatchObject({ code: "invalid_json" });
  });

  it("rejects unknown fields at the plan root and inside an assignment", () => {
    const root = rejected(
      validate(
        JSON.stringify({ ...fullRosterPlan("parallel"), priority: "high" }),
      ),
    );
    expect(root.code).toBe("INVALID_AGENT_OUTPUT");

    const nested = rejected(
      validate(
        JSON.stringify({
          schemaVersion: 1,
          type: "session_plan",
          mode: "parallel",
          assignments: [
            { agentId: PARTICIPANT_ONE.id, position: 1, instruction: "Go.", role: "planner" },
          ],
        }),
      ),
    );
    expect(nested.code).toBe("INVALID_AGENT_OUTPUT");
  });

  it("rejects an unsupported schema version before the bounded schema", () => {
    const result = rejected(
      validate(JSON.stringify({ ...fullRosterPlan("parallel"), schemaVersion: 2 })),
    );
    expect(result.errors[0]).toMatchObject({ code: "unsupported_schema_version" });
  });
});

describe("session plan protocol: the backend owns which artifact a turn produces", () => {
  it("rejects a plan offered for a turn that expected a session message", () => {
    const result = rejected(validate(VALID_SEQUENTIAL_PLAN_OUTPUT, messageTurn));
    expect(result.errors[0]).toMatchObject({
      code: "unexpected_artifact_type",
      message: 'This turn must produce an artifact of type "session_message"',
    });
  });

  it("rejects a session message offered for a plan turn", () => {
    const result = rejected(validate(VALID_FREE_CHAT_OUTPUT, planTurn));
    expect(result.errors[0]).toMatchObject({
      code: "unexpected_artifact_type",
      message: 'This turn must produce an artifact of type "session_plan"',
    });
  });

  it("refuses a plan on a run that is not a shared session", () => {
    const result = protocol.validate({
      run: { ...planRun, policy: { ...planRun.policy, workflow: "verified_handoff_v1" } },
      turn: planTurn,
      attempt,
      rawOutput: VALID_SEQUENTIAL_PLAN_OUTPUT,
    });
    expect(result.ok).toBe(false);
  });
});

describe("session plan protocol: rejections reach the Agent through the ordinary retry path", () => {
  /**
   * The retry contract is the one the context builder already implements: the
   * service puts the validator's messages on `turn.lastValidationErrors`, and
   * the builder renders exactly those and nothing else from the failed attempt.
   */
  it("renders a plan rejection as retry feedback without leaking the rejected output", () => {
    const rejection = rejected(
      validate(
        planOutput("sequential", [
          planAssignment(PARTICIPANT_ONE, 1),
          planAssignment(PARTICIPANT_TWO, 3),
        ]),
      ),
    );
    const messages = rejection.errors.map(({ message }) => message);

    const envelope = new RoleScopedContextBuilder().build({
      run: planRun,
      turn: { ...planTurn, attemptCount: 2, lastValidationErrors: messages },
      artifacts: [],
      retryValidationErrors: messages,
    });

    expect(envelope.prompt).toContain("Assignment positions must be contiguous from 1");
    expect(envelope.prompt).toContain("[YOUR TASK]");
    // The prompt carries the rule that failed, never the rejected plan itself.
    expect(envelope.prompt).not.toContain('"position":3');
    expect(envelope.prompt).not.toContain("lease-plan");
  });
});
