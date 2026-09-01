import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoordinationServiceContract } from "./contracts.js";
import { CoordinationError } from "./errors.js";
import type { CreateRunRequest, GetCoordinationRunResponse } from "./types.js";
import { SESSION_AUCTION_LIMITS, SESSION_LIMITS } from "./types.js";

const runIdParams = z.object({ id: z.string().uuid() });
const detailQuery = z
  .object({ sinceSequence: z.coerce.number().int().min(0).optional() })
  .strict();
/**
 * PA14-14. The strict object is the escalation boundary: routing carries only
 * bounded enums and a participant id, and any budget, concurrency, attempt, or
 * participant field is rejected as an unknown key rather than silently ignored.
 */
const messageRoutingSchema = z
  .object({
    routingMode: z.enum(["direct", "auction"]).optional(),
    selectedAgentId: z.string().trim().min(1).optional(),
    coordinationPreference: z.enum(["any", "single", "team"]).optional(),
    riskLevel: z.enum(["standard", "high"]).optional(),
  })
  .strict()
  .superRefine((routing, context) => {
    if (routing.riskLevel === "high" && routing.routingMode === "direct") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["routingMode"],
        message: "A high-risk message cannot request direct routing",
      });
    }
  });

const userMessageBody = z
  .object({
    content: z.string().trim().min(1).max(4_000),
    clientMessageId: z.string().trim().min(1).max(128).optional(),
    routing: messageRoutingSchema.optional(),
  })
  .strict();
const awardFeedbackParams = z.object({
  id: z.string().uuid(),
  awardId: z.string().trim().min(1).max(128),
});
const awardFeedbackBody = z
  .object({ decision: z.enum(["accepted", "rejected"]) })
  .strict();
const requiredSectionSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/),
    title: z.string().trim().min(1).max(120),
  })
  .strict();
const verifiedPolicySchema = z
  .object({
    maxRevisions: z.number().int().min(0).max(3).optional(),
    maxTurns: z.number().int().min(3).max(12).optional(),
    perAttemptTimeoutMs: z.number().int().min(10_000).max(180_000).optional(),
  })
  .strict();
const verifiedCreateRunBody = z
  .object({
    // Preserve the existing body shape while recording the durable default in
    // the parsed request, so callers that omit workflow stay on handoff v1.
    workflow: z.literal("verified_handoff_v1").optional().default("verified_handoff_v1"),
    name: z.string().trim().min(1).max(80),
    objective: z.string().trim().min(1).max(4_000),
    requiredSections: z.array(requiredSectionSchema).min(1).max(10),
    agents: z
      .object({
        plannerAgentId: z.string().trim().min(1),
        criticAgentId: z.string().trim().min(1),
        finalizerAgentId: z.string().trim().min(1),
      })
      .strict(),
    policy: verifiedPolicySchema.optional(),
  })
  .strict();

const sessionAuctionPolicySchema = z
  .object({
    routingMode: z.enum(["direct", "auction", "auto"]).optional(),
    defaultAgentId: z.string().trim().min(1).optional(),
    directConfidenceThresholdBps: z
      .number()
      .int()
      .min(SESSION_AUCTION_LIMITS.minConfidenceBps)
      .max(SESSION_AUCTION_LIMITS.maxConfidenceBps)
      .optional(),
    directOutputTokenBudget: z
      .number()
      .int()
      .min(SESSION_AUCTION_LIMITS.minDirectOutputTokens)
      .max(SESSION_AUCTION_LIMITS.maxDirectOutputTokens)
      .optional(),
    minimumValidBids: z.number().int().min(1).max(SESSION_LIMITS.maxParticipants).optional(),
    maxBidOutputTokens: z
      .number()
      .int()
      .min(SESSION_AUCTION_LIMITS.minBidOutputTokens)
      .max(SESSION_AUCTION_LIMITS.maxBidOutputTokens)
      .optional(),
    maxBidAttempts: z
      .number()
      .int()
      .min(SESSION_AUCTION_LIMITS.minBidAttempts)
      .max(SESSION_AUCTION_LIMITS.maxBidAttempts)
      .optional(),
    auctionExecutionTokenBudget: z
      .number()
      .int()
      .min(SESSION_AUCTION_LIMITS.minExecutionOutputTokens)
      .max(SESSION_AUCTION_LIMITS.maxExecutionOutputTokens)
      .optional(),
    auctionOnDirectFailure: z.boolean().optional(),
    fallback: z.enum(["default_agent", "round_robin", "fail"]).optional(),
    scoringVersion: z.literal("confidence_cost_v1").optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.fallback === "default_agent" && policy.defaultAgentId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultAgentId"],
        message: "default_agent fallback requires defaultAgentId",
      });
    }
  });

