import { describe, expect, it } from "vitest";
import {
  APPROVING_REVIEW_PAYLOAD,
  REJECTING_REVIEW_PAYLOAD,
  VALID_FINAL_PAYLOAD,
  VALID_PROPOSAL_PAYLOAD,
} from "./testing/fixtures.js";
import {
  ARTIFACT_SCHEMA_LIMITS,
  finalPayloadSchema,
  proposalPayloadSchema,
  reviewPayloadSchema,
  sessionMessagePayloadSchema,
} from "./schemas.js";
import { SESSION_LIMITS } from "./types.js";

const repeated = (length: number): string => "x".repeat(length);

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
});
