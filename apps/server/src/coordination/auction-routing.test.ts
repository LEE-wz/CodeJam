import { describe, expect, it } from "vitest";
import { selectPrimaryAgent } from "./auction-routing.js";
import type { CoordinationParticipant } from "./types.js";

const participant = (
  agentId: string,
  focusAreas: string[] = [],
): CoordinationParticipant => ({
  role: "participant",
  agentId,
  agentNameSnapshot: agentId,
  ...(focusAreas.length === 0
    ? {}
    : {
        specializationSnapshot: {
          perspective: `${agentId} perspective`,
          focusAreas,
          biddingInstructions: "Bid concisely.",
        },
      }),
});

const roster = [
  participant("agent-first", ["security", "api design"]),
  participant("agent-second", ["security", "API-design"]),
  participant("agent-third", ["performance"]),
];

describe("deterministic primary selection", () => {
  it("prioritizes explicit selection, sticky ownership, specialization, default, then roster", () => {
    expect(
      selectPrimaryAgent({
        participants: roster,
        userMessage: "Review API design and security.",
        explicitAgentId: "agent-third",
        previousAwardedAgentId: "agent-second",
        defaultAgentId: "agent-first",
      }),
    ).toEqual({
      orderedCandidateIds: ["agent-third", "agent-second", "agent-first"],
      selectedAgentId: "agent-third",
      reason: "explicit",
    });
  });

  it("matches normalized whole tokens and resolves specialization ties by participant order", () => {
    const selection = selectPrimaryAgent({
      participants: roster,
      userMessage: "The ＡＰＩ-design needs a SECURITY review, not securitized prose.",
    });
    expect(selection.orderedCandidateIds).toEqual([
      "agent-first",
      "agent-second",
      "agent-third",
    ]);
    expect(selection).toMatchObject({
      selectedAgentId: "agent-first",
      reason: "specialization",
    });
  });

  it("uses matched tag count before matched character count", () => {
    const selection = selectPrimaryAgent({
      participants: [
        participant("one-long", ["security architecture"]),
        participant("two-tags", ["security", "architecture"]),
      ],
      userMessage: "Security architecture",
    });
    expect(selection.selectedAgentId).toBe("two-tags");
  });

  it("skips busy preferred Agents without changing the stable candidate order", () => {
    const selection = selectPrimaryAgent({
      participants: roster,
      userMessage: "Investigate performance",
      explicitAgentId: "agent-first",
      previousAwardedAgentId: "agent-second",
      availableAgentIds: new Set(["agent-third"]),
    });
    expect(selection).toEqual({
      orderedCandidateIds: ["agent-first", "agent-second", "agent-third"],
      selectedAgentId: "agent-third",
      reason: "specialization",
    });
  });

  it("falls through to the configured default and then participant order", () => {
    expect(
      selectPrimaryAgent({
        participants: roster,
        userMessage: "Unmatched request",
        defaultAgentId: "agent-second",
      }),
    ).toEqual({
      orderedCandidateIds: ["agent-second", "agent-first", "agent-third"],
      selectedAgentId: "agent-second",
      reason: "default_agent",
    });
    expect(
      selectPrimaryAgent({ participants: roster, userMessage: "Unmatched request" }),
    ).toMatchObject({ selectedAgentId: "agent-first", reason: "participant_order" });
  });

  it("ignores foreign hints and returns no selection when every participant is unavailable", () => {
    expect(
      selectPrimaryAgent({
        participants: roster,
        userMessage: "Unmatched request",
        explicitAgentId: "foreign",
        previousAwardedAgentId: "also-foreign",
        defaultAgentId: "not-enrolled",
        availableAgentIds: new Set(),
      }),
    ).toEqual({
      orderedCandidateIds: ["agent-first", "agent-second", "agent-third"],
    });
  });
});
