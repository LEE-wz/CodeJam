import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "./api";
import { coordinationApi } from "./coordination-api";
import type {
  CoordinationArtifact,
  CoordinationEvent,
  CoordinationParticipant,
  CoordinationRun,
  CoordinationRunDetails,
  CoordinationRunStatus,
  CoordinationTurn,
  CreateSessionRunRequest,
  SessionPlanningPolicy,
} from "./coordination-types";
import { SESSION_LIMITS } from "./coordination-types";
import type { Agent } from "./types";

const activeStatuses = new Set<CoordinationRunStatus>(["running", "stop_requested"]);

/**
 * Role labels. `participant` is the only role a session creates; the three
 * verified-handoff roles remain because runs created before the workflow was
 * removed from this app are still rendered, read-only (P10-06).
 */
const roleLabels = {
  planner: "Planner",
  critic: "Critic",
  finalizer: "Finaliser",
  participant: "Participant",
} as const;

interface SessionWorkspaceProps {
  agents: Agent[];
}

interface FormState {
  name: string;
  objective: string;
  sessionAgentIds: string[];
  maxTurns: string;
  sessionPlanning: SessionPlanningPolicy;
  perAttemptTimeoutSeconds: string;
}

const initialForm = (agents: Agent[]): FormState => {
  const ready = agents.filter(({ status }) => status === "ready");
  return {
    name: "Shared session",
    objective: "",
    sessionAgentIds: ready.slice(0, 3).map(({ id }) => id),
    maxTurns: String(SESSION_LIMITS.defaultSessionTurns),
    sessionPlanning: "coordinator",
    perAttemptTimeoutSeconds: "120",
  };
};

const formatDate = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

const humanize = (value: string): string =>
  value.replaceAll("_", " ").replaceAll(".", " · ");

const errorMessage = (reason: unknown): string => {
  if (reason instanceof ApiError) {
    const fields = reason.fieldErrors ? Object.values(reason.fieldErrors).flat() : [];
    return fields.length > 0 ? `${reason.message}: ${fields.join("; ")}` : reason.message;
  }
  return reason instanceof Error ? reason.message : String(reason);
};

const terminalMessage = (run: CoordinationRun): string => {
  if (run.errorMessage) return run.errorMessage;
  switch (run.errorCode) {
    case "STOPPED_BY_USER": return "The session was stopped by the user. The same Agents can be used in a new session.";
    case "SERVER_RESTARTED": return "The server restarted during this session. Create a new session to continue safely.";
    case "MAX_ATTEMPTS_EXCEEDED": return "A turn exhausted its retry limit. Review the attempt evidence before trying again.";
    case "MAX_REVISIONS_EXCEEDED": return "The proposal reached its revision limit without approval. Review the Critic feedback.";
    case "MAX_TURNS_EXCEEDED": return "The session reached its turn limit. Review the latest committed messages.";
    default: return "The session reached a terminal state. Review the evidence below before trying again.";
  }
};

const isSessionRun = (run: CoordinationRun): boolean =>
  run.policy.workflow === "shared_session_v1";

function RunStatus({ status }: { status: CoordinationRunStatus }) {
  return <span className={`session-status session-status-${status}`}>{humanize(status)}</span>;
}

function validateForm(form: FormState, agents: Agent[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = form.name.trim();
  const objective = form.objective.trim();
  if (!name || name.length > 80) errors.name = "Use a name between 1 and 80 characters.";
  if (!objective || objective.length > 4_000) errors.objective = "Use an objective between 1 and 4,000 characters.";

  const readyIds = new Set(agents.filter(({ status }) => status === "ready").map(({ id }) => id));
  if (
    form.sessionAgentIds.length < SESSION_LIMITS.minParticipants ||
    form.sessionAgentIds.length > SESSION_LIMITS.maxParticipants ||
    new Set(form.sessionAgentIds).size !== form.sessionAgentIds.length
  ) {
    errors.agents = `Choose ${SESSION_LIMITS.minParticipants}-${SESSION_LIMITS.maxParticipants} different ready Agents in turn order.`;
  } else if (form.sessionAgentIds.some((id) => !readyIds.has(id))) {
    errors.agents = "Every session participant must be ready.";
  }

  const maxTurns = Number(form.maxTurns);
  if (
    !Number.isInteger(maxTurns) ||
    maxTurns < SESSION_LIMITS.minSessionTurns ||
    maxTurns > SESSION_LIMITS.maxSaveableSessionTurns
  ) {
    errors.policy = `Maximum turns must be an integer from ${SESSION_LIMITS.minSessionTurns}-${SESSION_LIMITS.maxSaveableSessionTurns.toLocaleString()}.`;
  }
  const timeout = Number(form.perAttemptTimeoutSeconds);
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 180) {
    errors.policy = "Attempt timeout must be 10-180 seconds.";
  }
  return errors;
}

