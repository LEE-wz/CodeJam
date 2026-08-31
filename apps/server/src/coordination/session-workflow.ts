import type { SharedSessionWorkflow, WorkflowDecision, WorkflowView } from "./contracts.js";
import { selectPrimaryAgent } from "./auction-routing.js";
import type {
  AgentId,
  CoordinationArtifact,
  CoordinationArtifactId,
  CoordinationParticipant,
  CoordinationWavePurpose,
} from "./types.js";
import { SESSION_LIMITS } from "./types.js";

export type { SharedSessionWorkflow } from "./contracts.js";

type SessionArtifact = Extract<CoordinationArtifact, { type: "session_message" }>;
type BidArtifact = Extract<CoordinationArtifact, { type: "session_bid" }>;
type AwardArtifact = Extract<CoordinationArtifact, { type: "session_award" }>;
type UserArtifact = Extract<CoordinationArtifact, { type: "user_message" }>;

const invalidState = (message: string): WorkflowDecision => ({
  kind: "fail",
  code: "INVALID_STATE",
  message,
});

const isPositiveInteger = (value: number): boolean =>
  Number.isInteger(value) && value > 0;

interface ValidSessionView {
  participants: CoordinationParticipant[];
  committedArtifacts: SessionArtifact[];
  bidArtifacts: BidArtifact[];
  awardArtifacts: AwardArtifact[];
  transcriptArtifacts: Array<SessionArtifact | UserArtifact>;
  turns: WorkflowView["turns"];
}

/**
 * Pre-auction turns and every verified-handoff turn are execution turns; the
 * field is optional on stored history and normalized here on read (PA13-03).
 */
const turnPurpose = (turn: { wavePurpose?: CoordinationWavePurpose }): CoordinationWavePurpose =>
  turn.wavePurpose ?? "session_execution";