const sessionPolicySchema = z
  .object({
    // Free chat is the only session protocol (PA14-18). The field is still
    // accepted so existing clients that send it keep working unchanged.
    sessionProtocol: z.literal("free_chat").optional(),
    maxTurns: z
      .number()
      .int()
      .min(SESSION_LIMITS.minSessionTurns)
      .max(SESSION_LIMITS.maxSessionTurns)
      .optional(),
    perAttemptTimeoutMs: z.number().int().min(10_000).max(180_000).optional(),
    sessionWaveMode: z.enum(["sequential", "parallel"]).optional(),
    sessionWavePurpose: z.enum(["session_execution", "session_bidding"]).optional(),
    maxParallelTurns: z
      .number()
      .int()
      .min(SESSION_LIMITS.minParallelTurns)
      .max(SESSION_LIMITS.maxParallelTurns)
      .optional(),
    auctionPolicy: sessionAuctionPolicySchema.optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    const waveMode = policy.sessionWaveMode ?? "sequential";
    if (policy.auctionPolicy !== undefined) {
      if (policy.sessionWaveMode !== undefined || policy.sessionWavePurpose !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["auctionPolicy"],
          message: "Auction routing cannot be combined with Phase 13 wave routing fields",
        });
      }
    }
    // A bidding wave only exists inside a parallel wave: there is nothing to
    // bid against when one participant answers at a time.
    if (waveMode === "sequential" && policy.sessionWavePurpose === "session_bidding") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sessionWavePurpose"],
        message: "A bidding wave requires sessionWaveMode 'parallel'",
      });
    }
  });

const sessionCreateRunBody = z
  .object({
    workflow: z.literal("shared_session_v1"),
    name: z.string().trim().min(1).max(80),
    objective: z.string().trim().min(1).max(4_000),
    agents: z
      .array(z.string().trim().min(1))
      .min(SESSION_LIMITS.minParticipants)
      .max(SESSION_LIMITS.maxParticipants)
      .superRefine((agentIds, context) => {
        if (new Set(agentIds).size !== agentIds.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Each participant must be distinct",
          });
        }
      }),
    policy: sessionPolicySchema.optional(),
  })
  .strict()
  .superRefine((body, context) => {
    const auction = body.policy?.auctionPolicy;
    if (!auction) return;
    if (
      auction.defaultAgentId !== undefined &&
      !body.agents.includes(auction.defaultAgentId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["policy", "auctionPolicy", "defaultAgentId"],
        message: "Default Agent must be a session participant",
      });
    }
    if (
      auction.minimumValidBids !== undefined &&
      auction.minimumValidBids > body.agents.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["policy", "auctionPolicy", "minimumValidBids"],
        message: "Minimum valid bids cannot exceed the participant count",
      });
    }
  });

const createRunBody: z.ZodType<CreateRunRequest> = z.union([
  verifiedCreateRunBody,
  sessionCreateRunBody,
]);

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path.join(".") || "body";
    (fieldErrors[field] ??= []).push(issue.message);
  }
  throw new CoordinationError(
    400,
    "VALIDATION_FAILED",
    "Request validation failed",
    fieldErrors,
  );
}

