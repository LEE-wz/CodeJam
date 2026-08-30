import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../agent-service.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type { AgentRunner } from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import { VerifiedHandoffArtifactProtocol } from "./artifact-protocol.js";
import { RoleScopedContextBuilder } from "./context-builder.js";
import type { CoordinationAgentDirectory } from "./contracts.js";
import { DurableCoordinationRepository } from "./repository.js";
import { AgentServiceCoordinationRuntime } from "./runtime-gateway.js";
import { CoordinationService } from "./service.js";
import { AdvancingClock, DeterministicIdGenerator } from "./testing/controls.js";
import { PHASE3_COMPLETED_RESPONSE } from "./testing/phase3-completed-response.js";
import {
  APPROVING_REVIEW_OUTPUT,
  VALID_FINAL_OUTPUT,
  VALID_PROPOSAL_OUTPUT,
} from "./testing/fixtures.js";
import { VerifiedHandoffWorkflowV1 } from "./workflow.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 5 }),
    ),
  );
});

describe("Phase 3 real AgentService gateway", () => {
  it("retains a redacted lease-free completed response for Phase 4", () => {
    expect(PHASE3_COMPLETED_RESPONSE.run.status).toBe("completed");
    expect(PHASE3_COMPLETED_RESPONSE.turns).toHaveLength(3);
    expect(JSON.stringify(PHASE3_COMPLETED_RESPONSE)).not.toContain("leaseToken");
  });

  it("completes Planner → Critic → Finaliser with visible correlated Agent records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "relay-phase3-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "test-model",
    });
    const outputs = [VALID_PROPOSAL_OUTPUT, APPROVING_REVIEW_OUTPUT, VALID_FINAL_OUTPUT];
    const threadInputs: Array<string | null> = [];
    const runner: AgentRunner = {
      run: async (request) => {
        threadInputs.push(request.threadId);
        const output = outputs.shift();
        if (!output) throw new Error("unexpected extra Agent execution");
        return {
          output,
          threadId: request.threadId ?? `thread-${request.agentId}`,
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
      cancel: async () => true,
      isAvailable: async () => true,
    };
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const clock = new AdvancingClock();
    const ids = new DeterministicIdGenerator();
    const repository = new DurableCoordinationRepository({ store, clock, ids });
    const agents = new AgentService(
      config,
      store,
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
      repository,
    );
    await agents.initialize();
    const planner = await agents.createAgent({ name: "Planner" });
    const critic = await agents.createAgent({ name: "Critic" });
    const finalizer = await agents.createAgent({ name: "Finaliser" });
    const agentDirectory: CoordinationAgentDirectory = {
      getAgentsByIds: async (agentIds) => {
        const wanted = new Set(agentIds);
        return agents.listAgents().filter((agent) => wanted.has(agent.id));
      },
    };
    const coordination = new CoordinationService({
      agentDirectory,
      repository,
      workflow: new VerifiedHandoffWorkflowV1(),
      contextBuilder: new RoleScopedContextBuilder(),
      artifactProtocol: new VerifiedHandoffArtifactProtocol({ clock, ids }),
      runtime: new AgentServiceCoordinationRuntime(agents),
      clock,
      ids,
    });
    await coordination.initialize();

    const run = await coordination.createRun({
      name: "Real gateway integration",
      objective: "Produce a concise launch plan with evidence.",
      requiredSections: [
        { key: "users", title: "Target Users" },
        { key: "risks", title: "Risks and Mitigations" },
      ],
      agents: {
        plannerAgentId: planner.id,
        criticAgentId: critic.id,
        finalizerAgentId: finalizer.id,
      },
    });
    await coordination.startRun(run.id);
    await expect.poll(async () => (await coordination.getRun(run.id))?.run.status).toBe(
      "completed",
    );

    const details = await coordination.getRun(run.id);
    expect(details?.artifacts.map((artifact) => artifact.type)).toEqual([
      "proposal",
      "review",
      "final",
    ]);
    expect(details?.attempts.every((attempt) => attempt.agentRunId)).toBe(true);
    expect(threadInputs).toEqual([null, null, null]);
    for (const agent of [planner, critic, finalizer]) {
      const agentRuns = agents.getRuns(agent.id);
      expect(agentRuns).toHaveLength(1);
      expect(agentRuns[0]).toMatchObject({
        source: "coordination",
        coordinationRunId: run.id,
        status: "completed",
      });
      expect(agents.getMessages(agent.id).map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(agents.getAgent(agent.id).codexThreadId).toBe(`thread-${agent.id}`);
    }
  });
});