/**
 * Renders the typed artifacts of a verified-handoff run. Sessions never produce
 * these; the card exists so a run created before P10-06 still opens.
 */
function LegacyArtifactCard({ artifact }: { artifact: Extract<CoordinationArtifact, { type: "proposal" | "review" | "final" }> }) {
  const payload = artifact.payload;
  return (
    <article className={`artifact-card artifact-${artifact.type}`}>
      <header>
        <span>{artifact.type}</span>
        <small>{roleLabels[artifact.createdByRole]} · {artifact.sizeChars.toLocaleString()} chars</small>
      </header>
      {payload.type === "proposal" && (
        <>
          <p className="artifact-summary">{payload.summary}</p>
          {payload.sections.map((section) => (
            <section key={section.key}>
              <h4>{section.title}</h4>
              <p>{section.content}</p>
            </section>
          ))}
        </>
      )}
      {payload.type === "review" && (
        <>
          <strong className={`review-decision review-${payload.decision}`}>{payload.decision}</strong>
          <p>{payload.feedback}</p>
          {payload.issues.length > 0 && (
            <ul>{payload.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul>
          )}
        </>
      )}
      {payload.type === "final" && (
        <section>
          <h3>{payload.title}</h3>
          <p>{payload.content}</p>
        </section>
      )}
    </article>
  );
}

function EventRow({ event }: { event: CoordinationEvent }) {
  const details = Object.entries(event.details);
  return (
    <li className={`event-row event-${event.type.replaceAll(".", "-")}`}>
      <span className="event-sequence">{event.sequence}</span>
      <div>
        <strong>{humanize(event.type)}</strong>
        <p>{event.message}</p>
        {details.length > 0 && (
          <dl>{details.map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd>{String(value)}</dd></div>)}</dl>
        )}
      </div>
    </li>
  );
}

function participantName(run: CoordinationRun, agentId: string): string {
  return run.participants.find((participant) => participant.agentId === agentId)?.agentNameSnapshot ?? "Unknown Agent";
}

function TurnEvidence({ turn, details }: { turn: CoordinationTurn; details: CoordinationRunDetails }) {
  const attempts = details.attempts
    .filter(({ turnId }) => turnId === turn.id)
    .sort((a, b) => a.number - b.number);
  const events = details.events.filter(({ turnId }) => turnId === turn.id);
  const label = turn.role === "participant" ? participantName(details.run, turn.agentId) : roleLabels[turn.role];
  return (
    <article className="turn-evidence">
      <header>
        <span className="turn-number">{turn.sequence}</span>
        <div>
          <span className="eyebrow">{label}</span>
          <h4>{humanize(turn.kind)}</h4>
        </div>
        <span className={`turn-status turn-status-${turn.status}`}>{humanize(turn.status)}</span>
      </header>
      <div className="attempt-list" aria-label={`Attempts for turn ${turn.sequence}`}>
        {attempts.map((attempt) => (
          <div className="attempt-row" key={attempt.id}>
            <strong>Attempt {attempt.number}</strong>
            <span className={`attempt-status attempt-status-${attempt.status}`}>{humanize(attempt.status)}</span>
            {attempt.errorMessage && <p>{attempt.errorMessage}</p>}
          </div>
        ))}
        {turn.lastValidationErrors.map((message, index) => (
          <p className="validation-evidence" key={`${turn.id}-validation-${index}`}>{message}</p>
        ))}
      </div>
      {events.length > 0 && <ol className="event-list">{events.map((event) => <EventRow event={event} key={event.id} />)}</ol>}
    </article>
  );
}

