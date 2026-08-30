import { randomUUID } from "node:crypto";
import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { VerifiedHandoffArtifactProtocol } from "./coordination/artifact-protocol.js";
import { RoleScopedContextBuilder } from "./coordination/context-builder.js";
import type {
  Clock,
  CoordinationAgentDirectory,
  CoordinationAgentView,
  IdGenerator,
} from "./coordination/contracts.js";
import { DurableCoordinationRepository } from "./coordination/repository.js";
import { CoordinationService } from "./coordination/service.js";
import type { CoordinationLogContext, CoordinationLogger } from "./coordination/service.js";
import { ScriptedCoordinationRuntime } from "./coordination/testing/fakes.js";
import { VerifiedHandoffWorkflowV1 } from "./coordination/workflow.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const service = new AgentService(config, store, workspaces, runner);
await service.initialize();

const clock: Clock = { nowIso: () => new Date().toISOString() };

const ids: IdGenerator = {
  runId: () => randomUUID(),
  turnId: () => randomUUID(),
  attemptId: () => randomUUID(),
  artifactId: () => randomUUID(),
  eventId: () => randomUUID(),
  // The lease is an opaque capability, never displayed, logged, or persisted
  // in an event.
  leaseToken: () => randomUUID(),
};

/**
 * Relay reads Agents through `AgentService` rather than the store, so it can
 * never bypass the existing Agent lifecycle.
 */
const agentDirectory: CoordinationAgentDirectory = {
  getAgentsByIds: async (agentIds) => {
    const wanted = new Set(agentIds);
    return service
      .listAgents()
      .filter((agent) => wanted.has(agent.id))
      .map<CoordinationAgentView>((agent) => ({
        id: agent.id,
        name: agent.name,
        status: agent.status,
      }));
  },
};

// The Fastify logger only exists after `createApp`, so coordination logs are
// forwarded through a holder rather than being dropped or duplicated onto a
// second transport.
let requestLogger: {
  info(context: CoordinationLogContext, message: string): void;
  error(context: CoordinationLogContext, message: string): void;
} | undefined;

const logger: CoordinationLogger = {
  info: (context, message) => requestLogger?.info(context, message),
  error: (context, message) => requestLogger?.error(context, message),
};

const coordination = new CoordinationService({
  agentDirectory,
  repository: new DurableCoordinationRepository({ store, clock, ids }),
  workflow: new VerifiedHandoffWorkflowV1(),
  contextBuilder: new RoleScopedContextBuilder(),
  artifactProtocol: new VerifiedHandoffArtifactProtocol({ clock, ids }),
  // Phase 2 deliberately keeps execution disconnected: the durable backend is
  // proven against a scripted runtime, and P3-01 replaces this with the real
  // `AgentService`-backed gateway once the Phase 2 race gates have passed.
  runtime: new ScriptedCoordinationRuntime(),
  clock,
  ids,
  logger,
});

// Coordination initialises after AgentService so that ordinary Agent Runs are
// settled first; this pass then settles any coordination run left active by a
// crash and releases its derived Agent reservations.
await coordination.initialize();

const app = await createApp(config, service, coordination);
requestLogger = app.log;

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
