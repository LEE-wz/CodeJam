import type { AgentId, CoordinationParticipant } from "./types.js";

export type PrimarySelectionReason =
  | "explicit"
  | "sticky_award"
  | "specialization"
  | "default_agent"
  | "participant_order";

export interface PrimaryAgentSelectionInput {
  participants: ReadonlyArray<
    Pick<CoordinationParticipant, "agentId" | "specializationSnapshot">
  >;
  userMessage: string;
  explicitAgentId?: AgentId | undefined;
  previousAwardedAgentId?: AgentId | undefined;
  defaultAgentId?: AgentId | undefined;
  /** Agent IDs ready for work now. Omit when every participant is available. */
  availableAgentIds?: ReadonlySet<AgentId> | undefined;
}

export interface PrimaryAgentSelection {
  orderedCandidateIds: AgentId[];
  selectedAgentId?: AgentId;
  reason?: PrimarySelectionReason;
}

interface RankedTagCandidate {
  agentId: AgentId;
  participantIndex: number;
  matchedTagCount: number;
  matchedCharacterCount: number;
}

const normalizedTokens = (value: string): string[] =>
  value.normalize("NFKC").toLocaleLowerCase("und").match(/[\p{L}\p{N}]+/gu) ?? [];

const lexicalCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const specializationRank = (
  participant: PrimaryAgentSelectionInput["participants"][number],
  participantIndex: number,
  messageTokens: ReadonlySet<string>,
): RankedTagCandidate | undefined => {
  let matchedTagCount = 0;
  let matchedCharacterCount = 0;
  for (const focusArea of participant.specializationSnapshot?.focusAreas ?? []) {
    const tagTokens = normalizedTokens(focusArea);
    if (tagTokens.length === 0 || !tagTokens.every((token) => messageTokens.has(token))) {
      continue;
    }
    matchedTagCount += 1;
    matchedCharacterCount += tagTokens.reduce((total, token) => total + token.length, 0);
  }
  return matchedTagCount === 0
    ? undefined
    : {
        agentId: participant.agentId,
        participantIndex,
        matchedTagCount,
        matchedCharacterCount,
      };
};

/**
 * Pure deterministic primary selector for PA14-03.
 *
 * Availability filters only the final choice, not the candidate ordering. This
 * preserves auditable routing evidence when a preferred Agent is busy: callers
 * can show both the stable preference order and the first usable candidate.
 */
export const selectPrimaryAgent = (
  input: PrimaryAgentSelectionInput,
): PrimaryAgentSelection => {
  const participantIds = new Set(input.participants.map(({ agentId }) => agentId));
  const ordered: AgentId[] = [];
  const reasons = new Map<AgentId, PrimarySelectionReason>();
  const append = (agentId: AgentId | undefined, reason: PrimarySelectionReason): void => {
    if (agentId === undefined || !participantIds.has(agentId) || reasons.has(agentId)) return;
    ordered.push(agentId);
    reasons.set(agentId, reason);
  };

  append(input.explicitAgentId, "explicit");
  append(input.previousAwardedAgentId, "sticky_award");

  const messageTokens = new Set(normalizedTokens(input.userMessage));
  input.participants
    .map((participant, index) => specializationRank(participant, index, messageTokens))
    .filter((candidate): candidate is RankedTagCandidate => candidate !== undefined)
    .sort(
      (left, right) =>
        right.matchedTagCount - left.matchedTagCount ||
        right.matchedCharacterCount - left.matchedCharacterCount ||
        left.participantIndex - right.participantIndex ||
        lexicalCompare(left.agentId, right.agentId),
    )
    .forEach(({ agentId }) => append(agentId, "specialization"));

  append(input.defaultAgentId, "default_agent");
  input.participants.forEach(({ agentId }) => append(agentId, "participant_order"));

  const selectedAgentId = ordered.find(
    (agentId) => input.availableAgentIds === undefined || input.availableAgentIds.has(agentId),
  );
  return selectedAgentId === undefined
    ? { orderedCandidateIds: ordered }
    : {
        orderedCandidateIds: ordered,
        selectedAgentId,
        reason: reasons.get(selectedAgentId)!,
      };
};
