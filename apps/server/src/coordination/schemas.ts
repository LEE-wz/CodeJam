import { z } from "zod";
import type {
  FinalPayload,
  ProposalPayload,
  ReviewIssue,
  ReviewPayload,
  SessionMessagePayload,
  SessionPlanPayload,
  UserMessagePayload,
} from "./types.js";
import { SESSION_LIMITS } from "./types.js";

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

/** Frozen section-key slug format (overview Section 7.1). */
export const SECTION_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const sectionKeySchema = boundedText(ARTIFACT_SCHEMA_LIMITS.keyChars).regex(
  SECTION_KEY_PATTERN,
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

export const sessionMessagePayloadSchema: z.ZodType<SessionMessagePayload> = z
  .object({
    schemaVersion: z.literal(COORDINATION_ARTIFACT_SCHEMA_VERSION),
    type: z.literal("session_message"),
    content: z
      .string()
      .trim()
      .min(SESSION_LIMITS.messageMinChars)
      .max(SESSION_LIMITS.messageMaxChars),
    done: z.boolean().optional(),
  })
  .strict()
  .transform(({ done, ...message }): SessionMessagePayload =>
    done === undefined ? message : { ...message, done },
  );

/**
 * The bounded plan schema (P14-01). It enforces only what a schema can: strict
 * keys, literal `type`/`schemaVersion`, the two mode literals, a non-empty
 * bounded instruction, and an assignment count within the widest possible
 * participant range. The rules that need the run -- participant membership,
 * distinct ids, contiguous positions, count against *this* run's roster -- are
 * structural protocol rules and live in the artifact protocol, because a schema
 * has no access to the run.
 */
export const sessionPlanPayloadSchema: z.ZodType<SessionPlanPayload> = z
  .object({
    schemaVersion: z.literal(COORDINATION_ARTIFACT_SCHEMA_VERSION),
    type: z.literal("session_plan"),
    mode: z.enum(["parallel", "sequential"]),
    assignments: z
      .array(
        z
          .object({
            agentId: z.string().trim().min(1).max(128),
            position: z.number().int().min(1).max(SESSION_LIMITS.maxParticipants),
            instruction: z
              .string()
              .trim()
              .min(1)
              .max(SESSION_LIMITS.planInstructionMaxChars),
          })
          .strict(),
      )
      .min(1)
      .max(SESSION_LIMITS.maxParticipants),
  })
  .strict();

export const userMessagePayloadSchema: z.ZodType<UserMessagePayload> = z
  .object({
    schemaVersion: z.literal(COORDINATION_ARTIFACT_SCHEMA_VERSION),
    type: z.literal("user_message"),
    content: z.string().trim().min(1).max(4_000),
  })
  .strict();
