import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "./types";
import { UI_COORDINATION_FIXTURES, UI_SESSION_FIXTURES } from "./testing/coordination-fixtures";

vi.mock("./coordination-api", () => ({
  coordinationApi: {
    list: vi.fn(),
    create: vi.fn(),
    detail: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

import { coordinationApi } from "./coordination-api";
import { RelayWorkspace } from "./RelayWorkspace";

const agents: Agent[] = ["planner", "critic", "finalizer"].map((name) => ({
  id: `agent-${name}`,
  name: `Relay ${name}`,
  description: "",
  instructions: "",
  status: "ready",
  workspacePath: `/workspace/${name}`,
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-08-30T04:00:00.000Z",
  updatedAt: "2026-08-30T04:00:00.000Z",
}));

const mockedApi = coordinationApi as unknown as {
  [Key in keyof typeof coordinationApi]: ReturnType<typeof vi.fn>;
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("RelayWorkspace", () => {
  it.each(Object.entries(UI_COORDINATION_FIXTURES))("renders the %s evidence fixture", async (_name, fixture) => {
    mockedApi.list.mockResolvedValue({ runs: [fixture.run] });
    mockedApi.detail.mockResolvedValue(fixture);
    const { container } = render(<RelayWorkspace agents={agents} />);
    await screen.findByRole("heading", { name: fixture.run.name });
    const content = container.textContent ?? "";
    expect(content).toContain(fixture.run.status);
    for (const event of fixture.events) expect(content).toContain(event.type.replaceAll("_", " ").replaceAll(".", " · "));
    expect(content.toLowerCase()).not.toContain("leasetoken");
  });

  it.each(Object.entries(UI_SESSION_FIXTURES))("renders the %s session fixture", async (_name, fixture) => {
    mockedApi.list.mockResolvedValue({ runs: [fixture.run] });
    mockedApi.detail.mockResolvedValue(fixture);
    const { container } = render(<RelayWorkspace agents={agents} />);
    await screen.findByRole("heading", { name: fixture.run.name });
    expect(screen.getByText("Transcript")).toBeTruthy();
    expect(screen.getByText(fixture.run.policy.sessionProtocol === "free_chat" ? "Free chat" : "Countdown")).toBeTruthy();
    for (const artifact of fixture.artifacts) {
      if (artifact.type === "session_message") expect(container.textContent).toContain(artifact.payload.content);
    }
    expect(container.textContent?.toLowerCase()).not.toContain("leasetoken");
  });

  it("validates locally, preserves input, and keeps create and start as separate actions", async () => {
    const user = userEvent.setup();
    const created = { ...UI_COORDINATION_FIXTURES.completed, run: { ...UI_COORDINATION_FIXTURES.completed.run, id: "created-run", status: "created" as const, phase: "drafting" as const, name: "Verified handoff" } };
    mockedApi.list.mockResolvedValueOnce({ runs: [] }).mockResolvedValue({ runs: [created.run] });
    mockedApi.create.mockResolvedValue({ run: created.run });
    mockedApi.detail.mockResolvedValue(created);
    mockedApi.start.mockResolvedValue({ run: { ...created.run, status: "running" }, accepted: true });

    render(<RelayWorkspace agents={agents} />);
    await user.click(await screen.findByRole("button", { name: "Create Relay run" }));
    await user.click(screen.getByRole("button", { name: "Create run" }));
    expect(await screen.findByText(/objective between/i)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Objective"));
    expect(mockedApi.create).not.toHaveBeenCalled();

    const objective = screen.getByLabelText("Objective");
    await user.type(objective, "Produce a safe launch plan.");
    await user.click(screen.getByRole("button", { name: "Create run" }));
    await waitFor(() => expect(mockedApi.create).toHaveBeenCalledOnce());
    expect(mockedApi.start).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Start run" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(mockedApi.start).toHaveBeenCalledWith("created-run"));
    await waitFor(() => expect(mockedApi.detail).toHaveBeenCalledTimes(2));
  });

  it("creates a countdown session with ordered ready participants", async () => {
    const user = userEvent.setup();
    const fixture = UI_SESSION_FIXTURES.countdownRunning;
    const created = { ...fixture, run: { ...fixture.run, id: "created-session", status: "created" as const } };
    mockedApi.list.mockResolvedValueOnce({ runs: [] }).mockResolvedValue({ runs: [created.run] });
    mockedApi.create.mockResolvedValue({ run: created.run });
    mockedApi.detail.mockResolvedValue(created);

    render(<RelayWorkspace agents={agents} />);
    await user.click(await screen.findByRole("button", { name: "Create Relay run" }));
    await user.click(screen.getByRole("radio", { name: /Shared session/i }));
    await user.type(screen.getByLabelText("Objective"), "Count down together.");
    await user.click(screen.getByRole("button", { name: "Move Relay finalizer earlier" }));
    await user.click(screen.getByRole("button", { name: "Create run" }));

    await waitFor(() => expect(mockedApi.create).toHaveBeenCalledOnce());
    expect(mockedApi.create).toHaveBeenCalledWith({
      workflow: "shared_session_v1",
      name: "Shared session",
      objective: "Count down together.",
      agents: ["agent-planner", "agent-finalizer", "agent-critic"],
      policy: {
        sessionProtocol: "countdown",
        sessionStartValue: 10,
        maxTurns: 10,
        perAttemptTimeoutMs: 120_000,
      },
    });
    expect(mockedApi.start).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Start run" })).toBeTruthy();
  });

  it("validates session participant count, readiness, and protocol-specific limits", async () => {
    const user = userEvent.setup();
    mockedApi.list.mockResolvedValue({ runs: [] });
    render(<RelayWorkspace agents={agents} />);
    await user.click(await screen.findByRole("button", { name: "Create Relay run" }));
    await user.click(screen.getByRole("radio", { name: /Shared session/i }));
    await user.type(screen.getByLabelText("Objective"), "Coordinate a launch checklist.");
    await user.click(screen.getByRole("button", { name: "Remove Relay critic" }));
    await user.click(screen.getByRole("button", { name: "Remove Relay finalizer" }));
    await user.click(screen.getByRole("button", { name: "Create run" }));
    expect(await screen.findByText(/Choose 2-6 different ready Agents/i)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Participants and turn order" }));
    expect(mockedApi.create).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Relay criticAdd to session/i }));
    await user.click(screen.getByRole("radio", { name: "Free chat" }));
    const turns = screen.getByLabelText("Maximum turns");
    await user.clear(turns);
    await user.type(turns, "2");
    await user.click(screen.getByRole("button", { name: "Create run" }));
    expect(await screen.findByText(/Free-chat maximum turns/i)).toBeTruthy();
    expect(mockedApi.create).not.toHaveBeenCalled();
  });

  it("shows free-chat consensus, including a withdrawn done signal", async () => {
    const fixture = UI_SESSION_FIXTURES.freeChatWithdrawn;
    mockedApi.list.mockResolvedValue({ runs: [fixture.run] });
    mockedApi.detail.mockResolvedValue(fixture);
    render(<RelayWorkspace agents={agents} />);
    await screen.findByRole("heading", { name: fixture.run.name });
    const participantMap = screen.getByRole("region", { name: "Session participants" });
    expect(participantMap.textContent).toContain("Relay Plannerstill contributing");
    expect(participantMap.textContent).toContain("Relay Criticdone signalled");
  });

  it("renders session text as escaped content and exposes retry validation evidence", async () => {
    const fixture = UI_SESSION_FIXTURES.countdownRetry;
    const unsafe = {
      ...fixture,
      artifacts: fixture.artifacts.map((artifact, index) => artifact.type === "session_message" && index === 0
        ? { ...artifact, payload: { ...artifact.payload, content: "<script>alert('unsafe')</script>" } }
        : artifact),
    };
    mockedApi.list.mockResolvedValue({ runs: [unsafe.run] });
    mockedApi.detail.mockResolvedValue(unsafe);
    const { container } = render(<RelayWorkspace agents={agents} />);
    await screen.findByRole("heading", { name: unsafe.run.name });
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("<script>alert('unsafe')</script>")).toBeTruthy();
    expect(screen.getAllByText("Expected the next number 9, received 8").length).toBeGreaterThan(0);
  });

  it("uses one polling chain and stops it when unmounted", async () => {
    vi.useFakeTimers();
    const running = { ...UI_COORDINATION_FIXTURES.completed, run: { ...UI_COORDINATION_FIXTURES.completed.run, status: "running" as const, phase: "reviewing" as const } };
    mockedApi.list.mockResolvedValue({ runs: [running.run] });
    mockedApi.detail.mockResolvedValue(running);
    const view = render(<RelayWorkspace agents={agents} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mockedApi.detail).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(mockedApi.detail).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(mockedApi.detail).toHaveBeenCalledTimes(2);
  });

  it("cancels the prior polling chain when the selected run changes", async () => {
    vi.useFakeTimers();
    const first = { ...UI_SESSION_FIXTURES.countdownRunning, run: { ...UI_SESSION_FIXTURES.countdownRunning.run, id: "session-first", name: "First running session" } };
    const second = { ...UI_SESSION_FIXTURES.freeChatPartial, run: { ...UI_SESSION_FIXTURES.freeChatPartial.run, id: "session-second", name: "Second running session" } };
    mockedApi.list.mockResolvedValue({ runs: [first.run, second.run] });
    mockedApi.detail.mockImplementation((id: string) => Promise.resolve(id === first.run.id ? first : second));
    render(<RelayWorkspace agents={agents} />);

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mockedApi.detail.mock.calls.filter(([id]) => id === first.run.id)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Second running session/i }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mockedApi.detail.mock.calls.filter(([id]) => id === second.run.id)).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(mockedApi.detail.mock.calls.filter(([id]) => id === first.run.id)).toHaveLength(1);
    expect(mockedApi.detail.mock.calls.filter(([id]) => id === second.run.id)).toHaveLength(2);
  });

  it("does not poll again after a session reaches a terminal state", async () => {
    vi.useFakeTimers();
    const completed = UI_SESSION_FIXTURES.sessionCompleted;
    mockedApi.list.mockResolvedValue({ runs: [completed.run] });
    mockedApi.detail.mockResolvedValue(completed);
    render(<RelayWorkspace agents={agents} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mockedApi.detail).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(mockedApi.detail).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Countdown state")).toBeTruthy();
    expect(screen.getByText("Complete")).toBeTruthy();
  });

  it("sends one stop request and exposes a pending state", async () => {
    const running = { ...UI_COORDINATION_FIXTURES.completed, run: { ...UI_COORDINATION_FIXTURES.completed.run, status: "running" as const } };
    mockedApi.list.mockResolvedValue({ runs: [running.run] });
    mockedApi.detail.mockResolvedValue(running);
    let settle!: (value: unknown) => void;
    mockedApi.stop.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    render(<RelayWorkspace agents={agents} />);
    const button = await screen.findByRole("button", { name: "Stop run" });
    fireEvent.click(button);
    expect((await screen.findByRole("button", { name: "Stopping…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mockedApi.stop).toHaveBeenCalledTimes(1);
    await act(async () => settle({ run: { ...running.run, status: "stopped" }, accepted: true }));
  });
});