const validateSessionView = (
  view: WorkflowView,
): ValidSessionView | WorkflowDecision => {
  const { run } = view;
  if (run.policy.workflow !== "shared_session_v1") {
    return invalidState("Shared session workflow requires a shared-session run");
  }
  if (
    (run.status !== "running" && run.status !== "awaiting_input") ||
    run.phase !== "sessioning"
  ) {
    return invalidState("Session decisions require a live session run");
  }
  if (run.activeTurnIds.length > 0) {
    return invalidState("Session workflow cannot schedule while a turn is active");
  }
  if (!isPositiveInteger(run.nextTurnSequence) || run.revision !== 0) {
    return invalidState("Session run has invalid sequence or revision state");
  }
  if (
    !isPositiveInteger(run.policy.maxTurns) ||
    (run.policy.sessionProtocol !== "countdown" &&
      run.policy.sessionProtocol !== "free_chat")
  ) {
    return invalidState("Session run has an invalid policy");
  }

  const participants = run.participants;
  const participantIds = new Set(participants.map(({ agentId }) => agentId));
  if (
    participants.length < SESSION_LIMITS.minParticipants ||
    participants.length > SESSION_LIMITS.maxParticipants ||
    participantIds.size !== participants.length ||
    participants.some(({ role }) => role !== "participant")
  ) {
    return invalidState("Session run has invalid participants");
  }

  const turns = view.turns.filter(({ runId }) => runId === run.id);
  const artifacts = view.artifacts.filter(({ runId }) => runId === run.id);
  if (
    artifacts.some(
      ({ type }) =>
        type !== "session_bid" &&
        type !== "session_award" &&
        type !== "session_message" &&
        type !== "user_message",
    )
  ) {
    return invalidState("Session run contains a non-session artifact");
  }

  // PA13-14: history may now be concurrent, so identity, sequence, attribution,
  // and wave purpose are each checked explicitly rather than being implied by a
  // strictly ordered one-turn-at-a-time transcript.
  const runPurpose: CoordinationWavePurpose = run.policy.sessionWavePurpose ?? "session_execution";
  const turnIds = new Set<string>();
  const sequences = new Set<number>();
  for (const turn of turns) {
    if (
      turnIds.has(turn.id) ||
      sequences.has(turn.sequence) ||
      !isPositiveInteger(turn.sequence) ||
      turn.sequence >= run.nextTurnSequence ||
      (turn.kind !== "session_turn" &&
        (run.policy.auctionPolicy === undefined || turn.kind !== "session_bid")) ||
      turn.role !== "participant" ||
      !participantIds.has(turn.agentId) ||
      turnPurpose(turn) !==
        (run.policy.auctionPolicy === undefined
          ? runPurpose
          : turn.kind === "session_bid"
            ? "session_bidding"
            : "session_execution") ||
      !["committed", "cancelled", "failed"].includes(turn.status)
    ) {
      return invalidState("Session run contains an invalid turn");
    }
    turnIds.add(turn.id);
    sequences.add(turn.sequence);
  }

  const artifactIds = new Set<string>();
  const artifactsById = new Map<string, CoordinationArtifact>();
  for (const artifact of artifacts) {
    if (artifactIds.has(artifact.id)) {
      return invalidState("Session run has duplicate artifact identity");
    }
    artifactIds.add(artifact.id);
    artifactsById.set(artifact.id, artifact);
  }

  // A wave's members commit in whatever order their Agents finish, so
  // round-robin position is asserted only for sequential runs. Attribution is
  // asserted for both: an artifact must belong to its own turn and to the Agent
  // that turn was routed to.
  const isWaveRun = run.policy.sessionWaveMode === "parallel";
  const isLegacyRun = run.policy.auctionPolicy === undefined;
  const committedTurns = [...turns].sort((left, right) => left.sequence - right.sequence);
  const committedArtifacts: SessionArtifact[] = [];
  const bidArtifacts: BidArtifact[] = [];
  for (const turn of committedTurns) {
    if (turn.status !== "committed") continue;
    const expectedParticipant = participants[committedArtifacts.length % participants.length];
    const artifact = turn.outputArtifactId
      ? artifactsById.get(turn.outputArtifactId)
      : undefined;
    if (
      !artifact ||
      artifact.turnId !== turn.id ||
      artifact.createdByRole !== "participant" ||
      artifact.createdByAgentId !== turn.agentId
    ) {
      return invalidState("Committed session turn has invalid routing or output");
    }
    if (turn.kind === "session_turn" && artifact.type === "session_message") {
      if (
        isLegacyRun &&
        !isWaveRun &&
        (!expectedParticipant || turn.agentId !== expectedParticipant.agentId)
      ) {
        return invalidState("Committed session turn has invalid routing or output");
      }
      committedArtifacts.push(artifact);
      continue;
    }
    if (turn.kind === "session_bid" && artifact.type === "session_bid") {
      bidArtifacts.push(artifact);
      continue;
    }
    return invalidState("Committed session turn has the wrong artifact type");
  }
  const publishedCandidates = artifacts.filter(
    (artifact): artifact is SessionArtifact & { sourceBidArtifactId: CoordinationArtifactId } =>
      artifact.type === "session_message" && artifact.sourceBidArtifactId !== undefined,
  );
  for (const projection of publishedCandidates) {
    const source = artifactsById.get(projection.sourceBidArtifactId);
    if (
      !source ||
      source.type !== "session_bid" ||
      source.turnId !== projection.turnId ||
      source.createdByAgentId !== projection.createdByAgentId ||
      source.payload.candidateAnswer?.trim() !== projection.payload.content
    ) {
      return invalidState("Published Auto candidate has invalid provenance");
    }
    committedArtifacts.push(projection);
  }
  const userArtifacts = artifacts.filter(
    (artifact): artifact is UserArtifact => artifact.type === "user_message",
  );
  // Awards are backend-authored and turn-less, so they are counted here rather
  // than derived from a committed turn like every Agent-authored artifact.
  const awardArtifacts = artifacts.filter(
    (artifact): artifact is AwardArtifact => artifact.type === "session_award",
  );
  if (
    committedArtifacts.length +
      bidArtifacts.length +
      awardArtifacts.length +
      userArtifacts.length !==
    artifacts.length
  ) {
    return invalidState("Session run contains an uncommitted artifact");
  }
  if (
    awardArtifacts.length !==
    new Set(awardArtifacts.map(({ payload }) => payload.userArtifactId)).size
  ) {
    return invalidState("Session run has more than one award for a user message");
  }

  const transcriptArtifacts = [...committedArtifacts, ...userArtifacts].sort((left, right) => {
    const leftSequence = left.transcriptSequence ?? Number.MIN_SAFE_INTEGER;
    const rightSequence = right.transcriptSequence ?? Number.MIN_SAFE_INTEGER;
    return leftSequence - rightSequence || left.createdAt.localeCompare(right.createdAt);
  });

  return {
    participants,
    committedArtifacts,
    bidArtifacts,
    awardArtifacts,
    transcriptArtifacts,
    turns,
  };
};

