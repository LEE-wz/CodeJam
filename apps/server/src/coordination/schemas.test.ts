import { describe, expect, it } from "vitest";
import {
  APPROVING_REVIEW_PAYLOAD,
  REJECTING_REVIEW_PAYLOAD,
  VALID_FINAL_PAYLOAD,
  VALID_PROPOSAL_PAYLOAD,
} from "./testing/fixtures.js";
import {
  ARTIFACT_SCHEMA_LIMITS,
  BID_SCHEMA_LIMITS,
  finalPayloadSchema,
  proposalPayloadSchema,
  reviewPayloadSchema,
  sessionBidPayloadSchema,
  sessionMessagePayloadSchema,
  userMessagePayloadSchema,
} from "./schemas.js";
import { SESSION_LIMITS } from "./types.js";

const repeated = (length: number): string => "x".repeat(length);

const bidPayload = () => ({
  schemaVersion: 1 as const,
  type: "session_bid" as const,
  recommendation: "direct" as const,
  candidateAnswer: "Candidate",
  plan: {
    summary: "Plan",
    mode: "single" as const,
    assignments: [{ agentId: "agent-one", position: 1, instruction: "Execute" }],
    risks: ["Risk"],
    assumptions: ["Assumption"],
  },
  confidenceBps: 8_000,
  estimatedOutputTokens: 1_000,
});

