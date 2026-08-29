import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoordinationServiceContract } from "./contracts.js";
import { CoordinationError } from "./errors.js";

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
const policySchema = z
  .object({
    maxRevisions: z.number().int().min(0).max(3).optional(),
    maxTurns: z.number().int().min(3).max(12).optional(),
    perAttemptTimeoutMs: z.number().int().min(10_000).max(180_000).optional(),
  })
  .strict();
const createRunBody = z
  .object({
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
    policy: policySchema.optional(),
  })
  .strict();

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
    return details;
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
