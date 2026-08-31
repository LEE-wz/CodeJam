import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "./types";
import { UI_AUCTION_FIXTURES } from "./testing/coordination-fixtures";

vi.mock("./coordination-api", () => ({
  coordinationApi: {
    list: vi.fn(),
    create: vi.fn(),
    detail: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    sendMessage: vi.fn(),
    end: vi.fn(),
    awardFeedback: vi.fn(),
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
const mockedApi = vi.mocked(coordinationApi);

const showFixture = async (fixture: keyof typeof UI_AUCTION_FIXTURES) => {
  const details = UI_AUCTION_FIXTURES[fixture];
  mockedApi.list.mockResolvedValue({ runs: [details.run] });
  mockedApi.detail.mockResolvedValue(details);
  render(<SessionWorkspace agents={agents} />);
  await screen.findByRole("heading", { level: 2, name: details.run.name });
  return details;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.awardFeedback.mockResolvedValue({
    run: UI_AUCTION_FIXTURES.auctionAwarded.run,
    accepted: true,
  });
});

afterEach(cleanup);

describe("PA14-16 auction routing surface", () => {
  it("shows the session routing policy without claiming an objectively best Agent", async () => {
    await showFixture("auctionAwarded");
    const policy = screen.getByLabelText("Auction routing");
    expect(policy.textContent).toContain("Auction");
    expect(policy.textContent).toContain("confidence_cost_v1");

    const award = screen.getByLabelText("Award summary");
    expect(award.textContent).toContain("Highest-ranked valid bid");
    expect(award.textContent).not.toMatch(/best agent/i);
  });

  it("attributes the award to the selected Agent and its awarded plan", async () => {
    await showFixture("auctionAwarded");
    const award = screen.getByLabelText("Award summary");
    expect(award.textContent).toContain("Relay Finaliser");
    expect(award.textContent).toContain("execute plan");
    expect(award.textContent).toContain("single");
  });

  it("shows projected execution tokens beside the actual ones", async () => {
    await showFixture("auctionAwarded");
    const award = screen.getByLabelText("Award summary");
    expect(award.textContent).toContain("2400 in · 900 out");
    expect(award.textContent).toContain("2600 in · 1100 out");

    const split = screen.getByLabelText("Bidding and execution token usage");
    expect(split.textContent).toContain("bids 360 in / 180 out");
    expect(split.textContent).toContain("execution 2600 in / 1100 out");
    expect(split.textContent).toContain("projected execution 2400 in / 900 out");
  });

  it("keeps bids out of the transcript while leaving them inspectable", async () => {
    await showFixture("auctionAwarded");
    const transcript = screen.getByLabelText("Session transcript");
    expect(transcript.textContent).toContain("Roll back in three staged steps.");
    expect(transcript.textContent).not.toContain("Plan from Relay Planner.");

    const panel = screen.getByText(/Bid evidence \(3\)/);
    await userEvent.click(panel);
    expect(document.body.textContent).toContain("Plan from Relay Planner.");
    expect(document.body.textContent).toContain("Self-reported confidence");
  });

  it("distinguishes evaluating bids from executing the awarded plan", async () => {
    await showFixture("auctionBidding");
    const composer = (await screen.findByLabelText("Message the session")) as HTMLTextAreaElement;
    expect(composer.placeholder).toContain("Collecting and evaluating bids");
    expect(composer.disabled).toBe(true);
  });

  it("explains a fallback round instead of implying it was selected on merit", async () => {
    await showFixture("auctionFallback");
    const award = screen.getByLabelText("Award summary");
    expect(award.textContent).toContain("No bid met the minimum");
    expect(award.textContent).toContain("round robin");
    expect(award.textContent).not.toContain("Highest-ranked valid bid");
  });
});

describe("PA14-14 per-message routing controls", () => {
  it("sends the requested routing without any budget field", async () => {
    const details = await showFixture("auctionAwarded");
    mockedApi.sendMessage.mockResolvedValue({ run: details.run, accepted: true });

    const routing = screen.getByLabelText("Routing for this message");
    await userEvent.selectOptions(routing, "direct");
    await userEvent.selectOptions(
      screen.getByLabelText("Agent for this message"),
      "agent-critic",
    );
    await userEvent.type(screen.getByLabelText("Message the session"), "Next question");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(mockedApi.sendMessage).toHaveBeenCalledOnce());
    const [, content, , sentRouting] = mockedApi.sendMessage.mock.calls[0]!;
    expect(content).toBe("Next question");
    expect(sentRouting).toEqual({ routingMode: "direct", selectedAgentId: "agent-critic" });
  });

  it("forces an auction for a high-risk message", async () => {
    const details = await showFixture("auctionAwarded");
    mockedApi.sendMessage.mockResolvedValue({ run: details.run, accepted: true });

    await userEvent.click(screen.getByLabelText(/High-risk request/i));
    await userEvent.type(screen.getByLabelText("Message the session"), "Risky change");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(mockedApi.sendMessage).toHaveBeenCalledOnce());
    expect(mockedApi.sendMessage.mock.calls[0]![3]).toEqual({
      riskLevel: "high",
      routingMode: "auction",
    });
  });
});

describe("PA14-17 award feedback", () => {
  it("records an optional rating and labels confidence as self-reported", async () => {
    const details = await showFixture("auctionAwarded");
    const awardArtifact = details.artifacts.find(({ type }) => type === "session_award")!;

    await userEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => expect(mockedApi.awardFeedback).toHaveBeenCalledOnce());
    expect(mockedApi.awardFeedback).toHaveBeenCalledWith(
      details.run.id,
      awardArtifact.id,
      "accepted",
    );
    const award = screen.getByLabelText("Award summary");
    expect(award.textContent).toContain("Recorded: accepted");
    expect(award.textContent).toContain("Confidence remains self-reported");
    expect(screen.getByRole("button", { name: "Accept" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});
