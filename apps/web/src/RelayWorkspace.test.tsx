import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "./types";
import { UI_COORDINATION_FIXTURES } from "./testing/coordination-fixtures";

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
