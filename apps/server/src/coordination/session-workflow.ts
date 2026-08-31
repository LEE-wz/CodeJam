import type { SharedSessionWorkflow, WorkflowDecision, WorkflowView } from "./contracts.js";
import type {
  CoordinationArtifact,
  CoordinationParticipant,
  SessionPlanPayload,
} from "./types.js";
import { SESSION_LIMITS } from "./types.js";

export type { SharedSessionWorkflow } from "./contracts.js";

type SessionArtifact = Extract<CoordinationArtifact, { type: "session_message" }>;
type UserArtifact = Extract<CoordinationArtifact, { type: "user_message" }>;
type PlanArtifact = Extract<CoordinationArtifact, { type: "session_plan" }>;

const sequenceOf = (artifact: { transcriptSequence?: number }): number =>
  artifact.transcriptSequence ?? Number.MIN_SAFE_INTEGER;

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
  committedPlans: PlanArtifact[];
  transcriptArtifacts: Array<SessionArtifact | UserArtifact>;
}

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
  if (!isPositiveInteger(run.nextTurnSequence) || run.revision !== 0) {
    return invalidState("Session run has invalid sequence or revision state");
  }
  if (!isPositiveInteger(run.policy.maxTurns) || run.policy.sessionProtocol !== "free_chat") {
    // A stored countdown run still loads and renders; it is simply not
    // schedulable, because the protocol that drove it no longer exists (P14-07).
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

  if (
    view.turns.some(({ runId }) => runId !== run.id) ||
    view.artifacts.some(({ runId }) => runId !== run.id)
  ) {
    return invalidState("Session view contains records from another run");
  }
  const turns = view.turns;
  const artifacts = view.artifacts;
  if (
    artifacts.some(
      ({ type }) =>
        type !== "session_message" && type !== "user_message" && type !== "session_plan",
    )
  ) {
    return invalidState("Session run contains a non-session artifact");
  }

  const turnIds = new Set<string>();
  const sequences = new Set<number>();
  for (const turn of turns) {
    if (
      turnIds.has(turn.id) ||
      sequences.has(turn.sequence) ||
      !isPositiveInteger(turn.sequence) ||
      turn.sequence >= run.nextTurnSequence ||
      (turn.kind !== "session_turn" && turn.kind !== "session_plan") ||
      turn.role !== "participant" ||
      !participantIds.has(turn.agentId) ||
      !["scheduled", "running", "committed", "cancelled", "failed"].includes(turn.status)
    ) {
      return invalidState("Session run contains an invalid turn");
    }
    turnIds.add(turn.id);
    sequences.add(turn.sequence);
  }

  const artifactIds = new Set<string>();
  const artifactsById = new Map<string, SessionArtifact | PlanArtifact>();
  for (const artifact of artifacts) {
    if (artifactIds.has(artifact.id)) {
      return invalidState("Session run has duplicate artifact identity");
    }
    artifactIds.add(artifact.id);
    if (artifact.type === "session_message" || artifact.type === "session_plan") {
      artifactsById.set(artifact.id, artifact);
    }
  }

  const committedTurns = [...turns].sort((left, right) => left.sequence - right.sequence);
  const committedArtifacts: SessionArtifact[] = [];
  const committedPlans: PlanArtifact[] = [];
  for (const turn of committedTurns) {
    if (turn.status !== "committed") continue;
    const artifact = turn.outputArtifactId
      ? artifactsById.get(turn.outputArtifactId)
      : undefined;
    // A committed turn owes exactly the artifact type its kind declares, so a
    // plan turn cannot smuggle in a message and a message turn cannot smuggle
    // in a plan even if the durable records were hand-edited.
    const expected = turn.kind === "session_plan" ? "session_plan" : "session_message";
    if (
      !artifact ||
      artifact.type !== expected ||
      artifact.turnId !== turn.id ||
      artifact.createdByRole !== "participant" ||
      artifact.createdByAgentId !== turn.agentId
    ) {
      return invalidState("Committed session turn has invalid output");
    }
    if (artifact.type === "session_plan") {
      committedPlans.push(artifact);
    } else {
      committedArtifacts.push(artifact);
    }
  }
  const userArtifacts = artifacts.filter(
    (artifact): artifact is UserArtifact => artifact.type === "user_message",
  );
  if (
    committedArtifacts.length + committedPlans.length + userArtifacts.length !==
    artifacts.length
  ) {
    return invalidState("Session run contains an uncommitted artifact");
  }

  const transcriptArtifacts = [...committedArtifacts, ...userArtifacts].sort(
    (left, right) =>
      sequenceOf(left) - sequenceOf(right) || left.createdAt.localeCompare(right.createdAt),
  );

  return { participants, committedArtifacts, committedPlans, transcriptArtifacts };
};

