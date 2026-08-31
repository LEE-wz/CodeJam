import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "./types";
import { SESSION_LIMITS } from "./coordination-types";
import { UI_COORDINATION_FIXTURES, UI_SESSION_FIXTURES } from "./testing/coordination-fixtures";

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

const agent = (name: string): Agent => ({
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
});

const agents: Agent[] = ["planner", "critic", "finalizer"].map(agent);

/** Ten ready Agents, for the widened participant ceiling (P10-03). */
const tenAgents: Agent[] = Array.from({ length: 10 }, (_unused, index) =>
  agent(`member-${index + 1}`),
);

const mockedApi = coordinationApi as unknown as {
  [Key in keyof typeof coordinationApi]: ReturnType<typeof vi.fn>;
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("SessionWorkspace", () => {
  it.each(Object.entries(UI_SESSION_FIXTURES))("renders the %s session fixture", async (_name, fixture) => {
    mockedApi.list.mockResolvedValue({ runs: [fixture.run] });
    mockedApi.detail.mockResolvedValue(fixture);
    const { container } = render(<SessionWorkspace agents={agents} />);
    await screen.findByRole("heading", { name: fixture.run.name });
    expect(screen.getByText("Transcript")).toBeTruthy();
    for (const artifact of fixture.artifacts) {
      if (artifact.type === "session_message") expect(container.textContent).toContain(artifact.payload.content);
    }
    for (const event of fixture.events) {
      expect(container.textContent).toContain(event.type.replaceAll("_", " ").replaceAll(".", " · "));
    }
    expect(container.textContent?.toLowerCase()).not.toContain("leasetoken");
  });

  // P10-06: the verified-handoff workflow is gone from this app, but its runs
  // are still evidence and must still open.
  it.each(Object.entries(UI_COORDINATION_FIXTURES))("renders the %s legacy verified run read-only", async (_name, fixture) => {
    mockedApi.list.mockResolvedValue({ runs: [fixture.run] });
    mockedApi.detail.mockResolvedValue(fixture);
    const { container } = render(<SessionWorkspace agents={agents} />);
    await screen.findByRole("heading", { name: fixture.run.name });
    expect(screen.getByText("Legacy workflow")).toBeTruthy();
    expect(screen.queryByText("Transcript")).toBeNull();
    for (const event of fixture.events) {
      expect(container.textContent).toContain(event.type.replaceAll("_", " ").replaceAll(".", " · "));
    }
    expect(container.textContent?.toLowerCase()).not.toContain("leasetoken");
  });

  it("offers no start or stop action on a legacy verified run", async () => {
    const fixture = UI_COORDINATION_FIXTURES.completed;
    const created = { ...fixture, run: { ...fixture.run, status: "created" as const } };
    mockedApi.list.mockResolvedValue({ runs: [created.run] });
    mockedApi.detail.mockResolvedValue(created);
    render(<SessionWorkspace agents={agents} />);
    await screen.findByRole("heading", { name: created.run.name });
    expect(screen.getByText("Legacy workflow")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start session" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Stop wave/ })).toBeNull();
  });

  // P10-07: countdown is no longer creatable, but a stored countdown session
  // keeps its transcript and its shared state.
  it("renders a stored countdown session with its shared state", async () => {
    const fixture = UI_SESSION_FIXTURES.countdownRunning;
    mockedApi.list.mockResolvedValue({ runs: [fixture.run] });
    mockedApi.detail.mockResolvedValue(fixture);
    render(<SessionWorkspace agents={agents} />);
    await screen.findByRole("heading", { name: fixture.run.name });
    expect(screen.getByText("Countdown")).toBeTruthy();
    expect(screen.getByText("Next expected number")).toBeTruthy();
    expect(screen.getByText("Transcript")).toBeTruthy();
  });

  it("creates a free-chat session with ordered ready participants and no protocol choice", async () => {
    const user = userEvent.setup();
    const fixture = UI_SESSION_FIXTURES.freeChatPartial;
    const created = { ...fixture, run: { ...fixture.run, id: "created-session", status: "created" as const } };
    mockedApi.list.mockResolvedValueOnce({ runs: [] }).mockResolvedValue({ runs: [created.run] });
    mockedApi.create.mockResolvedValue({ run: created.run });
    mockedApi.detail.mockResolvedValue(created);

    render(<SessionWorkspace agents={agents} />);
    await user.click(await screen.findByRole("button", { name: "Create session" }));

    // The workflow and protocol choices are gone: there is nothing to select.
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByLabelText(/Countdown start/i)).toBeNull();

    await user.type(screen.getByLabelText("Objective"), "Agree a launch checklist.");
    await user.click(screen.getByRole("button", { name: "Move Relay finalizer earlier" }));
    await user.click(screen.getByRole("button", { name: "Create session" }));

    await waitFor(() => expect(mockedApi.create).toHaveBeenCalledOnce());
    expect(mockedApi.create).toHaveBeenCalledWith({
      workflow: "shared_session_v1",
      name: "Shared session",
      objective: "Agree a launch checklist.",
      agents: ["agent-planner", "agent-finalizer", "agent-critic"],
      policy: {
        sessionProtocol: "free_chat",
        maxTurns: SESSION_LIMITS.defaultSessionTurns,
        perAttemptTimeoutMs: 120_000,
      },
    });
    expect(mockedApi.start).not.toHaveBeenCalled();
    expect(await screen.findByLabelText("Message the session")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(true);
  });

  // P10-03: ten participants can be selected and are sent in picker order.
  it("accepts a session with the maximum participants", async () => {
    const user = userEvent.setup();
    const fixture = UI_SESSION_FIXTURES.freeChatPartial;
    const created = { ...fixture, run: { ...fixture.run, id: "created-session", status: "created" as const } };
    mockedApi.list.mockResolvedValueOnce({ runs: [] }).mockResolvedValue({ runs: [created.run] });
    mockedApi.create.mockResolvedValue({ run: created.run });
    mockedApi.detail.mockResolvedValue(created);

    render(<SessionWorkspace agents={tenAgents} />);
    await user.click(await screen.findByRole("button", { name: "Create session" }));
    await user.type(screen.getByLabelText("Objective"), "Coordinate ten Agents.");
    for (const member of tenAgents.slice(3)) {
      await user.click(screen.getByRole("button", { name: `${member.name}Add to session` }));
    }
    await user.click(screen.getByRole("button", { name: "Create session" }));

    await waitFor(() => expect(mockedApi.create).toHaveBeenCalledOnce());
    expect(mockedApi.create.mock.calls[0]![0].agents).toEqual(tenAgents.map(({ id }) => id));
    expect(mockedApi.create.mock.calls[0]![0].agents).toHaveLength(SESSION_LIMITS.maxParticipants);
  });

  it("stops offering Agents once the participant ceiling is reached", async () => {
    const user = userEvent.setup();
    const eleven = [...tenAgents, agent("member-11")];
    mockedApi.list.mockResolvedValue({ runs: [] });
    render(<SessionWorkspace agents={eleven} />);
    await user.click(await screen.findByRole("button", { name: "Create session" }));
    for (const member of eleven.slice(3, 10)) {
      await user.click(screen.getByRole("button", { name: `${member.name}Add to session` }));
    }
    const overflow = screen.getByRole("button", { name: "Relay member-11Add to session" }) as HTMLButtonElement;
    expect(overflow.disabled).toBe(true);
  });

  it("validates participant count, readiness, and the session turn range", async () => {
    const user = userEvent.setup();
    mockedApi.list.mockResolvedValue({ runs: [] });
    render(<SessionWorkspace agents={agents} />);
    await user.click(await screen.findByRole("button", { name: "Create session" }));
    await user.type(screen.getByLabelText("Objective"), "Coordinate a launch checklist.");
    await user.click(screen.getByRole("button", { name: "Remove Relay critic" }));
    await user.click(screen.getByRole("button", { name: "Remove Relay finalizer" }));
    await user.click(screen.getByRole("button", { name: "Create session" }));
    expect(await screen.findByText(/Choose 2-10 different ready Agents/i)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Participants and turn order" }));
    expect(mockedApi.create).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Relay criticAdd to session/i }));
    const turns = screen.getByLabelText("Maximum turns");
    await user.clear(turns);
    await user.type(turns, "2");
    await user.click(screen.getByRole("button", { name: "Create session" }));
    expect(await screen.findByText(/Maximum turns must be an integer/i)).toBeTruthy();
    expect(mockedApi.create).not.toHaveBeenCalled();
  });

  // P10-04: a ceiling the pre-v2 form would have rejected is now accepted.
  it("accepts a turn ceiling above the old twelve-turn limit", async () => {
    const user = userEvent.setup();
    const fixture = UI_SESSION_FIXTURES.freeChatPartial;
    const created = { ...fixture, run: { ...fixture.run, id: "created-session", status: "created" as const } };
    mockedApi.list.mockResolvedValueOnce({ runs: [] }).mockResolvedValue({ runs: [created.run] });
    mockedApi.create.mockResolvedValue({ run: created.run });
    mockedApi.detail.mockResolvedValue(created);

    render(<SessionWorkspace agents={agents} />);
    await user.click(await screen.findByRole("button", { name: "Create session" }));
    await user.type(screen.getByLabelText("Objective"), "Hold a long session.");
    const turns = screen.getByLabelText("Maximum turns");
    await user.clear(turns);
    await user.type(turns, "5000");
    await user.click(screen.getByRole("button", { name: "Create session" }));

    await waitFor(() => expect(mockedApi.create).toHaveBeenCalledOnce());
    expect(mockedApi.create.mock.calls[0]![0].policy.maxTurns).toBe(5_000);
  });

  it("shows free-chat consensus, including a withdrawn done signal", async () => {
    const fixture = UI_SESSION_FIXTURES.freeChatWithdrawn;
    mockedApi.list.mockResolvedValue({ runs: [fixture.run] });
    mockedApi.detail.mockResolvedValue(fixture);
    render(<SessionWorkspace agents={agents} />);
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
    const { container } = render(<SessionWorkspace agents={agents} />);
    await screen.findByRole("heading", { name: unsafe.run.name });
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("<script>alert('unsafe')</script>")).toBeTruthy();
    expect(screen.getAllByText("Expected the next number 9, received 8").length).toBeGreaterThan(0);
  });

  it("uses one polling chain and stops it when unmounted", async () => {
    vi.useFakeTimers();
    const running = UI_SESSION_FIXTURES.freeChatPartial;
    mockedApi.list.mockResolvedValue({ runs: [running.run] });
    mockedApi.detail.mockResolvedValue(running);
    const view = render(<SessionWorkspace agents={agents} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mockedApi.detail).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(mockedApi.detail).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(mockedApi.detail).toHaveBeenCalledTimes(2);
  });

  it("cancels the prior polling chain when the selected session changes", async () => {
    vi.useFakeTimers();
    const first = { ...UI_SESSION_FIXTURES.countdownRunning, run: { ...UI_SESSION_FIXTURES.countdownRunning.run, id: "session-first", name: "First running session" } };
    const second = { ...UI_SESSION_FIXTURES.freeChatPartial, run: { ...UI_SESSION_FIXTURES.freeChatPartial.run, id: "session-second", name: "Second running session" } };
    mockedApi.list.mockResolvedValue({ runs: [first.run, second.run] });
    mockedApi.detail.mockImplementation((id: string) => Promise.resolve(id === first.run.id ? first : second));
    render(<SessionWorkspace agents={agents} />);

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
    render(<SessionWorkspace agents={agents} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mockedApi.detail).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(mockedApi.detail).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Countdown state")).toBeTruthy();
    expect(screen.getByText("Complete")).toBeTruthy();
  });

  it("sends one stop request and exposes a pending state", async () => {
    const running = UI_SESSION_FIXTURES.freeChatPartial;
    mockedApi.list.mockResolvedValue({ runs: [running.run] });
    mockedApi.detail.mockResolvedValue(running);
    let settle!: (value: unknown) => void;
    mockedApi.stop.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    render(<SessionWorkspace agents={agents} />);
    const button = await screen.findByRole("button", { name: "Stop wave" });
    fireEvent.click(button);
    expect((await screen.findByRole("button", { name: "Stopping…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mockedApi.stop).toHaveBeenCalledTimes(1);
    await act(async () => settle({ run: { ...running.run, status: "stopped" }, accepted: true }));
  });

  it("disables the labelled composer and announces that Agents are working", async () => {
    const running = UI_SESSION_FIXTURES.freeChatPartial;
    mockedApi.list.mockResolvedValue({ runs: [running.run] });
    mockedApi.detail.mockResolvedValue(running);
    render(<SessionWorkspace agents={agents} />);
    const composer = await screen.findByLabelText("Message the session") as HTMLTextAreaElement;
    expect(composer.disabled).toBe(true);
    expect(composer.placeholder).toBe("Agents are working…");
    expect(screen.getByText(/Agents are working\. Stop ends only this wave/i)).toBeTruthy();
  });

  it("renders user and Agent messages as distinct ordered transcript entries", async () => {
    const base = UI_SESSION_FIXTURES.freeChatPartial;
    const sourceAgentArtifact = base.artifacts.find((artifact) => artifact.type === "session_message");
    if (!sourceAgentArtifact) throw new Error("expected session fixture message");
    const agentArtifact = {
      ...sourceAgentArtifact,
      transcriptSequence: 2,
    };
    const userArtifact = {
      id: "artifact-user-visible",
      runId: base.run.id,
      type: "user_message" as const,
      payload: { schemaVersion: 1 as const, type: "user_message" as const, content: "Please prioritize safety" },
      createdBy: { kind: "user" as const },
      transcriptSequence: 1,
      sizeChars: 24,
      createdAt: base.run.createdAt,
    };
    const idle = {
      ...base,
      run: { ...base.run, status: "awaiting_input" as const },
      artifacts: [agentArtifact, userArtifact],
    };
    mockedApi.list.mockResolvedValue({ runs: [idle.run] });
    mockedApi.detail.mockResolvedValue(idle);
    const { container } = render(<SessionWorkspace agents={agents} />);
    const transcript = await screen.findByRole("list", { name: "Session transcript" });
    expect(transcript.textContent?.indexOf("Please prioritize safety"))
      .toBeLessThan(transcript.textContent?.indexOf(agentArtifact.payload.content) ?? -1);
    const userEntry = container.querySelector(".transcript-message-user");
    expect(userEntry?.textContent).toContain("YouUser message");
    expect(userEntry?.textContent).toContain("Please prioritize safety");
    expect(container.querySelectorAll(".transcript-message:not(.transcript-message-user)")).toHaveLength(1);
  });

  it("appends delta polling results without replacing the existing transcript", async () => {
    vi.useFakeTimers();
    const initial = UI_SESSION_FIXTURES.freeChatPartial;
    const initialMessage = initial.artifacts.find((artifact) => artifact.type === "session_message");
    if (!initialMessage) throw new Error("expected session fixture message");
    const cursor = initial.events.at(-1)!.sequence + 1;
    const deltaArtifact = {
      id: "artifact-user-delta",
      runId: initial.run.id,
      type: "user_message" as const,
      payload: { schemaVersion: 1 as const, type: "user_message" as const, content: "A later user prompt" },
      createdBy: { kind: "user" as const },
      transcriptSequence: 99,
      sizeChars: 19,
      createdAt: initial.run.createdAt,
    };
    const delta = {
      run: { ...initial.run, status: "awaiting_input" as const },
      turns: [],
      attempts: [],
      artifacts: [deltaArtifact],
      events: [{
        id: "event-user-delta",
        runId: initial.run.id,
        sequence: cursor,
        type: "user.message_appended" as const,
        actor: { type: "user" as const },
        artifactId: deltaArtifact.id,
        message: "User message appended.",
        details: { transcriptSequence: 99 },
        createdAt: initial.run.createdAt,
      }],
      cursor: cursor + 1,
    };
    mockedApi.list.mockResolvedValue({ runs: [initial.run] });
    mockedApi.detail.mockResolvedValueOnce(initial).mockResolvedValueOnce(delta);
    render(<SessionWorkspace agents={agents} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText(initialMessage.payload.content)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(screen.getByText(initialMessage.payload.content)).toBeTruthy();
    expect(screen.getByText("A later user prompt")).toBeTruthy();
    expect(mockedApi.detail.mock.calls[1]?.[2]).toBe(cursor);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(mockedApi.detail).toHaveBeenCalledTimes(2);
  });

  it("allows Stop then Send as separate wave actions", async () => {
    const running = UI_SESSION_FIXTURES.freeChatPartial;
    const idle = { ...running, run: { ...running.run, status: "awaiting_input" as const } };
    mockedApi.list.mockResolvedValue({ runs: [running.run] });
    mockedApi.detail.mockResolvedValueOnce(running).mockResolvedValue(idle);
    mockedApi.stop.mockResolvedValue({ run: idle.run, accepted: true });
    mockedApi.sendMessage.mockResolvedValue({
      run: { ...idle.run, status: "running" as const },
      accepted: true,
    });
    const user = userEvent.setup();
    render(<SessionWorkspace agents={agents} />);
    await user.click(await screen.findByRole("button", { name: "Stop wave" }));
    const composer = await screen.findByLabelText("Message the session");
    await waitFor(() => expect((composer as HTMLTextAreaElement).disabled).toBe(false));
    await user.type(composer, "Continue with a smaller scope");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(mockedApi.sendMessage).toHaveBeenCalledOnce());
    expect(mockedApi.sendMessage.mock.calls[0]?.slice(0, 2)).toEqual([
      running.run.id,
      "Continue with a smaller scope",
    ]);
    expect(typeof mockedApi.sendMessage.mock.calls[0]?.[2]).toBe("string");
    await waitFor(() => expect(mockedApi.detail.mock.calls.length).toBeGreaterThanOrEqual(3));
    const expectedCursor = running.events.at(-1)!.sequence + 1;
    expect(mockedApi.detail.mock.calls.slice(1).every((call) => call[2] === expectedCursor)).toBe(true);
  });

  it("ends an idle session permanently and disables its composer", async () => {
    const base = UI_SESSION_FIXTURES.freeChatPartial;
    const idle = { ...base, run: { ...base.run, status: "awaiting_input" as const } };
    const ended = { ...idle.run, status: "completed" as const, endedByUser: true };
    mockedApi.list.mockResolvedValue({ runs: [idle.run] });
    mockedApi.detail.mockResolvedValue(idle);
    mockedApi.end.mockResolvedValue({ run: ended, accepted: true });
    const user = userEvent.setup();
    render(<SessionWorkspace agents={agents} />);
    await user.click(await screen.findByRole("button", { name: "End session" }));
    expect(await screen.findByText("This session has ended.")).toBeTruthy();
    expect((screen.getByLabelText("Message the session") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "End session" })).toBeNull();
  });

  it("keeps a long transcript in a bounded scrollable region", async () => {
    const base = UI_SESSION_FIXTURES.freeChatPartial;
    const long = {
      ...base,
      run: { ...base.run, status: "awaiting_input" as const },
      artifacts: Array.from({ length: 80 }, (_unused, index) => ({
        ...base.artifacts[index % base.artifacts.length]!,
        id: `artifact-long-${index}`,
        transcriptSequence: index + 1,
        payload: {
          ...base.artifacts[index % base.artifacts.length]!.payload,
          content: `Long transcript message ${index}`,
        },
      })),
    };
    mockedApi.list.mockResolvedValue({ runs: [long.run] });
    mockedApi.detail.mockResolvedValue(long);
    render(<SessionWorkspace agents={agents} />);
    const transcript = await screen.findByRole("list", { name: "Session transcript" });
    const style = window.getComputedStyle(transcript);
    expect(style.maxHeight).toBe("34rem");
    expect(style.overflowY).toBe("auto");
    expect(transcript.children).toHaveLength(80);
  });
});