function latestDoneByParticipant(details: CoordinationRunDetails): Map<string, boolean> {
  const latest = new Map<string, boolean>();
  for (const artifact of details.artifacts) {
    if (artifact.type === "session_message") {
      latest.set(artifact.createdByAgentId, artifact.payload.done === true);
    }
  }
  return latest;
}

/**
 * The plan governing a round, rendered as evidence rather than as a chat
 * message (P14-01). It is immutable, attributed, and part of the ledger, so it
 * belongs on screen; it is not something a participant said, so it does not sit
 * in the message stream.
 */
function SessionPlanCard({ details }: { details: CoordinationRunDetails }) {
  const plans = details.artifacts.filter(
    (artifact): artifact is Extract<CoordinationArtifact, { type: "session_plan" }> =>
      artifact.type === "session_plan",
  );
  const plan = plans.at(-1);
  if (!plan) return null;
  return (
    <section className="session-plan" aria-label="Round plan">
      <div className="session-section-heading">
        <div>
          <span className="eyebrow">Planned by {participantName(details.run, plan.createdByAgentId)}</span>
          <h3>Round plan</h3>
        </div>
        <span className="evidence-count">{plan.payload.mode}</span>
      </div>
      <ol className="session-plan-assignments">
        {[...plan.payload.assignments]
          .sort((left, right) => left.position - right.position)
          .map((assignment) => (
            <li key={`${assignment.agentId}-${assignment.position}`}>
              <strong>{participantName(details.run, assignment.agentId)}</strong>
              <span>{assignment.instruction}</span>
            </li>
          ))}
      </ol>
    </section>
  );
}