/**
 * The plan governing the current round, if one has been committed for the
 * active user message (P14-03).
 *
 * Planning state is derived from committed artifacts alone: a plan belongs to
 * this round when its transcript sequence is higher than the active user
 * message's. Nothing is stored on the run, so a retry can never schedule a
 * second plan and a restart between the plan commit and the first assignment
 * re-derives exactly the same remaining work.
 */
const planForRound = (
  plans: PlanArtifact[],
  activeSequence: number,
): PlanArtifact | undefined =>
  plans.find((plan) => sequenceOf(plan) > activeSequence);

export class SharedSessionWorkflowV1 implements SharedSessionWorkflow {
  decideNext(view: WorkflowView): WorkflowDecision {
    const validated = validateSessionView(view);
    if ("kind" in validated) return validated;

    const { run } = view;
    const { participants, committedArtifacts, committedPlans, transcriptArtifacts } =
      validated;
    const activeUser = run.lastUserArtifactId
      ? transcriptArtifacts.find(
          (artifact): artifact is UserArtifact =>
            artifact.type === "user_message" && artifact.id === run.lastUserArtifactId,
        )
      : undefined;
    const activeSequence = activeUser ? sequenceOf(activeUser) : Number.MIN_SAFE_INTEGER;

    if (committedArtifacts.length >= run.policy.maxTurns) {
      return {
        kind: "fail",
        code: "MAX_TURNS_EXCEEDED",
        message: "Session reached its hard turn limit",
      };
    }

    // Coordinator planning owns the round when the policy selects it and a
    // user message is live. A pre-Phase-14 run has no `sessionPlanning` at
    // all and is read as `round_robin`, so stored sessions keep behaving
    // exactly as they did when they were created.
    //
    // A session started through `POST /start` rather than `POST /messages` has
    // no user message yet, so there is nothing to plan *for*; that first round
    // falls through to round robin and planning resumes on the first prompt.
    if (run.policy.sessionPlanning === "coordinator" && activeUser) {
      return decidePlannedRound({
        participants,
        committedArtifacts,
        committedPlans,
        transcriptArtifacts,
        activeSequence,
      });
    }

    const currentWave = committedArtifacts.filter(
      (artifact) => sequenceOf(artifact) > activeSequence,
    );
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

    const answered = new Set(
      committedArtifacts
        .filter((artifact) => sequenceOf(artifact) > activeSequence)
        .map((artifact) => artifact.createdByAgentId),
    );
    const remaining = participants.filter(({ agentId }) => !answered.has(agentId));
    // A stored session may have no user artifact (it predates Phase 12).
    // Preserve its original deterministic round robin.
    const next = run.policy.sessionParallel && activeUser
      ? remaining
      : [participants[committedArtifacts.length % participants.length]].flatMap((participant) =>
          participant ? [participant] : [],
        );
    if (run.policy.sessionParallel && activeUser && next.length === 0) {
      return { kind: "await_input" };
    }

    const turn = (participant: CoordinationParticipant) => ({
      role: "participant" as const,
      agentId: participant.agentId,
      turnKind: "session_turn" as const,
      phase: "sessioning" as const,
      revision: 0,
      inputArtifactIds: transcriptArtifacts.map(({ id }) => id),
      expectedArtifactType: "session_message" as const,
    });
    if (!run.policy.sessionParallel || next.length === 1) {
      return { kind: "schedule", ...turn(next[0]!) };
    }
    return { kind: "schedule_wave", turns: next.map(turn) };
  }
}

