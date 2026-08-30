import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoordinationServiceContract } from "./contracts.js";
import { CoordinationError } from "./errors.js";
import type { CreateRunRequest, GetCoordinationRunResponse } from "./types.js";

const runIdParams = z.object({ id: z.string().uuid() });
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

const sessionPolicySchema = z
  .object({
    sessionProtocol: z.enum(["countdown", "free_chat"]).optional(),
    sessionStartValue: z.number().int().min(2).max(12).optional(),
    // Countdown permits a two-turn 2 -> 1 run; free chat is tightened below.
    maxTurns: z.number().int().min(2).max(12).optional(),
    perAttemptTimeoutMs: z.number().int().min(10_000).max(180_000).optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    const protocol = policy.sessionProtocol ?? "countdown";
    if (protocol === "free_chat") {
      if (policy.sessionStartValue !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sessionStartValue"],
          message: "Free-chat sessions do not accept a start value",
        });
      }
      if (policy.maxTurns !== undefined && policy.maxTurns < 3) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["maxTurns"],
          message: "Free-chat sessions require at least three turns",
        });
      }
      return;
    }

    const startValue = policy.sessionStartValue ?? 10;
    const maxTurns = policy.maxTurns ?? startValue;
    if (maxTurns < startValue) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxTurns"],
        message: "Countdown maxTurns must be at least the session start value",
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
      .min(2)
      .max(6)
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
  .strict();

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
    const details = await coordination.getRun(id);
    if (!details) {
      throw new CoordinationError(404, "NOT_FOUND", "Coordination run not found");
    }
    const attempts: GetCoordinationRunResponse["attempts"] = details.attempts.map(
      ({ leaseToken: _leaseToken, ...attempt }) => attempt,
    );
    return { ...details, attempts } satisfies GetCoordinationRunResponse;
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
}