describe("artifact payload schemas", () => {
  it("parses the valid proposal, rejecting review, approving review, and final fixtures", () => {
    expect(proposalPayloadSchema.safeParse(VALID_PROPOSAL_PAYLOAD).success).toBe(true);
    expect(reviewPayloadSchema.safeParse(REJECTING_REVIEW_PAYLOAD).success).toBe(true);
    expect(reviewPayloadSchema.safeParse(APPROVING_REVIEW_PAYLOAD).success).toBe(true);
    expect(finalPayloadSchema.safeParse(VALID_FINAL_PAYLOAD).success).toBe(true);
  });

  it("trims every textual field in parsed output", () => {
    const result = proposalPayloadSchema.parse({
      schemaVersion: 1,
      type: "proposal",
      summary: " summary ",
      sections: [{ key: " users ", title: " Users ", content: " Content " }],
    });

    expect(result).toEqual({
      schemaVersion: 1,
      type: "proposal",
      summary: "summary",
      sections: [{ key: "users", title: "Users", content: "Content" }],
    });
  });

  it.each([
    {
      name: "proposal summary",
      limit: ARTIFACT_SCHEMA_LIMITS.proposalSummaryChars,
      parse: (value: string) =>
        proposalPayloadSchema.safeParse({ ...VALID_PROPOSAL_PAYLOAD, summary: value }),
    },
    {
      name: "proposal section key",
      limit: ARTIFACT_SCHEMA_LIMITS.keyChars,
      parse: (value: string) =>
        proposalPayloadSchema.safeParse({
          ...VALID_PROPOSAL_PAYLOAD,
          sections: [{ ...VALID_PROPOSAL_PAYLOAD.sections[0], key: value }],
        }),
    },
    {
      name: "proposal section title",
      limit: ARTIFACT_SCHEMA_LIMITS.titleChars,
      parse: (value: string) =>
        proposalPayloadSchema.safeParse({
          ...VALID_PROPOSAL_PAYLOAD,
          sections: [{ ...VALID_PROPOSAL_PAYLOAD.sections[0], title: value }],
        }),
    },
    {
      name: "proposal section content",
      limit: ARTIFACT_SCHEMA_LIMITS.proposalSectionContentChars,
      parse: (value: string) =>
        proposalPayloadSchema.safeParse({
          ...VALID_PROPOSAL_PAYLOAD,
          sections: [{ ...VALID_PROPOSAL_PAYLOAD.sections[0], content: value }],
        }),
    },
    {
      name: "review issue code",
      limit: ARTIFACT_SCHEMA_LIMITS.keyChars,
      parse: (value: string) =>
        reviewPayloadSchema.safeParse({
          ...REJECTING_REVIEW_PAYLOAD,
          issues: [{ ...REJECTING_REVIEW_PAYLOAD.issues[0], code: value }],
        }),
    },
    {
      name: "review issue message",
      limit: ARTIFACT_SCHEMA_LIMITS.reviewIssueMessageChars,
      parse: (value: string) =>
        reviewPayloadSchema.safeParse({
          ...REJECTING_REVIEW_PAYLOAD,
          issues: [{ ...REJECTING_REVIEW_PAYLOAD.issues[0], message: value }],
        }),
    },
    {
      name: "review issue section key",
      limit: ARTIFACT_SCHEMA_LIMITS.keyChars,
      parse: (value: string) =>
        reviewPayloadSchema.safeParse({
          ...REJECTING_REVIEW_PAYLOAD,
          issues: [{ ...REJECTING_REVIEW_PAYLOAD.issues[0], sectionKey: value }],
        }),
    },
    {
      name: "review feedback",
      limit: ARTIFACT_SCHEMA_LIMITS.reviewFeedbackChars,
      parse: (value: string) =>
        reviewPayloadSchema.safeParse({ ...APPROVING_REVIEW_PAYLOAD, feedback: value }),
    },
    {
      name: "final title",
      limit: ARTIFACT_SCHEMA_LIMITS.titleChars,
      parse: (value: string) =>
        finalPayloadSchema.safeParse({ ...VALID_FINAL_PAYLOAD, title: value }),
    },
    {
      name: "final content",
      limit: ARTIFACT_SCHEMA_LIMITS.finalContentChars,
      parse: (value: string) =>
        finalPayloadSchema.safeParse({ ...VALID_FINAL_PAYLOAD, content: value }),
    },
  ])("accepts $name at its limit and rejects one character over", ({ limit, parse }) => {
    expect(parse(repeated(limit)).success).toBe(true);
    expect(parse(repeated(limit + 1)).success).toBe(false);
    expect(parse("   ").success).toBe(false);
  });

  it("enforces proposal and review array bounds", () => {
    const section = VALID_PROPOSAL_PAYLOAD.sections[0];
    const issue = REJECTING_REVIEW_PAYLOAD.issues[0];

    expect(
      proposalPayloadSchema.safeParse({ ...VALID_PROPOSAL_PAYLOAD, sections: [] }).success,
    ).toBe(false);
    expect(
      proposalPayloadSchema.safeParse({
        ...VALID_PROPOSAL_PAYLOAD,
        sections: Array.from(
          { length: ARTIFACT_SCHEMA_LIMITS.proposalSections },
          (_, index) => ({ ...section, key: `section-${index}` }),
        ),
      }).success,
    ).toBe(true);
    expect(
      proposalPayloadSchema.safeParse({
        ...VALID_PROPOSAL_PAYLOAD,
        sections: Array.from(
          { length: ARTIFACT_SCHEMA_LIMITS.proposalSections + 1 },
          (_, index) => ({ ...section, key: `section-${index}` }),
        ),
      }).success,
    ).toBe(false);
    expect(
      reviewPayloadSchema.safeParse({
        ...REJECTING_REVIEW_PAYLOAD,
        issues: Array.from(
          { length: ARTIFACT_SCHEMA_LIMITS.reviewIssues },
          () => ({ ...issue }),
        ),
      }).success,
    ).toBe(true);
    expect(
      reviewPayloadSchema.safeParse({
        ...REJECTING_REVIEW_PAYLOAD,
        issues: Array.from(
          { length: ARTIFACT_SCHEMA_LIMITS.reviewIssues + 1 },
          () => ({ ...issue }),
        ),
      }).success,
    ).toBe(false);
  });

  it.each([
    ["proposal", proposalPayloadSchema, VALID_PROPOSAL_PAYLOAD],
    ["review", reviewPayloadSchema, APPROVING_REVIEW_PAYLOAD],
    ["final", finalPayloadSchema, VALID_FINAL_PAYLOAD],
  ] as const)("rejects unknown root fields in %s payloads", (_name, schema, payload) => {
    expect(schema.safeParse({ ...payload, agentId: "forged-agent" }).success).toBe(false);
  });

  it("rejects unknown nested fields", () => {
    expect(
      proposalPayloadSchema.safeParse({
        ...VALID_PROPOSAL_PAYLOAD,
        sections: [{ ...VALID_PROPOSAL_PAYLOAD.sections[0], route: "finalizer" }],
      }).success,
    ).toBe(false);
    expect(
      reviewPayloadSchema.safeParse({
        ...REJECTING_REVIEW_PAYLOAD,
        issues: [{ ...REJECTING_REVIEW_PAYLOAD.issues[0], leaseToken: "forged" }],
      }).success,
    ).toBe(false);
  });

  it("rejects empty text, invalid section-key slugs, versions, types, and decisions", () => {
    expect(
      proposalPayloadSchema.safeParse({ ...VALID_PROPOSAL_PAYLOAD, summary: "   " })
        .success,
    ).toBe(false);
    expect(
      proposalPayloadSchema.safeParse({
        ...VALID_PROPOSAL_PAYLOAD,
        sections: [{ ...VALID_PROPOSAL_PAYLOAD.sections[0], key: "Not A Slug" }],
      }).success,
    ).toBe(false);
    expect(
      proposalPayloadSchema.safeParse({ ...VALID_PROPOSAL_PAYLOAD, schemaVersion: 2 })
        .success,
    ).toBe(false);
    expect(
      proposalPayloadSchema.safeParse({ ...VALID_PROPOSAL_PAYLOAD, type: "review" })
        .success,
    ).toBe(false);
    expect(
      reviewPayloadSchema.safeParse({ ...APPROVING_REVIEW_PAYLOAD, decision: "maybe" })
        .success,
    ).toBe(false);
  });

  it("leaves review decision consistency to the P1-07 cross-field layer", () => {
    expect(
      reviewPayloadSchema.safeParse({ ...REJECTING_REVIEW_PAYLOAD, issues: [] }).success,
    ).toBe(true);
    expect(
      reviewPayloadSchema.safeParse({
        ...APPROVING_REVIEW_PAYLOAD,
        issues: REJECTING_REVIEW_PAYLOAD.issues,
      }).success,
    ).toBe(true);
  });

  it("normalizes an undefined optional sectionKey to an absent property", () => {
    const result = reviewPayloadSchema.parse({
      ...REJECTING_REVIEW_PAYLOAD,
      issues: [{ ...REJECTING_REVIEW_PAYLOAD.issues[0], sectionKey: undefined }],
    });

    expect(result.issues[0]).not.toHaveProperty("sectionKey");
  });

  it("strictly validates and trims bounded session messages", () => {
    expect(sessionMessagePayloadSchema.parse({
      schemaVersion: 1,
      type: "session_message",
      content: "  Ready to continue.  ",
      done: true,
    })).toEqual({
      schemaVersion: 1,
      type: "session_message",
      content: "Ready to continue.",
      done: true,
    });
    expect(sessionMessagePayloadSchema.safeParse({
      schemaVersion: 1,
      type: "session_message",
      content: "x".repeat(SESSION_LIMITS.messageMaxChars),
    }).success).toBe(true);
    expect(sessionMessagePayloadSchema.safeParse({
      schemaVersion: 1,
      type: "session_message",
      content: "x".repeat(SESSION_LIMITS.messageMaxChars + 1),
    }).success).toBe(false);
    expect(sessionMessagePayloadSchema.safeParse({
      schemaVersion: 1,
      type: "session_message",
      content: "   ",
    }).success).toBe(false);
  });

  it("rejects invalid done values and unknown session fields", () => {
    const base = { schemaVersion: 1, type: "session_message", content: "Ready" };
    expect(sessionMessagePayloadSchema.safeParse({ ...base, done: "yes" }).success).toBe(false);
    expect(sessionMessagePayloadSchema.safeParse({ ...base, agentId: "forged" }).success).toBe(false);
    expect(sessionMessagePayloadSchema.safeParse({ ...base, schemaVersion: 2 }).success).toBe(false);
  });

  it.each([
    ["candidate answer", BID_SCHEMA_LIMITS.candidateAnswerChars, (value: string) => ({ candidateAnswer: value })],
    ["plan summary", BID_SCHEMA_LIMITS.planSummaryChars, (value: string) => ({ plan: { ...bidPayload().plan, summary: value } })],
    ["assignment instruction", BID_SCHEMA_LIMITS.assignmentInstructionChars, (value: string) => ({ plan: { ...bidPayload().plan, assignments: [{ ...bidPayload().plan.assignments[0]!, instruction: value }] } })],
    ["risk", BID_SCHEMA_LIMITS.riskAssumptionChars, (value: string) => ({ plan: { ...bidPayload().plan, risks: [value] } })],
    ["assumption", BID_SCHEMA_LIMITS.riskAssumptionChars, (value: string) => ({ plan: { ...bidPayload().plan, assumptions: [value] } })],
  ] as const)("accepts bid %s at its cap and rejects empty or one over", (_name, limit, change) => {
    const parse = (value: string) => sessionBidPayloadSchema.safeParse({
      ...bidPayload(),
      ...change(value),
    });
    expect(parse(repeated(limit)).success).toBe(true);
    expect(parse(repeated(limit + 1)).success).toBe(false);
    expect(parse("   ").success).toBe(false);
  });

  it("strictly bounds bid arrays and numeric fields", () => {
    const assignment = bidPayload().plan.assignments[0]!;
    expect(sessionBidPayloadSchema.safeParse({
      ...bidPayload(),
      plan: {
        ...bidPayload().plan,
        assignments: Array.from({ length: SESSION_LIMITS.maxParticipants }, (_, index) => ({
          ...assignment,
          agentId: `agent-${index}`,
          position: index + 1,
        })),
        risks: Array.from({ length: BID_SCHEMA_LIMITS.risks }, () => "risk"),
        assumptions: Array.from({ length: BID_SCHEMA_LIMITS.assumptions }, () => "assumption"),
      },
      confidenceBps: 10_000,
      estimatedOutputTokens: 1,
    }).success).toBe(true);
    for (const invalid of [
      { ...bidPayload(), confidenceBps: -1 },
      { ...bidPayload(), confidenceBps: 10_001 },
      { ...bidPayload(), estimatedOutputTokens: 0 },
      { ...bidPayload(), confidenceBps: 1.5 },
      { ...bidPayload(), plan: { ...bidPayload().plan, assignments: [] } },
      { ...bidPayload(), plan: { ...bidPayload().plan, risks: Array(11).fill("risk") } },
      { ...bidPayload(), plan: { ...bidPayload().plan, assumptions: Array(11).fill("assumption") } },
    ]) expect(sessionBidPayloadSchema.safeParse(invalid).success).toBe(false);
  });

  it("trims bid text and rejects unknown fields at every object level", () => {
    expect(sessionBidPayloadSchema.parse({
      ...bidPayload(),
      candidateAnswer: " candidate ",
      plan: {
        ...bidPayload().plan,
        summary: " plan ",
        assignments: [{ ...bidPayload().plan.assignments[0]!, instruction: " execute " }],
        risks: [" risk "],
        assumptions: [" assumption "],
      },
    })).toMatchObject({
      candidateAnswer: "candidate",
      plan: {
        summary: "plan",
        assignments: [{ instruction: "execute" }],
        risks: ["risk"],
        assumptions: ["assumption"],
      },
    });
    expect(sessionBidPayloadSchema.safeParse({ ...bidPayload(), policy: {} }).success).toBe(false);
    expect(sessionBidPayloadSchema.safeParse({
      ...bidPayload(),
      plan: { ...bidPayload().plan, route: "self" },
    }).success).toBe(false);
    expect(sessionBidPayloadSchema.safeParse({
      ...bidPayload(),
      plan: {
        ...bidPayload().plan,
        assignments: [{ ...bidPayload().plan.assignments[0]!, leaseToken: "forged" }],
      },
    }).success).toBe(false);
  });

  it("strictly validates, trims, and bounds durable user messages", () => {
    expect(userMessagePayloadSchema.parse({
      schemaVersion: 1,
      type: "user_message",
      content: "  Continue with the risks  ",
    })).toEqual({
      schemaVersion: 1,
      type: "user_message",
      content: "Continue with the risks",
    });
    const base = { schemaVersion: 1, type: "user_message" as const };
    expect(userMessagePayloadSchema.safeParse({ ...base, content: "x".repeat(4_000) }).success)
      .toBe(true);
    expect(userMessagePayloadSchema.safeParse({ ...base, content: "x".repeat(4_001) }).success)
      .toBe(false);
    expect(userMessagePayloadSchema.safeParse({ ...base, content: "   " }).success).toBe(false);
    expect(userMessagePayloadSchema.safeParse({ ...base, content: "valid", done: true }).success)
      .toBe(false);
  });
});
