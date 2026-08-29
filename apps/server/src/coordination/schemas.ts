import { z } from "zod";
import type {
  FinalPayload,
  ProposalPayload,
  ReviewIssue,
  ReviewPayload,
} from "./types.js";

export const COORDINATION_ARTIFACT_SCHEMA_VERSION = 1 as const;

export const ARTIFACT_SCHEMA_LIMITS = {
  keyChars: 64,
  titleChars: 120,
  proposalSummaryChars: 1_000,
  proposalSectionContentChars: 6_000,
  proposalSections: 20,
  reviewIssues: 20,
  reviewIssueMessageChars: 1_000,
  reviewFeedbackChars: 2_000,
  finalContentChars: 16_000,
} as const;

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const sectionKeySchema = boundedText(ARTIFACT_SCHEMA_LIMITS.keyChars).regex(
  /^[a-z0-9][a-z0-9_-]*$/,
);

export const proposalSectionSchema = z
  .object({
    key: sectionKeySchema,
    title: boundedText(ARTIFACT_SCHEMA_LIMITS.titleChars),
    content: boundedText(ARTIFACT_SCHEMA_LIMITS.proposalSectionContentChars),
  })
  .strict();

export const proposalPayloadSchema: z.ZodType<ProposalPayload> = z
  .object({
    schemaVersion: z.literal(COORDINATION_ARTIFACT_SCHEMA_VERSION),
    type: z.literal("proposal"),
    summary: boundedText(ARTIFACT_SCHEMA_LIMITS.proposalSummaryChars),
    sections: z
      .array(proposalSectionSchema)
      .min(1)
      .max(ARTIFACT_SCHEMA_LIMITS.proposalSections),
  })
  .strict();

export const reviewIssueSchema = z
  .object({
    code: boundedText(ARTIFACT_SCHEMA_LIMITS.keyChars),
    sectionKey: sectionKeySchema.optional(),
    message: boundedText(ARTIFACT_SCHEMA_LIMITS.reviewIssueMessageChars),
  })
  .strict()
  .transform(
    ({ sectionKey, ...issue }): ReviewIssue =>
      sectionKey === undefined ? issue : { ...issue, sectionKey },
  );

export const reviewPayloadSchema: z.ZodType<ReviewPayload> = z
  .object({
    schemaVersion: z.literal(COORDINATION_ARTIFACT_SCHEMA_VERSION),
    type: z.literal("review"),
    decision: z.enum(["approve", "reject"]),
    issues: z.array(reviewIssueSchema).max(ARTIFACT_SCHEMA_LIMITS.reviewIssues),
    feedback: boundedText(ARTIFACT_SCHEMA_LIMITS.reviewFeedbackChars),
  })
  .strict();

export const finalPayloadSchema: z.ZodType<FinalPayload> = z
  .object({
    schemaVersion: z.literal(COORDINATION_ARTIFACT_SCHEMA_VERSION),
    type: z.literal("final"),
    title: boundedText(ARTIFACT_SCHEMA_LIMITS.titleChars),
    content: boundedText(ARTIFACT_SCHEMA_LIMITS.finalContentChars),
  })
  .strict();