function SessionTranscript({ details }: { details: CoordinationRunDetails }) {
  const messages = details.artifacts
    .filter(
      (artifact): artifact is Extract<CoordinationArtifact, { type: "session_message" | "user_message" }> =>
        artifact.type === "session_message" || artifact.type === "user_message",
    )
    .sort((left, right) =>
      (left.transcriptSequence ?? Number.MIN_SAFE_INTEGER) -
        (right.transcriptSequence ?? Number.MIN_SAFE_INTEGER) ||
      left.createdAt.localeCompare(right.createdAt),
    );
  if (messages.length === 0) {
    return <div className="transcript-empty"><strong>No messages yet</strong><p>The transcript will appear after the first committed turn.</p></div>;
  }
  return (
    <ol
      className="session-transcript"
      aria-label="Session transcript"
      style={{ maxHeight: "34rem", overflowY: "auto" }}
    >
      {messages.map((message) => {
        if (message.type === "user_message") {
          return (
            <li className="transcript-message transcript-message-user" key={message.id}>
              <header><div><strong>You</strong><span>User message</span></div></header>
              <p>{message.payload.content}</p>
            </li>
          );
        }
        const turn = details.turns.find(({ id }) => id === message.turnId);
        const attempts = details.attempts
          .filter(({ turnId }) => turnId === message.turnId)
          .sort((a, b) => a.number - b.number);
        return (
          <li className="transcript-message" key={message.id}>
            <header>
              <div>
                <strong>{participantName(details.run, message.createdByAgentId)}</strong>
                <span>Turn {turn?.sequence ?? "?"}</span>
              </div>
              {message.payload.done === true && <span className="done-badge">done</span>}
            </header>
            <p>{message.payload.content}</p>
            <div className="transcript-attempts" aria-label={`Attempt evidence for ${participantName(details.run, message.createdByAgentId)}`}>
              {attempts.map((attempt) => (
                <span className={`attempt-status attempt-status-${attempt.status}`} key={attempt.id}>
                  Attempt {attempt.number}: {humanize(attempt.status)}
                </span>
              ))}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const mergeById = <T extends { id: string }>(current: T[], incoming: T[]): T[] => {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()];
};

const mergeDetails = (
  current: CoordinationRunDetails,
  delta: CoordinationRunDetails,
): CoordinationRunDetails => ({
  run: delta.run,
  turns: mergeById(current.turns, delta.turns).sort((a, b) => a.sequence - b.sequence),
  attempts: mergeById(current.attempts, delta.attempts),
  artifacts: mergeById(current.artifacts, delta.artifacts),
  events: mergeById(current.events, delta.events).sort((a, b) => a.sequence - b.sequence),
  cursor: delta.cursor ?? current.cursor,
});

function SessionParticipantPicker({
  agents,
  selectedIds,
  error,
  focusRef,
  onChange,
}: {
  agents: Agent[];
  selectedIds: string[];
  error?: string | undefined;
  focusRef: React.RefObject<HTMLFieldSetElement | null>;
  onChange: (ids: string[]) => void;
}) {
  const readyAgents = agents.filter(({ status }) => status === "ready");
  const selectedAgents = selectedIds
    .map((id) => readyAgents.find((agent) => agent.id === id))
    .filter((agent): agent is Agent => Boolean(agent));
  const move = (index: number, offset: number) => {
    const next = [...selectedIds];
    const destination = index + offset;
    if (destination < 0 || destination >= next.length) return;
    [next[index], next[destination]] = [next[destination]!, next[index]!];
    onChange(next);
  };
  return (
    <fieldset ref={focusRef} tabIndex={-1} className="session-participant-picker" aria-describedby={error ? "session-agents-error" : undefined}>
      <legend>Participants and turn order</legend>
      <p>Select {SESSION_LIMITS.minParticipants}-{SESSION_LIMITS.maxParticipants} ready Agents. The numbered order below is the backend round-robin order.</p>
      <div className="participant-options" aria-label="Ready Agents">
        {readyAgents.map((agent) => {
          const selected = selectedIds.includes(agent.id);
          return (
            <button
              type="button"
              className={selected ? "participant-option selected" : "participant-option"}
              disabled={selected || selectedIds.length >= SESSION_LIMITS.maxParticipants}
              onClick={() => onChange([...selectedIds, agent.id])}
              key={agent.id}
            >
              <strong>{agent.name}</strong>
              <span>{selected ? "Selected" : "Add to session"}</span>
            </button>
          );
        })}
      </div>
      <ol className="participant-order">
        {selectedAgents.map((agent, index) => (
          <li key={agent.id}>
            <span className="participant-position">{index + 1}</span>
            <strong>{agent.name}</strong>
            <div>
              <button type="button" aria-label={`Move ${agent.name} earlier`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
              <button type="button" aria-label={`Move ${agent.name} later`} disabled={index === selectedIds.length - 1} onClick={() => move(index, 1)}>↓</button>
              <button type="button" aria-label={`Remove ${agent.name}`} onClick={() => onChange(selectedIds.filter((id) => id !== agent.id))}>Remove</button>
            </div>
          </li>
        ))}
      </ol>
      {error && <p id="session-agents-error" className="field-error" role="alert">{error}</p>}
    </fieldset>
  );
}

function CreationForm({
  agents,
  onCreated,
  onCancel,
}: {
  agents: Agent[];
  onCreated: (run: CoordinationRun) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(() => initialForm(agents));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const objectiveRef = useRef<HTMLTextAreaElement>(null);
  const sessionParticipantRef = useRef<HTMLFieldSetElement>(null);
  const policyRef = useRef<HTMLInputElement>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextErrors = validateForm(form, agents);
    setErrors(nextErrors);
    setServerError(null);
    if (Object.keys(nextErrors).length > 0) {
      const firstInvalid = nextErrors.name ? nameRef.current
        : nextErrors.objective ? objectiveRef.current
          : nextErrors.agents ? sessionParticipantRef.current
            : policyRef.current;
      firstInvalid?.focus();
      return;
    }

    setSubmitting(true);
    const request: CreateSessionRunRequest = {
      workflow: "shared_session_v1",
      name: form.name.trim(),
      objective: form.objective.trim(),
      agents: form.sessionAgentIds,
      policy: {
        sessionProtocol: "free_chat",
        sessionPlanning: form.sessionPlanning,
        maxTurns: Number(form.maxTurns),
        perAttemptTimeoutMs: Number(form.perAttemptTimeoutSeconds) * 1_000,
      },
    };

    try {
      const { run } = await coordinationApi.create(request);
      onCreated(run);
    } catch (reason) {
      setServerError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="session-create" onSubmit={submit} noValidate>
      <div className="session-section-heading">
        <div><span className="eyebrow">New session</span><h2>Configure the session</h2></div>
        <button type="button" className="button button-ghost" onClick={onCancel}>Cancel</button>
      </div>
      {serverError && <div className="error-banner" role="alert">{serverError}</div>}

      <div className="session-form-grid">
        <label>Session name<input ref={nameRef} autoFocus value={form.name} maxLength={80} aria-invalid={Boolean(errors.name)} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label className="session-objective">Objective<textarea ref={objectiveRef} rows={4} value={form.objective} maxLength={4_000} aria-invalid={Boolean(errors.objective)} onChange={(event) => setForm({ ...form, objective: event.target.value })} /></label>
      </div>
      {(errors.name || errors.objective) && <p className="field-error" role="alert">{errors.name ?? errors.objective}</p>}

      <SessionParticipantPicker
        agents={agents}
        selectedIds={form.sessionAgentIds}
        error={errors.agents}
        focusRef={sessionParticipantRef}
        onChange={(sessionAgentIds) => setForm({ ...form, sessionAgentIds })}
      />

      <details className="policy-controls" open>
        <summary>Safety limits</summary>
        <div className="session-policy-grid">
          <label>Maximum turns<input ref={policyRef} type="number" min={SESSION_LIMITS.minSessionTurns} max={SESSION_LIMITS.maxSaveableSessionTurns} value={form.maxTurns} onChange={(event) => setForm({ ...form, maxTurns: event.target.value })} /></label>
          {Number(form.maxTurns) > SESSION_LIMITS.recommendedMaxSessionTurns && (
            <p className="field-hint field-hint-warning">
              Measured guidance is {SESSION_LIMITS.recommendedMaxSessionTurns} turns or fewer; a
              session cannot be saved at all beyond roughly 4,400.
            </p>
          )}
          <label>Attempt timeout (seconds)<input type="number" min="10" max="180" value={form.perAttemptTimeoutSeconds} onChange={(event) => setForm({ ...form, perAttemptTimeoutSeconds: event.target.value })} /></label>
          <label>
            Planning
            <select
              value={form.sessionPlanning}
              onChange={(event) =>
                setForm({ ...form, sessionPlanning: event.target.value as SessionPlanningPolicy })
              }
            >
              <option value="coordinator">Coordinator plans each round</option>
              <option value="round_robin">Round robin (no planning turn)</option>
            </select>
            <small>
              A coordinator plan lets the first participant decide who answers, in what
              order, and with what instruction. Round robin is the deterministic fallback.
            </small>
          </label>
        </div>
        {errors.policy && <p className="field-error" role="alert">{errors.policy}</p>}
      </details>

      <div className="session-create-footer"><p>Creating the session does not start it. Review the configuration, then start it as a separate action.</p><button className="button button-primary" disabled={submitting}>{submitting ? "Creating…" : "Create session"}</button></div>
    </form>
  );
}

function ParticipantMap({ details }: { details: CoordinationRunDetails }) {
  const isSession = isSessionRun(details.run);
  const doneByAgent = isSession && details.run.policy.sessionProtocol !== "countdown"
    ? latestDoneByParticipant(details)
    : new Map<string, boolean>();
  return (
    <section className={isSession ? "role-map session-role-map" : "role-map"} aria-label={isSession ? "Session participants" : "Role assignments"}>
      {details.run.participants.map((participant: CoordinationParticipant, index) => (
        <div key={participant.agentId}>
          <span>{isSession ? `Turn position ${index + 1}` : roleLabels[participant.role]}</span>
          <strong>{participant.agentNameSnapshot}</strong>
          {isSession && details.run.policy.sessionProtocol !== "countdown" && (
            <small className={doneByAgent.get(participant.agentId) ? "consensus-done" : "consensus-open"}>
              {doneByAgent.get(participant.agentId) ? "done signalled" : "still contributing"}
            </small>
          )}
        </div>
      ))}
    </section>
  );
}

export function SessionWorkspace({ agents }: SessionWorkspaceProps) {
  const [runs, setRuns] = useState<CoordinationRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [details, setDetails] = useState<CoordinationRunDetails | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [action, setAction] = useState<"send" | "stop" | "end" | null>(null);
  const [message, setMessage] = useState("");
  const [pollEpoch, setPollEpoch] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const detailsRef = useRef<CoordinationRunDetails | null>(null);

  const loadRuns = useCallback(async (preferredId?: string) => {
    const { runs: next } = await coordinationApi.list();
    setRuns(next);
    setSelectedRunId((current) => preferredId ?? (current && next.some(({ id }) => id === current) ? current : next[0]?.id ?? null));
  }, []);

  useEffect(() => {
    let active = true;
    setLoadingRuns(true);
    void loadRuns().catch((reason) => active && setError(errorMessage(reason))).finally(() => active && setLoadingRuns(false));
    return () => { active = false; };
  }, [loadRuns]);

  useEffect(() => {
    if (!selectedRunId) {
      detailsRef.current = null;
      setDetails(null);
      return;
    }
    const generation = ++requestGeneration.current;
    const controller = new AbortController();
    let timer: number | undefined;
    let disposed = false;
    let accumulated =
      detailsRef.current?.run.id === selectedRunId ? detailsRef.current : null;

    const poll = async () => {
      try {
        const next = await coordinationApi.detail(
          selectedRunId,
          controller.signal,
          accumulated?.cursor,
        );
        if (disposed || generation !== requestGeneration.current) return;
        accumulated = accumulated ? mergeDetails(accumulated, next) : {
          ...next,
          cursor: (next.events.at(-1)?.sequence ?? -1) + 1,
        };
        detailsRef.current = accumulated;
        setDetails(accumulated);
        setRuns((current) => current.map((run) => run.id === accumulated!.run.id ? accumulated!.run : run));
        setError(null);
        setLoadingDetail(false);
        if (activeStatuses.has(accumulated.run.status)) timer = window.setTimeout(() => void poll(), 1_500);
      } catch (reason) {
        if (disposed || controller.signal.aborted) return;
        setLoadingDetail(false);
        setError(errorMessage(reason));
      }
    };

    setLoadingDetail(accumulated === null);
    if (accumulated === null) {
      detailsRef.current = null;
      setDetails(null);
    }
    void poll();
    return () => {
      disposed = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [selectedRunId, pollEpoch]);

  const created = async (run: CoordinationRun) => {
    setShowCreate(false);
    await loadRuns(run.id);
  };

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!details || action !== null || !message.trim()) return;
    const content = message.trim();
    setAction("send");
    setError(null);
    try {
      const clientMessageId = crypto.randomUUID();
      const { run } = await coordinationApi.sendMessage(details.run.id, content, clientMessageId);
      setMessage("");
      const nextDetails = { ...details, run };
      detailsRef.current = nextDetails;
      setDetails(nextDetails);
      setRuns((current) => current.map((item) => item.id === run.id ? run : item));
      setPollEpoch((current) => current + 1);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setAction(null);
    }
  };

  const stop = async () => {
    if (!details || action !== null) return;
    setAction("stop");
    setError(null);
    try {
      const { run } = await coordinationApi.stop(details.run.id);
      const nextDetails = { ...details, run };
      detailsRef.current = nextDetails;
      setDetails(nextDetails);
      setRuns((current) => current.map((item) => item.id === run.id ? run : item));
      setPollEpoch((current) => current + 1);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setAction(null);
    }
  };

  const end = async () => {
    if (!details || action !== null) return;
    setAction("end");
    setError(null);
    try {
      const { run } = await coordinationApi.end(details.run.id);
      const nextDetails = { ...details, run };
      detailsRef.current = nextDetails;
      setDetails(nextDetails);
      setRuns((current) => current.map((item) => item.id === run.id ? run : item));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setAction(null);
    }
  };

  const selectedRun = details?.run;
  const session = selectedRun ? isSessionRun(selectedRun) : false;
  // A run created by the removed verified-handoff workflow opens read-only: its
  // evidence stays reachable, but this app no longer drives that workflow.
  const legacy = Boolean(selectedRun) && !session;
  const ungroupedEvents = useMemo(() => details?.events.filter(({ turnId }) => !turnId) ?? [], [details]);
  const readyCount = agents.filter(({ status }) => status === "ready").length;
  const activeWaveMessage = selectedRun?.activeTurnIds.length
    ? `${selectedRun.activeTurnIds.length} ${selectedRun.activeTurnIds.length === 1 ? "Agent is" : "Agents are"} working in this wave.`
    : "Agents are working on this wave.";

  if (showCreate) return <CreationForm agents={agents} onCreated={(run) => void created(run)} onCancel={() => setShowCreate(false)} />;

  return (
    <section className="session-workspace" aria-labelledby="session-title">
      <header className="session-hero">
        <div><span className="eyebrow">Agent middleware</span><h1 id="session-title">Sessions</h1><p>Shared Agent sessions with durable evidence.</p></div>
        <button className="button button-primary" onClick={() => setShowCreate(true)} disabled={readyCount < SESSION_LIMITS.minParticipants}>Create session</button>
      </header>
      {readyCount < SESSION_LIMITS.minParticipants && <div className="session-notice" role="status">Create or start at least two Agents before configuring a session.</div>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}>×</button></div>}

      <div className="session-layout">
        <aside className="run-index" aria-label="Sessions">
          <div className="run-index-heading"><span>Sessions</span><strong>{runs.length}</strong></div>
          {loadingRuns && <p className="session-muted" role="status">Loading sessions…</p>}
          {!loadingRuns && runs.length === 0 && <div className="empty-run-list"><strong>No sessions yet</strong><p>Create a session and add Agents to it.</p></div>}
          {runs.map((run) => (
            <button className={`run-index-item ${run.id === selectedRunId ? "selected" : ""}`} key={run.id} onClick={() => setSelectedRunId(run.id)}>
              <strong>{run.name}</strong><RunStatus status={run.status} />
              <span>{isSessionRun(run) ? "Shared session" : "Legacy verified handoff"} · {formatDate(run.updatedAt)}</span>
            </button>
          ))}
        </aside>

        <div className="session-detail">
          {loadingDetail && <div className="session-detail-empty" role="status">Loading session evidence…</div>}
          {!loadingDetail && !selectedRun && <div className="session-detail-empty"><div>⇄</div><h2>Select a session</h2><p>Its participants, transcript, attempts, and evidence will appear here.</p></div>}
          {selectedRun && details && (
            <>
              <header className="run-detail-header">
                <div><div className="run-title-row"><h2>{selectedRun.name}</h2><RunStatus status={selectedRun.status} /></div><p>{selectedRun.objective}</p></div>
                <div className="run-actions">
                  {!legacy && activeStatuses.has(selectedRun.status) && <button className="button button-danger" onClick={() => void stop()} disabled={action !== null}>{action === "stop" ? "Stopping…" : "Stop wave"}</button>}
                  {!legacy && (selectedRun.status === "created" || selectedRun.status === "awaiting_input") && <button className="button button-ghost" onClick={() => void end()} disabled={action !== null}>{action === "end" ? "Ending…" : "End session"}</button>}
                </div>
              </header>

              {legacy && (
                <div className="terminal-summary legacy-summary" role="status">
                  <strong>Legacy workflow</strong>
                  <p>This run used the verified-handoff workflow, which this app no longer creates or drives. Its evidence is shown read-only.</p>
                </div>
              )}

              {(selectedRun.errorMessage || selectedRun.status === "failed" || selectedRun.status === "stopped") && (
                <div className={`terminal-summary terminal-${selectedRun.status}`} role="status">
                  <strong>{selectedRun.status === "failed" ? "Session failed" : selectedRun.status === "stopped" ? "Session stopped" : "Session update"}</strong>
                  <p>{terminalMessage(selectedRun)}</p>
                  {selectedRun.errorCode && <code>{selectedRun.errorCode}</code>}
                </div>
              )}

              <div className="run-facts">
                <div><span>Workflow</span><strong>{session ? "Shared session" : "Legacy verified handoff"}</strong></div>
                <div><span>Status phase</span><strong>{humanize(selectedRun.phase)}</strong></div>
                <div><span>Turns</span><strong>{details.turns.length} / {selectedRun.policy.maxTurns.toLocaleString()}</strong></div>
                <div><span>Attempt timeout</span><strong>{selectedRun.policy.perAttemptTimeoutMs / 1_000}s</strong></div>
              </div>

              {details.turns.length >= SESSION_LIMITS.sessionTurnWarningThreshold && (
                <div className="session-notice session-notice-warning" role="status">
                  {details.turns.length >= SESSION_LIMITS.recommendedMaxSessionTurns
                    ? `This session has ${details.turns.length.toLocaleString()} turns, past the measured comfortable length of ${SESSION_LIMITS.recommendedMaxSessionTurns}. Every prompt now rewrites the whole transcript, so replies keep getting slower. Start a new session to stay responsive.`
                    : `This session is approaching ${SESSION_LIMITS.recommendedMaxSessionTurns} turns, the measured length beyond which prompts get noticeably slower.`}
                </div>
              )}

              {session && (
                <section className="session-state" aria-label="Session state">
                  <div><span>Protocol</span><strong>{selectedRun.policy.sessionProtocol === "countdown" ? "Countdown" : "Free chat"}</strong></div>
                  <div><span>Planning</span><strong>{selectedRun.policy.sessionPlanning === "coordinator" ? "Coordinator" : "Round robin"}</strong></div>
                  {selectedRun.policy.sessionProtocol === "countdown" && (
                    <div className="expected-number"><span>{selectedRun.status === "completed" ? "Countdown state" : "Next expected number"}</span><strong>{selectedRun.status === "completed" ? "Complete" : selectedRun.sharedState?.nextExpectedNumber ?? "Unavailable"}</strong></div>
                  )}
                </section>
              )}

              <ParticipantMap details={details} />

              {session && (
                <section className="evidence-section transcript-section">
                  <div className="session-section-heading"><div><span className="eyebrow">Shared conversation</span><h3>Transcript</h3></div><span className="evidence-count">{details.artifacts.filter(({ type }) => type === "session_message" || type === "user_message").length} messages</span></div>
                  <SessionPlanCard details={details} />
                  <SessionTranscript details={details} />
                  <form className="session-composer" onSubmit={send}>
                    <label htmlFor="session-message">Message the session</label>
                    <textarea
                      id="session-message"
                      value={message}
                      maxLength={4_000}
                      rows={3}
                      disabled={selectedRun.status !== "created" && selectedRun.status !== "awaiting_input"}
                      onChange={(event) => setMessage(event.target.value)}
                      placeholder={activeStatuses.has(selectedRun.status) ? "Agents are working…" : "Ask the Agents what to do next"}
                    />
                    <div className="session-composer-actions">
                      <p>{activeStatuses.has(selectedRun.status) ? `${activeWaveMessage} Stop ends only this wave; End session permanently closes the conversation.` : selectedRun.status === "completed" ? "This session has ended." : "Send starts the next wave. Stop cancels a wave; End session permanently closes the conversation."}</p>
                      <button className="button button-primary" disabled={!message.trim() || action !== null || (selectedRun.status !== "created" && selectedRun.status !== "awaiting_input")}>{action === "send" ? "Sending…" : "Send message"}</button>
                    </div>
                  </form>
                </section>
              )}

              <section className="evidence-section">
                <div className="session-section-heading"><div><span className="eyebrow">Evidence timeline</span><h3>Turns and attempts</h3></div><span className="evidence-count">{details.events.length} events</span></div>
                {ungroupedEvents.length > 0 && <ol className="event-list run-events">{ungroupedEvents.map((event) => <EventRow event={event} key={event.id} />)}</ol>}
                {details.turns.length === 0 ? <p className="session-muted">No turns have been scheduled.</p> : details.turns.map((turn) => <TurnEvidence turn={turn} details={details} key={turn.id} />)}
              </section>

              {legacy && (
                <section className="evidence-section">
                  <div className="session-section-heading"><div><span className="eyebrow">Committed output</span><h3>Artifacts</h3></div><span className="evidence-count">{details.artifacts.length}</span></div>
                  {details.artifacts.length === 0
                    ? <p className="session-muted">No artifacts have been committed yet.</p>
                    : <div className="artifact-list">{details.artifacts.filter((artifact): artifact is Extract<CoordinationArtifact, { type: "proposal" | "review" | "final" }> => artifact.type === "proposal" || artifact.type === "review" || artifact.type === "final").map((artifact) => <LegacyArtifactCard artifact={artifact} key={artifact.id} />)}</div>}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