const validateCountdownState = (
  view: WorkflowView,
  artifacts: SessionArtifact[],
): WorkflowDecision | undefined => {
  const { run } = view;
  const startValue = run.policy.sessionStartValue;
  const nextExpectedNumber = run.sharedState?.nextExpectedNumber;
  if (
    !isPositiveInteger(startValue ?? 0) ||
    typeof nextExpectedNumber !== "number" ||
    !Number.isInteger(nextExpectedNumber)
  ) {
    return invalidState("Countdown session has missing or invalid shared state");
  }

  for (const [index, artifact] of artifacts.entries()) {
    const value = Number(artifact.payload.content);
    if (
      !Number.isInteger(value) ||
      value !== startValue! - index ||
      artifact.payload.done !== undefined
    ) {
      return invalidState("Countdown transcript is inconsistent with shared state");
    }
  }
  if (nextExpectedNumber !== startValue! - artifacts.length) {
    return invalidState("Countdown transcript is inconsistent with shared state");
  }
  return undefined;
};

const finalArtifactId = (
  artifacts: SessionArtifact[],
): CoordinationArtifactId | undefined => artifacts.at(-1)?.id;

/**
 * Backend-owned bid-wave shape shared by explicit Auction and the PA14-07 Auto
 * escalation path. A primary Agent that already used its one bid opportunity
 * is excluded by identity; participant order remains the durable tie-break.
 */
export const buildSessionBidWaveDecision = (input: {
  participants: readonly CoordinationParticipant[];
  inputArtifactIds: readonly CoordinationArtifactId[];
  priorBidAgentIds?: ReadonlySet<AgentId>;
}): Extract<WorkflowDecision, { kind: "schedule_wave" }> => ({
  kind: "schedule_wave",
  wavePurpose: "session_bidding",
  phase: "sessioning",
  revision: 0,
  members: input.participants
    .filter(({ agentId }) => !input.priorBidAgentIds?.has(agentId))
    .map(({ agentId }) => ({
      role: "participant" as const,
      agentId,
      turnKind: "session_bid" as const,
      inputArtifactIds: [...input.inputArtifactIds],
      expectedArtifactType: "session_bid" as const,
    })),
});

/**
 * Sticky follow-up ownership: the Agent awarded the previous round of this
 * session, if any. Awards are ordered by creation, so the newest award that is
 * not the current round is the previous owner.
 */
const previousAwardedAgentId = (
  awards: readonly AwardArtifact[],
  currentUserArtifactId: CoordinationArtifactId,
): AgentId | undefined =>
  [...awards]
    .filter(({ payload }) => payload.userArtifactId !== currentUserArtifactId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)?.payload.selectedAgentId;

