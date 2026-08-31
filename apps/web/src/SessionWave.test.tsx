import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "./types";
import type {
  CoordinationArtifact,
  CoordinationAttempt,
  CoordinationEvent,
  CoordinationRunDetails,
  CoordinationTurn,
} from "./coordination-types";

vi.mock("./coordination-api", () => ({
  coordinationApi: {
    list: vi.fn(),
    create: vi.fn(),
    detail: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    sendMessage: vi.fn(),
    end: vi.fn(),
  },
}));

import { coordinationApi } from "./coordination-api";
import { SessionWorkspace } from "./SessionWorkspace";

const mockedApi = coordinationApi as unknown as {
  [Key in keyof typeof coordinationApi]: ReturnType<typeof vi.fn>;
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const now = "2026-08-31T04:00:00.000Z";
const PARTICIPANT_COUNT = 10;

/** Ten specialised participants, matching the widened ceiling. */
const waveAgents: Agent[] = Array.from({ length: PARTICIPANT_COUNT }, (_unused, index) => ({
  id: `agent-wave-${index + 1}`,
  name: `Relay ${index + 1}`,
  description: "",
  instructions: "",
  status: "ready",
  workspacePath: `/workspace/wave-${index + 1}`,
  codexThreadId: null,
  lastError: null,
  createdAt: now,
  updatedAt: now,
  specialization: {
    perspective: `Perspective ${index + 1}`,
    focusAreas: [`area-${index + 1}`],
    biddingInstructions: `Bid rule ${index + 1}`,
  },
}));

/**
 * A ten-member bidding wave in which one bidder was retired and the rest
 * committed. `retiredIndex` is deliberately not the first or last member, so an
 * off-by-one in the evidence view cannot pass by accident.
 */
const RETIRED_INDEX = 4;
const RAW_PROMPT = "SYSTEM PROMPT: you are participant four, here is the whole transcript";

const waveFixture = (): CoordinationRunDetails => {
  const runId = "run-wave-ui";
  const turns: CoordinationTurn[] = [];
  const attempts: CoordinationAttempt[] = [];
  const artifacts: CoordinationArtifact[] = [];
  const events: CoordinationEvent[] = [];

  const participants = waveAgents.map((agent) => ({
    role: "participant" as const,
    agentId: agent.id,
    agentNameSnapshot: agent.name,
  }));

  artifacts.push({
    id: "artifact-user-1",
    runId,
    type: "user_message",
    payload: { schemaVersion: 1, type: "user_message", content: "Which launch risk matters most?" },
    createdBy: { kind: "user" },
    transcriptSequence: 1,
    sizeChars: 34,
    createdAt: now,
  } as CoordinationArtifact);

  waveAgents.forEach((agent, index) => {
    const turnId = `turn-wave-${index + 1}`;
    const retired = index === RETIRED_INDEX;
    turns.push({
      id: turnId,
      runId,
      sequence: index + 1,
      role: "participant",
      agentId: agent.id,
      kind: "session_turn",
      wavePurpose: "session_bidding",
      status: retired ? "failed" : "committed",
      attemptCount: retired ? 2 : 1,
      inputArtifactIds: ["artifact-user-1"],
      ...(retired ? {} : { outputArtifactId: `artifact-wave-${index + 1}` }),
      lastValidationErrors: [],
      createdAt: now,
      completedAt: now,
    });

    events.push({
      id: `event-scheduled-${index + 1}`,
      runId,
      sequence: events.length + 1,
      type: "turn.scheduled",
      actor: { type: "system" },
      turnId,
      message: `Turn ${index + 1}: Participant to produce the session message.`,
      details: {
        sequence: index + 1,
        role: "participant",
        agentId: agent.id,
        wavePurpose: "session_bidding",
        waveSize: PARTICIPANT_COUNT,
      },
      createdAt: now,
    });

    if (retired) {
      for (const number of [1, 2]) {
        attempts.push({
          id: `attempt-wave-${index + 1}-${number}`,
          runId,
          turnId,
          number,
          agentId: agent.id,
          status: "failed",
          errorCode: "AGENT_EXECUTION_FAILED",
          errorMessage: "Agent execution failed",
          usage: { inputTokens: 120, cachedInputTokens: 40, outputTokens: 0 },
          createdAt: now,
          finishedAt: now,
        });
      }
      events.push({
        id: `event-retired-${index + 1}`,
        runId,
        sequence: events.length + 1,
        type: "turn.failed",
        actor: { type: "agent", agentId: agent.id, role: "participant" },
        turnId,
        message: `Turn ${index + 1}: Participant did not produce a usable result and was retired.`,
        details: {
          sequence: index + 1,
          role: "participant",
          agentId: agent.id,
          code: "MAX_ATTEMPTS_EXCEEDED",
          reason: "Participant did not return a usable bid for this round",
        },
        createdAt: now,
      });
      return;
    }

    attempts.push({
      id: `attempt-wave-${index + 1}-1`,
      runId,
      turnId,
      number: 1,
      agentId: agent.id,
      status: "succeeded",
      usage: { inputTokens: 200, cachedInputTokens: 150, outputTokens: 60 },
      promptDigest: "sha256:prompt-digest",
      outputDigest: "sha256:output-digest",
      createdAt: now,
      finishedAt: now,
    });
    artifacts.push({
      id: `artifact-wave-${index + 1}`,
      runId,
      turnId,
      createdByRole: "participant",
      createdByAgentId: agent.id,
      sizeChars: 40,
      createdAt: now,
      transcriptSequence: index + 2,
      type: "session_message",
      payload: {
        schemaVersion: 1,
        type: "session_message",
        content: `Bid from ${agent.name}`,
      },
    } as CoordinationArtifact);
    events.push({
      id: `event-committed-${index + 1}`,
      runId,
      sequence: events.length + 1,
      type: "turn.committed",
      actor: { type: "agent", agentId: agent.id, role: "participant" },
      turnId,
      artifactId: `artifact-wave-${index + 1}`,
      message: `${agent.name} committed a session message`,
      details: { sequence: index + 1 },
      createdAt: now,
    });
  });

  const committed = PARTICIPANT_COUNT - 1;
  return {
    run: {
      id: runId,
      name: "Bidding wave session",
      objective: "Collect one bid from every participant at once.",
      requiredSections: [],
      participants,
      policy: {
        workflow: "shared_session_v1",
        maxRevisions: 0,
        maxTurns: 500,
        maxAttemptsPerTurn: 2,
        perAttemptTimeoutMs: 120_000,
        contextMaxChars: 40_000,
        outputMaxChars: 20_000,
        sessionProtocol: "free_chat",
        sessionWaveMode: "parallel",
        sessionWavePurpose: "session_bidding",
        maxParallelTurns: 4,
      },
      status: "awaiting_input",
      phase: "sessioning",
      revision: 0,
      nextTurnSequence: PARTICIPANT_COUNT + 1,
      activeTurnIds: [],
      lastUserArtifactId: "artifact-user-1",
      version: events.length,
      createdAt: now,
      updatedAt: now,
    },
    turns,
    attempts,
    usageTotals: {
      inputTokens: 200 * committed + 240,
      cachedInputTokens: 150 * committed + 80,
      outputTokens: 60 * committed,
    },
    artifacts,
    events,
  };
};

const renderWave = async (details = waveFixture()) => {
  mockedApi.list.mockResolvedValue({ runs: [details.run] });
  mockedApi.detail.mockResolvedValue(details);
  const view = render(<SessionWorkspace agents={waveAgents} />);
  await screen.findByRole("heading", { name: details.run.name });
  return { ...view, details };
};

describe("purpose-aware wave evidence", () => {
  it("marks every member of a bidding wave", async () => {
    const { details } = await renderWave();

    const badges = screen.getAllByText("Bid");
    expect(badges).toHaveLength(details.turns.length);
    expect(details.turns.every((turn) => turn.wavePurpose === "session_bidding")).toBe(true);
  });

  it("shows no bid badge on an ordinary execution wave", async () => {
    const details = waveFixture();
    const execution: CoordinationRunDetails = {
      ...details,
      run: {
        ...details.run,
        policy: { ...details.run.policy, sessionWavePurpose: "session_execution" },
      },
      turns: details.turns.map((turn) => ({ ...turn, wavePurpose: "session_execution" as const })),
    };

    await renderWave(execution);

    expect(screen.queryByText("Bid")).toBeNull();
  });

  it("renders the wave purpose and size carried by the scheduling events", async () => {
    const { container } = await renderWave();

    // Detail values render verbatim, the same way `kind` and `artifactType`
    // already do; only event types and detail keys are humanized.
    expect(container.textContent).toContain("session_bidding");
    expect(container.textContent).toContain("waveSize");
  });
});

describe("partial bidder failure", () => {
  it("shows the retired member without claiming the session failed", async () => {
    const { container, details } = await renderWave();

    // The session is idle and usable, not terminal.
    expect(details.run.status).toBe("awaiting_input");
    expect(container.textContent).not.toContain("Shared session failed");

    const retiredTurn = details.turns[RETIRED_INDEX]!;
    const evidence = screen.getByLabelText(`Attempts for turn ${retiredTurn.sequence}`);
    const article = evidence.closest("article");
    expect(article).not.toBeNull();
    const element = article as HTMLElement;
    expect(element.querySelector(".turn-status")?.textContent).toBe("failed");
    expect(element.querySelector(".turn-status-failed")).not.toBeNull();
    // Both spent attempts are visible, so the retirement is auditable.
    expect(within(element).getByText("Attempt 1")).toBeTruthy();
    expect(within(element).getByText("Attempt 2")).toBeTruthy();
    expect(element.querySelectorAll(".attempt-status-failed")).toHaveLength(2);
  });

  it("renders the turn.failed event with its reason and no raw output", async () => {
    const { container } = await renderWave();

    expect(container.textContent).toContain("turn · failed");
    expect(container.textContent).toContain(
      "Participant did not return a usable bid for this round",
    );
    expect(container.textContent).toContain("MAX_ATTEMPTS_EXCEEDED");
  });

  it("keeps the other nine bids in the transcript", async () => {
    const { container } = await renderWave();

    for (const [index, agent] of waveAgents.entries()) {
      if (index === RETIRED_INDEX) continue;
      expect(container.textContent).toContain(`Bid from ${agent.name}`);
    }
  });
});

describe("per-attempt usage", () => {
  it("shows token counts on each attempt", async () => {
    await renderWave();

    const succeeded = screen.getAllByText("Tokens: 200 in · 150 cached · 60 out");
    expect(succeeded).toHaveLength(PARTICIPANT_COUNT - 1);
    // A failed attempt still incurred cost, and it is still attributed.
    expect(screen.getAllByText("Tokens: 120 in · 40 cached · 0 out")).toHaveLength(2);
  });

  it("shows run totals that include failed attempts", async () => {
    const { details } = await renderWave();

    const totals = screen.getByLabelText("Total token usage");
    expect(totals.textContent).toContain(String(details.usageTotals.inputTokens));
    expect(totals.textContent).toContain(String(details.usageTotals.cachedInputTokens));
    expect(totals.textContent).toContain(String(details.usageTotals.outputTokens));
    // 9 successes at 200 plus two failed attempts at 120.
    expect(details.usageTotals.inputTokens).toBe(2_040);
  });

  it("renders nothing for an attempt with no recorded usage", async () => {
    const details = waveFixture();
    const withoutUsage: CoordinationRunDetails = {
      ...details,
      attempts: details.attempts.map((attempt) => {
        const { usage: _usage, ...rest } = attempt;
        return rest;
      }),
    };

    await renderWave(withoutUsage);

    expect(screen.queryByText(/^Tokens:/)).toBeNull();
  });
});

describe("wave evidence does not leak", () => {
  it("never renders a lease, prompt, or raw output", async () => {
    const details = waveFixture();
    const leaky: CoordinationRunDetails = {
      ...details,
      events: details.events.map((event) =>
        event.type === "turn.scheduled"
          ? { ...event, details: { ...event.details, reason: RAW_PROMPT } }
          : event,
      ),
    };
    // The fixture deliberately carries a prompt-shaped string only where the
    // server would have redacted it, to prove the client is not the thing
    // keeping prompts out of the DOM.
    const { container } = await renderWave(details);

    expect(container.textContent?.toLowerCase()).not.toContain("leasetoken");
    expect(container.textContent).not.toContain("sha256:prompt-digest");
    expect(container.textContent).not.toContain(RAW_PROMPT);
    expect(leaky.events.length).toBe(details.events.length);
  });
});

describe("ten specialised participants", () => {
  it("lists every participant in the wave", async () => {
    const { container } = await renderWave();

    for (const agent of waveAgents) {
      expect(container.textContent).toContain(agent.name);
    }
  });

  it("keeps the transcript scrollable rather than overflowing the page", async () => {
    await renderWave();

    const transcript = screen.getByLabelText("Session transcript");
    expect(transcript.style.overflowY).toBe("auto");
    expect(transcript.style.maxHeight).toBe("34rem");
  });

  it("keeps the composer reachable and labelled for keyboard users", async () => {
    await renderWave();

    const composer = screen.getByLabelText("Message the session") as HTMLTextAreaElement;
    expect(composer.disabled).toBe(false);
    expect(composer.maxLength).toBe(4_000);
    composer.focus();
    expect(document.activeElement).toBe(composer);
  });
});
