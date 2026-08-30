import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Agent } from "./types";

/**
 * P11-11: Agent recovery and the reservation message.
 *
 * The API module is mocked wholesale so these tests exercise the component's
 * behaviour — what is rendered, and which endpoint a control calls — without a
 * server. `ApiError` is the real class, because the banner branches on its
 * `code`.
 */
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    setAuthToken: vi.fn(),
    api: {
      auth: vi.fn(),
      system: vi.fn(),
      listAgents: vi.fn(),
      createAgent: vi.fn(),
      updateAgent: vi.fn(),
      deleteAgent: vi.fn(),
      startAgent: vi.fn(),
      stopAgent: vi.fn(),
      messages: vi.fn(),
      runs: vi.fn(),
      sendMessage: vi.fn(),
      run: vi.fn(),
    },
  };
});

vi.mock("./coordination-api", () => ({
  coordinationApi: {
    list: vi.fn().mockResolvedValue({ runs: [] }),
    create: vi.fn(),
    detail: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

import { api, ApiError } from "./api";
import App from "./App";

const mockedApi = api as unknown as {
  [Key in keyof typeof api]: ReturnType<typeof vi.fn>;
};

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: "agent-1",
  name: "Relay Planner",
  description: "",
  instructions: "",
  status: "ready",
  workspacePath: "/workspace/agent-1",
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-08-30T04:00:00.000Z",
  updatedAt: "2026-08-30T04:00:00.000Z",
  ...overrides,
});

const mountWith = async (agents: Agent[]): Promise<void> => {
  mockedApi.auth.mockResolvedValue({ required: false });
  mockedApi.system.mockResolvedValue({
    arkConfigured: true,
    arkBaseUrl: "https://ark.example",
    arkModel: "test-model",
    codexAvailable: true,
    codexSandboxMode: "workspace-write",
    runtimeProvider: "local-process",
    containerEngine: null,
    runtime: "Codex CLI in application container",
  });
  mockedApi.listAgents.mockResolvedValue({ agents });
  mockedApi.messages.mockResolvedValue({ messages: [] });
  mockedApi.runs.mockResolvedValue({ runs: [] });
  render(<App />);
  await screen.findByRole("heading", { name: agents[0]?.name ?? "" });
};

beforeAll(() => {
  // jsdom implements no layout, so the chat autoscroll effect has nothing to
  // call. The stub keeps the effect from throwing during render.
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Agent recovery (P11-07)", () => {
  it("shows the failure message and resets an errored Agent to ready", async () => {
    const errored = agent({ status: "error", lastError: "Codex exited with code 1" });
    await mountWith([errored]);

    // The failure is visible on the Agent itself, not only in a transient toast.
    expect(screen.getByText("Codex exited with code 1")).toBeTruthy();
    const reset = screen.getByRole("button", { name: "Reset to ready" });

    mockedApi.startAgent.mockResolvedValue({ agent: agent({ status: "ready" }) });
    mockedApi.listAgents.mockResolvedValue({ agents: [agent({ status: "ready" })] });
    await userEvent.click(reset);

    // Recovery reuses the existing start endpoint; no new route is involved.
    await waitFor(() => expect(mockedApi.startAgent).toHaveBeenCalledWith("agent-1"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Reset to ready" })).toBeNull(),
    );
  });

  it("offers no recovery control while the Agent is healthy", async () => {
    await mountWith([agent({ status: "ready" })]);
    expect(screen.queryByRole("button", { name: "Reset to ready" })).toBeNull();
    expect(screen.queryByText("This Agent stopped with an error")).toBeNull();
  });

  it("explains what resetting does without claiming it retries the run", async () => {
    await mountWith([agent({ status: "error", lastError: "provider unavailable" })]);
    const hint = screen.getByText(/Resetting returns the Agent to ready/);
    expect(hint.textContent).toContain("does not retry the failed run");
  });

  it("falls back to a plain sentence when the Agent carries no message", async () => {
    await mountWith([agent({ status: "error", lastError: null })]);
    expect(screen.getByText("The last run failed without a message.")).toBeTruthy();
  });
});

describe("Reservation message (P11-08)", () => {
  it("names the reserving session and offers a way to open it", async () => {
    await mountWith([agent({ status: "ready" })]);

    mockedApi.stopAgent.mockRejectedValue(
      new ApiError('Agent is reserved by the session "Launch plan review"', 409, "AGENT_RESERVED"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));

    const banner = await screen.findByRole("alert");
    // The message names the session rather than saying "reserved by coordination".
    expect(banner.textContent).toContain('Agent is reserved by the session "Launch plan review"');
    expect(banner.textContent).not.toContain("reserved by coordination");
    // No lease token, prompt, or run internals reach the user.
    expect(banner.textContent).not.toMatch(/lease/i);

    // The link is what makes the message actionable: it opens the session
    // surface and clears the reservation error.
    const view = screen.getByRole("button", { name: "View session" });
    await userEvent.click(view);
    await waitFor(() =>
      expect(screen.queryByText(/reserved by the session/)).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "View session" })).toBeNull();
  });

  it("offers no session link for an unrelated failure", async () => {
    await mountWith([agent({ status: "ready" })]);

    mockedApi.stopAgent.mockRejectedValue(new ApiError("Agent not found", 404, "NOT_FOUND"));
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));

    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("Agent not found");
    expect(screen.queryByRole("button", { name: "View session" })).toBeNull();
  });
});