/**
 * One round under `sessionPlanning: "coordinator"` (P14-03, P14-04).
 *
 * Either the round has no plan yet -- in which case the first participant is
 * scheduled to author one -- or it has exactly one, and the assignments it
 * names are executed. `sequential` schedules strictly in `position` order, one
 * turn at a time, so each contributor sees its predecessors' committed messages
 * in the transcript; that visibility, and not any engine-side rule about
 * content, is what makes an ordered answer come out in order. `parallel`
 * schedules every outstanding assignment as one wave, which the service then
 * bounds by `maxParallelTurns`.
 *
 * `policy.sessionParallel` is not consulted here: it is the Phase 13 flag that
 * turns *round-robin* fan-out on, and under planning the committed plan's own
 * `mode` is the authority. The cap still applies to either.
 */
const decidePlannedRound = (input: {
  participants: CoordinationParticipant[];
  committedArtifacts: SessionArtifact[];
  committedPlans: PlanArtifact[];
  transcriptArtifacts: Array<SessionArtifact | UserArtifact>;
  activeSequence: number;
}): WorkflowDecision => {
  const { participants, committedArtifacts, committedPlans, transcriptArtifacts } = input;
  const plan = planForRound(committedPlans, input.activeSequence);

  if (!plan) {
    // The coordinator is the first participant by recorded decision (D3). The
    // choice is positional and derived from durable state, so it is stable
    // across restarts and no Agent output can influence it.
    const coordinator = participants[0];
    if (!coordinator) return invalidState("Session run has no coordinator participant");
    return {
      kind: "schedule",
      role: "participant",
      agentId: coordinator.agentId,
      turnKind: "session_plan",
      phase: "sessioning",
      revision: 0,
      inputArtifactIds: transcriptArtifacts.map(({ id }) => id),
      expectedArtifactType: "session_plan",
    };
  }

  const planSequence = sequenceOf(plan);
  const payload: SessionPlanPayload = plan.payload;
  const participantIds = new Set(participants.map(({ agentId }) => agentId));
  if (payload.assignments.some(({ agentId }) => !participantIds.has(agentId))) {
    // Unreachable through the protocol, which validates membership at commit.
    // Failing here beats letting the service throw when it cannot find the
    // participant a stored assignment names.
    return invalidState("Committed plan names an Agent that is not a participant");
  }

  const answered = new Set(
    committedArtifacts
      .filter((artifact) => sequenceOf(artifact) > planSequence)
      .map((artifact) => artifact.createdByAgentId),
  );
  const remaining = [...payload.assignments]
    .sort((left, right) => left.position - right.position)
    .filter(({ agentId }) => !answered.has(agentId));

  if (remaining.length === 0) {
    return { kind: "await_input" };
  }

  // The plan is an input to every turn it assigns, so the context builder can
  // hand each participant its own instruction without re-deriving the round.
  const inputArtifactIds = [...transcriptArtifacts.map(({ id }) => id), plan.id];
  const turn = (agentId: string) => ({
    role: "participant" as const,
    agentId,
    turnKind: "session_turn" as const,
    phase: "sessioning" as const,
    revision: 0,
    inputArtifactIds,
    expectedArtifactType: "session_message" as const,
  });

  if (payload.mode === "sequential" || remaining.length === 1) {
    return { kind: "schedule", ...turn(remaining[0]!.agentId) };
  }
  return { kind: "schedule_wave", turns: remaining.map(({ agentId }) => turn(agentId)) };
};