export async function registerCoordinationRoutes(
  app: FastifyInstance,
  coordination: CoordinationServiceContract,
): Promise<void> {
  app.get("/api/coordination-runs", async () => ({
    runs: await coordination.listRuns(),
  }));

  app.post("/api/coordination-runs", async (request, reply) => {
    const body = parseInput(createRunBody, request.body);
    const run = await coordination.createRun(body);
    return reply.code(201).send({ run });
  });

  app.get("/api/coordination-runs/:id", async (request) => {
    const { id } = parseInput(runIdParams, request.params);
    const { sinceSequence } = parseInput(detailQuery, request.query);
    const details = await coordination.getRun(id);
    if (!details) {
      throw new CoordinationError(404, "NOT_FOUND", "Coordination run not found");
    }
    const attempts: GetCoordinationRunResponse["attempts"] = details.attempts.map(
      ({ leaseToken: _leaseToken, ...attempt }) => attempt,
    );
    if (sinceSequence === undefined) {
      return { ...details, attempts } satisfies GetCoordinationRunResponse;
    }
    const events = details.events.filter((event) => event.sequence >= sinceSequence);
    const turnIds = new Set(events.flatMap((event) => (event.turnId ? [event.turnId] : [])));
    const attemptIds = new Set(events.flatMap((event) => (event.attemptId ? [event.attemptId] : [])));
    const artifactIds = new Set(events.flatMap((event) => (event.artifactId ? [event.artifactId] : [])));
    const deltaTurns = details.turns.filter((turn) => turnIds.has(turn.id));
    const deltaAttempts = attempts.filter(
      (attempt) => attemptIds.has(attempt.id) || turnIds.has(attempt.turnId),
    );
    const deltaArtifacts = details.artifacts.filter((artifact) => artifactIds.has(artifact.id));
    return {
      run: details.run,
      turns: deltaTurns,
      attempts: deltaAttempts,
      usageTotals: details.usageTotals,
      auctionUsage: details.auctionUsage,
      artifacts: deltaArtifacts,
      events,
      cursor: Math.max(sinceSequence, (details.events.at(-1)?.sequence ?? -1) + 1),
    } satisfies GetCoordinationRunResponse;
  });

  app.post("/api/coordination-runs/:id/messages", async (request, reply) => {
    const { id } = parseInput(runIdParams, request.params);
    const body = parseInput(userMessageBody, request.body);
    const run = await coordination.resumeRun(id, {
      content: body.content,
      ...(body.clientMessageId === undefined ? {} : { clientMessageId: body.clientMessageId }),
      ...(body.routing === undefined ? {} : { routing: body.routing }),
    });
    return reply.code(202).send({ run, accepted: true });
  });

  app.post("/api/coordination-runs/:id/awards/:awardId/feedback", async (request, reply) => {
    const { id, awardId } = parseInput(awardFeedbackParams, request.params);
    const { decision } = parseInput(awardFeedbackBody, request.body);
    const run = await coordination.recordAwardFeedback({
      runId: id,
      awardArtifactId: awardId,
      decision,
    });
    return reply.code(202).send({ run, accepted: true });
  });

  app.post("/api/coordination-runs/:id/start", async (request, reply) => {
    const { id } = parseInput(runIdParams, request.params);
    const run = await coordination.startRun(id);
    return reply.code(202).send({ run, accepted: true });
  });

  app.post("/api/coordination-runs/:id/stop", async (request, reply) => {
    const { id } = parseInput(runIdParams, request.params);
    const run = await coordination.stopRun(id);
    return reply.code(202).send({ run, accepted: true });
  });

  app.post("/api/coordination-runs/:id/end", async (request, reply) => {
    const { id } = parseInput(runIdParams, request.params);
    const run = await coordination.endRun(id);
    return reply.code(202).send({ run, accepted: true });
  });
}