export const qualifiesForAutoDirectPublication = (
  bid: BidArtifact,
  run: WorkflowView["run"],
): boolean => {
  const policy = run.policy.auctionPolicy;
  return Boolean(
    policy?.routingMode === "auto" &&
    bid.payload.recommendation === "direct" &&
    bid.payload.candidateAnswer?.trim() &&
    bid.payload.confidenceBps >= policy.directConfidenceThresholdBps &&
    bid.payload.estimatedOutputTokens <= policy.directOutputTokenBudget &&
    bid.payload.plan.mode === "single" &&
    bid.payload.plan.assignments.length === 1 &&
    bid.payload.plan.assignments[0]?.agentId === bid.createdByAgentId,
  );
};

export class SharedSessionWorkflowV1 implements SharedSessionWorkflow {
  decideNext(view: WorkflowView): WorkflowDecision {
    const validated = validateSessionView(view);
    if ("kind" in validated) return validated;

    const { run } = view;
    const {
      participants,
      committedArtifacts,
      bidArtifacts,
      awardArtifacts,
      transcriptArtifacts,
      turns,
    } = validated;
    const lastArtifactId = finalArtifactId(committedArtifacts);

    if (run.policy.sessionProtocol === "countdown") {
      const invalid = validateCountdownState(view, committedArtifacts);
      if (invalid) return invalid;
      if (Number(committedArtifacts.at(-1)?.payload.content) === 1) {
        return lastArtifactId
          ? { kind: "complete", finalArtifactId: lastArtifactId }
          : invalidState("Completed session has no final artifact");
      }
      if (run.nextTurnSequence > run.policy.maxTurns) {
        return {
          kind: "fail",
          code: "MAX_TURNS_EXCEEDED",
          message: "Countdown session reached its turn limit",
        };
      }
    } else {
      if (run.sharedState !== undefined || run.policy.sessionStartValue !== undefined) {
        return invalidState("Free-chat session must not carry countdown state");
      }

      if (committedArtifacts.length >= run.policy.maxTurns) {
        return {
          kind: "fail",
          code: "MAX_TURNS_EXCEEDED",
          message: "Session reached its hard turn limit",
        };
      }

      const activeUser = run.lastUserArtifactId
        ? transcriptArtifacts.find(
            (artifact): artifact is UserArtifact =>
              artifact.type === "user_message" && artifact.id === run.lastUserArtifactId,
          )
        : undefined;
      const activeSequence = activeUser?.transcriptSequence ?? Number.MIN_SAFE_INTEGER;
      const currentWave = committedArtifacts.filter(
        (artifact) => (artifact.transcriptSequence ?? Number.MIN_SAFE_INTEGER) > activeSequence,
      );

      if (run.policy.auctionPolicy !== undefined) {
        const auctionPolicy = run.policy.auctionPolicy;
        if (!activeUser) {
          return invalidState("Auction routing requires a current user message");
        }
        // PA14-14: a message may pick `direct` or `auction` for its own round
        // and may name a participant. It carries no budget, so every ceiling
        // below still comes from durable policy.
        const requestedRouting = activeUser.routing;
        const routingMode = requestedRouting?.routingMode ?? auctionPolicy.routingMode;
        const explicitAgentId = requestedRouting?.selectedAgentId;
        const availableAgentIds = view.availableAgentIds === undefined
          ? undefined
          : new Set(view.availableAgentIds);
        const eligibleParticipants = availableAgentIds === undefined
          ? participants
          : participants.filter(({ agentId }) => availableAgentIds.has(agentId));
        const inputArtifactIds = transcriptArtifacts.map(({ id }) => id);
        const roundBidTurns = turns.filter(
          (turn) => turn.kind === "session_bid" && turn.inputArtifactIds.includes(activeUser.id),
        );
        const roundExecutionTurns = turns.filter(
          (turn) => turn.kind === "session_turn" && turn.inputArtifactIds.includes(activeUser.id),
        );
        const award = awardArtifacts.find(
          (artifact) => artifact.payload.userArtifactId === activeUser.id,
        );

        // An awarded round is driven entirely by its own committed evidence, so
        // a restart at any boundary re-derives the same next assignment instead
        // of re-ranking with different inputs.
        if (award) {
          if (award.payload.outcome === "publish_candidate") {
            return { kind: "await_input" };
          }
          const winningBid = award.payload.winningBidArtifactId
            ? bidArtifacts.find(({ id }) => id === award.payload.winningBidArtifactId)
            : undefined;
          if (award.payload.outcome === "execute_plan" && !winningBid) {
            return invalidState("Awarded plan is missing its winning bid");
          }
          const assignments = winningBid
            ? winningBid.payload.plan.assignments
            : [
                {
                  agentId: award.payload.selectedAgentId,
                  position: 1,
                  instruction: "",
                },
              ];
          // A direct-failure escalation may leave a failed pre-award execution
          // turn in this same user-message round. Only turns that explicitly
          // carry this immutable award are winning/fallback execution evidence.
          const awardExecutionTurns = roundExecutionTurns.filter((turn) =>
            turn.inputArtifactIds.includes(award.id),
          );
          if (awardExecutionTurns.some(({ status }) => status === "failed")) {
            return {
              kind: "fail",
              code: "MAX_ATTEMPTS_EXCEEDED",
              message: "Awarded execution did not complete",
            };
          }
          // Only a committed turn discharges an assignment (PA14-27). A turn
          // cancelled by boot recovery is not evidence that its Agent answered,
          // so counting it here would leave a restarted round permanently one
          // assignment short with nothing left to schedule.
          const executedAgentIds = new Set(
            awardExecutionTurns
              .filter(({ status }) => status === "committed")
              .map(({ agentId }) => agentId),
          );
          const remaining = assignments.filter(
            ({ agentId }) => !executedAgentIds.has(agentId),
          );
          if (remaining.length === 0) {
            return { kind: "await_input" };
          }
          // The award artifact is an explicit input so the executing Agent's
          // prompt carries the winning plan and its own assignment. Losing bids
          // are never referenced here and so can never reach an execution
          // prompt.
          const executionInputIds = [...inputArtifactIds, award.id];
          const mode = winningBid?.payload.plan.mode ?? "single";
          if (mode === "parallel") {
            if (turns.length + remaining.length > run.policy.maxTurns) {
              return {
                kind: "fail",
                code: "MAX_TURNS_EXCEEDED",
                message: "Awarded parallel plan would exceed the session turn limit",
              };
            }
            return {
              kind: "schedule_wave",
              wavePurpose: "session_execution",
              phase: "sessioning",
              revision: 0,
              members: remaining.map(({ agentId }) => ({
                role: "participant" as const,
                agentId,
                turnKind: "session_turn" as const,
                inputArtifactIds: [...executionInputIds],
                expectedArtifactType: "session_message" as const,
                threadPolicy: "fresh" as const,
              })),
            };
          }
          if (turns.length + 1 > run.policy.maxTurns) {
            return {
              kind: "fail",
              code: "MAX_TURNS_EXCEEDED",
              message: "Awarded execution would exceed the session turn limit",
            };
          }
          // `single` has exactly one assignment; `sequential` is ordered
          // strictly by position, so every later Agent sees the earlier
          // committed messages of this same round.
          const next = [...remaining].sort(
            (left, right) => left.position - right.position,
          )[0]!;
          return {
            kind: "schedule",
            role: "participant",
            agentId: next.agentId,
            turnKind: "session_turn",
            phase: "sessioning",
            revision: 0,
            inputArtifactIds: executionInputIds,
            expectedArtifactType: "session_message",
            // PA14-11: the awarded prompt is fully explicit, so it starts from
            // a fresh thread and cannot inherit a bid thread or a private
            // Playground history.
            threadPolicy: "fresh",
          };
        }

        if (currentWave.length > 0) {
          return { kind: "await_input" };
        }

        if (routingMode === "direct") {
          if (roundExecutionTurns.length > 0) {
            if (!roundExecutionTurns.some(({ status }) => status === "failed")) {
              return { kind: "await_input" };
            }
            if (!auctionPolicy.auctionOnDirectFailure) {
              return {
                kind: "fail",
                code: "MAX_ATTEMPTS_EXCEEDED",
                message: "Direct execution did not complete",
              };
            }
            // The failed direct turn is durable evidence that this round has
            // crossed the explicit escalation boundary. A restart either
            // schedules the one bounded bid opportunity set or, once those
            // turns settle, resolves exactly the bids they committed.
            if (roundBidTurns.length > 0 || eligibleParticipants.length === 0) {
              return {
                kind: "resolve_auction",
                userArtifactId: activeUser.id,
                bidArtifactIds: bidArtifacts
                  .filter((bid) => roundBidTurns.some((turn) => turn.outputArtifactId === bid.id))
                  .map(({ id }) => id),
              };
            }
            if (turns.length + eligibleParticipants.length > run.policy.maxTurns) {
              return {
                kind: "fail",
                code: "MAX_TURNS_EXCEEDED",
                message: "Direct-failure auction would exceed the session turn limit",
              };
            }
            return buildSessionBidWaveDecision({
              participants: eligibleParticipants,
              inputArtifactIds,
            });
          }
          if (turns.length + 1 > run.policy.maxTurns) {
            return {
              kind: "fail",
              code: "MAX_TURNS_EXCEEDED",
              message: "Direct response would exceed the session turn limit",
            };
          }
          const selection = selectPrimaryAgent({
            participants,
            userMessage: activeUser.payload.content,
            explicitAgentId,
            previousAwardedAgentId: previousAwardedAgentId(awardArtifacts, activeUser.id),
            defaultAgentId: auctionPolicy.defaultAgentId,
            availableAgentIds,
          });
          if (!selection.selectedAgentId) {
            return invalidState("Direct routing found no available participant");
          }
          return {
            kind: "schedule",
            role: "participant",
            agentId: selection.selectedAgentId,
            turnKind: "session_turn",
            phase: "sessioning",
            revision: 0,
            inputArtifactIds,
            expectedArtifactType: "session_message",
            ...(auctionPolicy.auctionOnDirectFailure
              ? { failurePolicy: "auction_on_exhaustion" as const }
              : {}),
          };
        }

        const roundBids = bidArtifacts.filter((bid) =>
          roundBidTurns.some((turn) => turn.outputArtifactId === bid.id),
        );
        const resolve = (
          directCandidateBidArtifactId?: CoordinationArtifactId,
        ): WorkflowDecision => ({
          kind: "resolve_auction",
          userArtifactId: activeUser.id,
          bidArtifactIds: roundBids.map(({ id }) => id),
          ...(directCandidateBidArtifactId === undefined
            ? {}
            : { directCandidateBidArtifactId }),
        });

        if (routingMode === "auction") {
          if (roundBidTurns.length > 0) {
            return resolve();
          }
          if (eligibleParticipants.length === 0) {
            return resolve();
          }
          if (turns.length + eligibleParticipants.length > run.policy.maxTurns) {
            return {
              kind: "fail",
              code: "MAX_TURNS_EXCEEDED",
              message: "Bid wave would exceed the session turn limit",
            };
          }
          return buildSessionBidWaveDecision({
            participants: eligibleParticipants,
            inputArtifactIds,
          });
        }

        if (roundBidTurns.length === 0) {
          if (turns.length + 1 > run.policy.maxTurns) {
            return {
              kind: "fail",
              code: "MAX_TURNS_EXCEEDED",
              message: "Auto primary bid would exceed the session turn limit",
            };
          }
          const selection = selectPrimaryAgent({
            participants,
            userMessage: activeUser.payload.content,
            explicitAgentId,
            previousAwardedAgentId: previousAwardedAgentId(awardArtifacts, activeUser.id),
            defaultAgentId: auctionPolicy.defaultAgentId,
            availableAgentIds,
          });
          if (!selection.selectedAgentId) {
            return invalidState("Auto routing found no available primary participant");
          }
          return {
            kind: "schedule",
            role: "participant",
            agentId: selection.selectedAgentId,
            turnKind: "session_bid",
            wavePurpose: "session_bidding",
            phase: "sessioning",
            revision: 0,
            inputArtifactIds,
            expectedArtifactType: "session_bid",
          };
        }

        const primaryTurn = roundBidTurns.reduce((earliest, turn) =>
          turn.sequence < earliest.sequence ? turn : earliest,
        );
        const primaryBid = roundBids.find((bid) => bid.id === primaryTurn.outputArtifactId);
        if (primaryBid && qualifiesForAutoDirectPublication(primaryBid, run)) {
          return resolve(primaryBid.id);
        }

        const attemptedAgentIds = new Set(roundBidTurns.map(({ agentId }) => agentId));
        const remaining = eligibleParticipants.filter(
          ({ agentId }) => !attemptedAgentIds.has(agentId),
        );
        if (remaining.length > 0) {
          if (turns.length + remaining.length > run.policy.maxTurns) {
            return {
              kind: "fail",
              code: "MAX_TURNS_EXCEEDED",
              message: "Auto escalation bid wave would exceed the session turn limit",
            };
          }
          return buildSessionBidWaveDecision({
            participants,
            inputArtifactIds,
            priorBidAgentIds: attemptedAgentIds,
          });
        }
        return resolve();
      }

      const latestByParticipant = new Map<string, SessionArtifact>();
      for (const artifact of currentWave) {
        latestByParticipant.set(artifact.createdByAgentId, artifact);
      }
      const unanimous =
        currentWave.length >= participants.length &&
        participants.every(
          ({ agentId }) => latestByParticipant.get(agentId)?.payload.done === true,
        );
      if (unanimous) {
        return { kind: "await_input" };
      }

      // PA13-10: a parallel run answers each user message with exactly one wave
      // of every participant. Once any member of that wave has committed, the
      // round is over and the session returns to the user. A round in which no
      // member committed never reaches here: the supervisor has already failed
      // the run, which is what keeps "nothing came back" from looking like
      // success.
      if (run.policy.sessionWaveMode === "parallel") {
        if (currentWave.length > 0) {
          return { kind: "await_input" };
        }
        if (committedArtifacts.length + participants.length > run.policy.maxTurns) {
          return {
            kind: "fail",
            code: "MAX_TURNS_EXCEEDED",
            message: "Session wave would exceed its turn limit",
          };
        }
        const inputArtifactIds = transcriptArtifacts.map(({ id }) => id);
        return {
          kind: "schedule_wave",
          wavePurpose: run.policy.sessionWavePurpose ?? "session_execution",
          phase: "sessioning",
          revision: 0,
          members: participants.map(({ agentId }) => ({
            role: "participant" as const,
            agentId,
            turnKind: "session_turn" as const,
            inputArtifactIds: [...inputArtifactIds],
            expectedArtifactType: "session_message" as const,
          })),
        };
      }
    }

    const participant = participants[committedArtifacts.length % participants.length];
    if (!participant) return invalidState("Session run has no next participant");

    return {
      kind: "schedule",
      role: "participant",
      agentId: participant.agentId,
      turnKind: "session_turn",
      phase: "sessioning",
      revision: 0,
      inputArtifactIds: transcriptArtifacts.map(({ id }) => id),
      expectedArtifactType: "session_message",
    };
  }
}
