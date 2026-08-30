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
  CreateCoordinationRunRequest,
  CreateRunRequest,
  CreateSessionRunRequest,
  RequiredSection,
  SessionProtocol,
} from "./coordination-types";
import { SESSION_LIMITS } from "./coordination-types";
import type { Agent } from "./types";

const activeStatuses = new Set<CoordinationRunStatus>(["running", "stop_requested"]);
const roleLabels = {
  planner: "Planner",
  critic: "Critic",
  finalizer: "Finaliser",
  participant: "Participant",
} as const;

interface RelayWorkspaceProps {
  agents: Agent[];
}

type FormMode = "verified" | "session";

interface FormState {
  mode: FormMode;
  name: string;
  objective: string;
  sections: RequiredSection[];
  plannerAgentId: string;
  criticAgentId: string;
  finalizerAgentId: string;
  sessionAgentIds: string[];
  sessionProtocol: SessionProtocol;
  sessionStartValue: string;
  maxRevisions: string;
  maxTurns: string;
  perAttemptTimeoutSeconds: string;
}

const initialForm = (agents: Agent[]): FormState => {
  const ready = agents.filter(({ status }) => status === "ready");
  return {
    mode: "verified",
    name: "Verified handoff",
    objective: "",
    sections: [
      { key: "summary", title: "Summary" },
      { key: "recommendations", title: "Recommendations" },
      { key: "risks", title: "Risks and Mitigations" },
    ],
    plannerAgentId: ready[0]?.id ?? "",
    criticAgentId: ready[1]?.id ?? "",
    finalizerAgentId: ready[2]?.id ?? "",
    sessionAgentIds: ready.slice(0, 3).map(({ id }) => id),
    sessionProtocol: "countdown",
    sessionStartValue: String(SESSION_LIMITS.defaultStartValue),
    maxRevisions: "2",
    maxTurns: "8",
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
    case "STOPPED_BY_USER": return "The run was stopped by the user. The same Agents can be used in a new run.";
    case "SERVER_RESTARTED": return "The server restarted during this run. Create a new run to continue safely.";
    case "MAX_ATTEMPTS_EXCEEDED": return "A turn exhausted its retry limit. Review the attempt evidence before trying again.";
    case "MAX_REVISIONS_EXCEEDED": return "The proposal reached its revision limit without approval. Review the Critic feedback.";
    case "MAX_TURNS_EXCEEDED": return "The workflow reached its turn limit. Review the latest committed artifacts.";
    default: return "The run reached a terminal state. Review the evidence below before trying again.";
  }
};

const isSessionRun = (run: CoordinationRun): boolean =>
  run.policy.workflow === "shared_session_v1";

function RunStatus({ status }: { status: CoordinationRunStatus }) {
  return <span className={`relay-status relay-status-${status}`}>{humanize(status)}</span>;
}

function validateForm(form: FormState, agents: Agent[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = form.name.trim();
  const objective = form.objective.trim();
  if (!name || name.length > 80) errors.name = "Use a name between 1 and 80 characters.";
  if (!objective || objective.length > 4_000) errors.objective = "Use an objective between 1 and 4,000 characters.";

  const readyIds = new Set(agents.filter(({ status }) => status === "ready").map(({ id }) => id));
  const timeout = Number(form.perAttemptTimeoutSeconds);
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 180) {
    errors.policy = "Attempt timeout must be 10-180 seconds.";
  }

  if (form.mode === "session") {
    if (
      form.sessionAgentIds.length < SESSION_LIMITS.minParticipants ||
      form.sessionAgentIds.length > SESSION_LIMITS.maxParticipants ||
      new Set(form.sessionAgentIds).size !== form.sessionAgentIds.length
    ) {
      errors.agents = "Choose 2-6 different ready Agents in turn order.";
    } else if (form.sessionAgentIds.some((id) => !readyIds.has(id))) {
      errors.agents = "Every session participant must be ready.";
    }

    const maxTurns = Number(form.maxTurns);
    if (form.sessionProtocol === "countdown") {
      const startValue = Number(form.sessionStartValue);
      if (
        !Number.isInteger(startValue) ||
        startValue < SESSION_LIMITS.minStartValue ||
        startValue > SESSION_LIMITS.maxStartValue
      ) {
        errors.policy = "Countdown start value must be an integer from 2-12.";
      } else if (!Number.isInteger(maxTurns) || maxTurns < startValue || maxTurns > 12) {
        errors.policy = "Countdown maximum turns must be at least the start value and no more than 12.";
      }
    } else if (
      !Number.isInteger(maxTurns) ||
      maxTurns < SESSION_LIMITS.minFreeChatTurns ||
      maxTurns > SESSION_LIMITS.maxFreeChatTurns
    ) {
      errors.policy = "Free-chat maximum turns must be an integer from 3-12.";
    }
    return errors;
  }

  if (form.sections.length < 1 || form.sections.length > 10) {
    errors.sections = "Add between 1 and 10 required sections.";
  }
  const keys = form.sections.map(({ key }) => key.trim());
  if (keys.some((key) => !/^[a-z0-9][a-z0-9_-]*$/.test(key))) {
    errors.sections = "Section keys must be lower-case slugs.";
  }
  if (new Set(keys).size !== keys.length) errors.sections = "Section keys must be unique.";
  if (form.sections.some(({ title }) => !title.trim() || title.trim().length > 120)) {
    errors.sections = "Each section needs a title of at most 120 characters.";
  }

  const selections = [form.plannerAgentId, form.criticAgentId, form.finalizerAgentId];
  if (selections.some((id) => !id) || new Set(selections).size !== 3) {
    errors.agents = "Choose three different ready Agents.";
  } else if (selections.some((id) => !readyIds.has(id))) {
    errors.agents = "Every selected Agent must be ready.";
  }

  const maxRevisions = Number(form.maxRevisions);
  const maxTurns = Number(form.maxTurns);
  if (!Number.isInteger(maxRevisions) || maxRevisions < 0 || maxRevisions > 3) {
    errors.policy = "Maximum revisions must be 0-3.";
  }
  if (!Number.isInteger(maxTurns) || maxTurns < 3 || maxTurns > 12) {
    errors.policy = "Maximum turns must be 3-12.";
  }
  return errors;
}

function ArtifactCard({ artifact }: { artifact: Exclude<CoordinationArtifact, { type: "session_message" }> }) {
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

function SessionTranscript({ details }: { details: CoordinationRunDetails }) {
  const messages = details.artifacts.filter(
    (artifact): artifact is Extract<CoordinationArtifact, { type: "session_message" }> =>
      artifact.type === "session_message",
  );
  if (messages.length === 0) {
    return <div className="transcript-empty"><strong>No messages yet</strong><p>The transcript will appear after the first committed turn.</p></div>;
  }
  return (
    <ol className="session-transcript" aria-label="Session transcript">
      {messages.map((message) => {
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
      <p>Select 2-6 ready Agents. The numbered order below is the backend round-robin order.</p>
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
  const plannerRef = useRef<HTMLSelectElement>(null);
  const sessionParticipantRef = useRef<HTMLFieldSetElement>(null);
  const sectionRef = useRef<HTMLInputElement>(null);
  const policyRef = useRef<HTMLInputElement>(null);
  const readyAgents = agents.filter(({ status }) => status === "ready");

  const setMode = (mode: FormMode) => {
    setErrors({});
    setServerError(null);
    setForm((current) => ({
      ...current,
      mode,
      name: current.name === "Verified handoff" || current.name === "Shared session"
        ? mode === "session" ? "Shared session" : "Verified handoff"
        : current.name,
      maxTurns: mode === "session" ? String(SESSION_LIMITS.defaultStartValue) : "8",
    }));
  };

  const updateSection = (index: number, field: keyof RequiredSection, value: string) => {
    setForm((current) => ({
      ...current,
      sections: current.sections.map((section, sectionIndex) =>
        sectionIndex === index ? { ...section, [field]: value } : section),
    }));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextErrors = validateForm(form, agents);
    setErrors(nextErrors);
    setServerError(null);
    if (Object.keys(nextErrors).length > 0) {
      const firstInvalid = nextErrors.name ? nameRef.current
        : nextErrors.objective ? objectiveRef.current
          : nextErrors.agents ? form.mode === "session" ? sessionParticipantRef.current : plannerRef.current
            : nextErrors.sections ? sectionRef.current
              : policyRef.current;
      firstInvalid?.focus();
      return;
    }

    setSubmitting(true);
    let request: CreateRunRequest;
    if (form.mode === "session") {
      request = {
        workflow: "shared_session_v1",
        name: form.name.trim(),
        objective: form.objective.trim(),
        agents: form.sessionAgentIds,
        policy: {
          sessionProtocol: form.sessionProtocol,
          ...(form.sessionProtocol === "countdown"
            ? { sessionStartValue: Number(form.sessionStartValue) }
            : {}),
          maxTurns: Number(form.maxTurns),
          perAttemptTimeoutMs: Number(form.perAttemptTimeoutSeconds) * 1_000,
        },
      } satisfies CreateSessionRunRequest;
    } else {
      request = {
        workflow: "verified_handoff_v1",
        name: form.name.trim(),
        objective: form.objective.trim(),
        requiredSections: form.sections.map(({ key, title }) => ({ key: key.trim(), title: title.trim() })),
        agents: {
          plannerAgentId: form.plannerAgentId,
          criticAgentId: form.criticAgentId,
          finalizerAgentId: form.finalizerAgentId,
        },
        policy: {
          maxRevisions: Number(form.maxRevisions),
          maxTurns: Number(form.maxTurns),
          perAttemptTimeoutMs: Number(form.perAttemptTimeoutSeconds) * 1_000,
        },
      } satisfies CreateCoordinationRunRequest;
    }

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
    <form className="relay-create" onSubmit={submit} noValidate>
      <div className="relay-section-heading">
        <div><span className="eyebrow">New Relay run</span><h2>Configure coordination</h2></div>
        <button type="button" className="button button-ghost" onClick={onCancel}>Cancel</button>
      </div>
      {serverError && <div className="error-banner" role="alert">{serverError}</div>}

      <fieldset className="workflow-toggle">
        <legend>Workflow</legend>
        <div>
          <label className={form.mode === "verified" ? "selected" : ""}>
            <input type="radio" name="workflow" value="verified" checked={form.mode === "verified"} onChange={() => setMode("verified")} />
            <span><strong>Verified handoff</strong><small>Planner, Critic, and Finaliser exchange typed artifacts.</small></span>
          </label>
          <label className={form.mode === "session" ? "selected" : ""}>
            <input type="radio" name="workflow" value="session" checked={form.mode === "session"} onChange={() => setMode("session")} />
            <span><strong>Shared session</strong><small>2-6 Agents take round-robin turns in one transcript.</small></span>
          </label>
        </div>
      </fieldset>

      <div className="relay-form-grid">
        <label>Run name<input ref={nameRef} autoFocus value={form.name} maxLength={80} aria-invalid={Boolean(errors.name)} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label className="relay-objective">Objective<textarea ref={objectiveRef} rows={4} value={form.objective} maxLength={4_000} aria-invalid={Boolean(errors.objective)} onChange={(event) => setForm({ ...form, objective: event.target.value })} /></label>
      </div>
      {(errors.name || errors.objective) && <p className="field-error" role="alert">{errors.name ?? errors.objective}</p>}

      {form.mode === "verified" ? (
        <>
          <fieldset>
            <legend>Role assignments</legend>
            <p>Choose three different ready Agents. Relay reserves them while the run is active.</p>
            <div className="relay-role-grid">
              {(["planner", "critic", "finalizer"] as const).map((role) => {
                const field = `${role}AgentId` as const;
                return <label key={role}>{roleLabels[role]}<select ref={role === "planner" ? plannerRef : undefined} value={form[field]} onChange={(event) => setForm({ ...form, [field]: event.target.value })}><option value="">Select an Agent</option>{readyAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>;
              })}
            </div>
            {errors.agents && <p className="field-error" role="alert">{errors.agents}</p>}
          </fieldset>

          <fieldset>
            <div className="fieldset-heading"><legend>Required sections</legend><button type="button" className="button button-ghost" disabled={form.sections.length >= 10} onClick={() => setForm({ ...form, sections: [...form.sections, { key: "", title: "" }] })}>Add section</button></div>
            <div className="section-editor">
              {form.sections.map((section, index) => (
                <div className="section-row" key={index}>
                  <label>Key<input ref={index === 0 ? sectionRef : undefined} aria-label={`Section ${index + 1} key`} value={section.key} maxLength={64} onChange={(event) => updateSection(index, "key", event.target.value.toLowerCase().replaceAll(" ", "-"))} /></label>
                  <label>Title<input aria-label={`Section ${index + 1} title`} value={section.title} maxLength={120} onChange={(event) => updateSection(index, "title", event.target.value)} /></label>
                  <button type="button" aria-label={`Remove section ${index + 1}`} disabled={form.sections.length === 1} onClick={() => setForm({ ...form, sections: form.sections.filter((_, itemIndex) => itemIndex !== index) })}>×</button>
                </div>
              ))}
            </div>
            {errors.sections && <p className="field-error" role="alert">{errors.sections}</p>}
          </fieldset>
        </>
      ) : (
        <>
          <fieldset>
            <legend>Session protocol</legend>
            <p>Countdown accepts only the exact next integer. Free chat accepts bounded messages until consensus or the turn limit.</p>
            <div className="protocol-options">
              <label><input type="radio" name="sessionProtocol" value="countdown" checked={form.sessionProtocol === "countdown"} onChange={() => setForm({ ...form, sessionProtocol: "countdown", maxTurns: form.sessionStartValue })} />Countdown</label>
              <label><input type="radio" name="sessionProtocol" value="free_chat" checked={form.sessionProtocol === "free_chat"} onChange={() => setForm({ ...form, sessionProtocol: "free_chat", maxTurns: String(SESSION_LIMITS.defaultFreeChatTurns) })} />Free chat</label>
            </div>
          </fieldset>
          <SessionParticipantPicker
            agents={agents}
            selectedIds={form.sessionAgentIds}
            error={errors.agents}
            focusRef={sessionParticipantRef}
            onChange={(sessionAgentIds) => setForm({ ...form, sessionAgentIds })}
          />
        </>
      )}

      <details className="policy-controls" open={form.mode === "session"}>
        <summary>Safety limits</summary>
        <div className="relay-policy-grid">
          {form.mode === "verified" && <label>Maximum revisions<input ref={policyRef} type="number" min="0" max="3" value={form.maxRevisions} onChange={(event) => setForm({ ...form, maxRevisions: event.target.value })} /></label>}
          {form.mode === "session" && form.sessionProtocol === "countdown" && <label>Countdown start<input ref={policyRef} type="number" min="2" max="12" value={form.sessionStartValue} onChange={(event) => setForm({ ...form, sessionStartValue: event.target.value, maxTurns: event.target.value })} /></label>}
          <label>Maximum turns<input ref={form.mode === "session" && form.sessionProtocol === "free_chat" ? policyRef : undefined} type="number" min={form.mode === "session" && form.sessionProtocol === "countdown" ? form.sessionStartValue : "3"} max="12" value={form.maxTurns} onChange={(event) => setForm({ ...form, maxTurns: event.target.value })} /></label>
          <label>Attempt timeout (seconds)<input type="number" min="10" max="180" value={form.perAttemptTimeoutSeconds} onChange={(event) => setForm({ ...form, perAttemptTimeoutSeconds: event.target.value })} /></label>
        </div>
        {errors.policy && <p className="field-error" role="alert">{errors.policy}</p>}
      </details>

      <div className="relay-create-footer"><p>Creating the run does not start it. Review the configuration, then start it as a separate action.</p><button className="button button-primary" disabled={submitting}>{submitting ? "Creating…" : "Create run"}</button></div>
    </form>
  );
}

function ParticipantMap({ details }: { details: CoordinationRunDetails }) {
  const isSession = isSessionRun(details.run);
  const doneByAgent = isSession && details.run.policy.sessionProtocol === "free_chat"
    ? latestDoneByParticipant(details)
    : new Map<string, boolean>();
  return (
    <section className={isSession ? "role-map session-role-map" : "role-map"} aria-label={isSession ? "Session participants" : "Role assignments"}>
      {details.run.participants.map((participant: CoordinationParticipant, index) => (
        <div key={participant.agentId}>
          <span>{isSession ? `Turn position ${index + 1}` : roleLabels[participant.role]}</span>
          <strong>{participant.agentNameSnapshot}</strong>
          {isSession && details.run.policy.sessionProtocol === "free_chat" && (
            <small className={doneByAgent.get(participant.agentId) ? "consensus-done" : "consensus-open"}>
              {doneByAgent.get(participant.agentId) ? "done signalled" : "still contributing"}
            </small>
          )}
        </div>
      ))}
    </section>
  );
}

export function RelayWorkspace({ agents }: RelayWorkspaceProps) {
  const [runs, setRuns] = useState<CoordinationRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [details, setDetails] = useState<CoordinationRunDetails | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [action, setAction] = useState<"start" | "stop" | null>(null);
  const [pollEpoch, setPollEpoch] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

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
      setDetails(null);
      return;
    }
    const generation = ++requestGeneration.current;
    const controller = new AbortController();
    let timer: number | undefined;
    let disposed = false;

    const poll = async () => {
      try {
        const next = await coordinationApi.detail(selectedRunId, controller.signal);
        if (disposed || generation !== requestGeneration.current) return;
        setDetails(next);
        setRuns((current) => current.map((run) => run.id === next.run.id ? next.run : run));
        setError(null);
        setLoadingDetail(false);
        if (activeStatuses.has(next.run.status)) timer = window.setTimeout(() => void poll(), 1_500);
      } catch (reason) {
        if (disposed || controller.signal.aborted) return;
        setLoadingDetail(false);
        setError(errorMessage(reason));
      }
    };

    setLoadingDetail(true);
    setDetails(null);
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

  const start = async () => {
    if (!details) return;
    setAction("start");
    setError(null);
    try {
      const { run } = await coordinationApi.start(details.run.id);
      setDetails({ ...details, run });
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
      setDetails({ ...details, run });
      setRuns((current) => current.map((item) => item.id === run.id ? run : item));
      setPollEpoch((current) => current + 1);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setAction(null);
    }
  };

  const selectedRun = details?.run;
  const session = selectedRun ? isSessionRun(selectedRun) : false;
  const ungroupedEvents = useMemo(() => details?.events.filter(({ turnId }) => !turnId) ?? [], [details]);
  const readyCount = agents.filter(({ status }) => status === "ready").length;

  if (showCreate) return <CreationForm agents={agents} onCreated={(run) => void created(run)} onCancel={() => setShowCreate(false)} />;

  return (
    <section className="relay-workspace" aria-labelledby="relay-title">
      <header className="relay-hero">
        <div><span className="eyebrow">Agent middleware</span><h1 id="relay-title">Relay</h1><p>Verified handoffs and shared sessions with durable evidence.</p></div>
        <button className="button button-primary" onClick={() => setShowCreate(true)} disabled={readyCount < 2}>Create Relay run</button>
      </header>
      {readyCount < 2 && <div className="relay-notice" role="status">Create or start at least two Agents before configuring Relay.</div>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}>×</button></div>}

      <div className="relay-layout">
        <aside className="run-index" aria-label="Relay runs">
          <div className="run-index-heading"><span>Runs</span><strong>{runs.length}</strong></div>
          {loadingRuns && <p className="relay-muted" role="status">Loading runs…</p>}
          {!loadingRuns && runs.length === 0 && <div className="empty-run-list"><strong>No Relay runs yet</strong><p>Create a verified handoff or shared session.</p></div>}
          {runs.map((run) => (
            <button className={`run-index-item ${run.id === selectedRunId ? "selected" : ""}`} key={run.id} onClick={() => setSelectedRunId(run.id)}>
              <strong>{run.name}</strong><RunStatus status={run.status} />
              <span>{run.policy.workflow === "shared_session_v1" ? "Shared session" : "Verified handoff"} · {formatDate(run.updatedAt)}</span>
            </button>
          ))}
        </aside>

        <div className="relay-detail">
          {loadingDetail && <div className="relay-detail-empty" role="status">Loading run evidence…</div>}
          {!loadingDetail && !selectedRun && <div className="relay-detail-empty"><div>⇄</div><h2>Select a run</h2><p>Its workflow, attempts, decisions, and artifacts will appear here.</p></div>}
          {selectedRun && details && (
            <>
              <header className="run-detail-header">
                <div><div className="run-title-row"><h2>{selectedRun.name}</h2><RunStatus status={selectedRun.status} /></div><p>{selectedRun.objective}</p></div>
                <div className="run-actions">
                  {selectedRun.status === "created" && <button className="button button-primary" onClick={() => void start()} disabled={action !== null}>{action === "start" ? "Starting…" : "Start run"}</button>}
                  {activeStatuses.has(selectedRun.status) && <button className="button button-danger" onClick={() => void stop()} disabled={action !== null}>{action === "stop" ? "Stopping…" : "Stop run"}</button>}
                </div>
              </header>

              {(selectedRun.errorMessage || selectedRun.status === "failed" || selectedRun.status === "stopped") && (
                <div className={`terminal-summary terminal-${selectedRun.status}`} role="status">
                  <strong>{selectedRun.status === "failed" ? "Run failed" : selectedRun.status === "stopped" ? "Run stopped" : "Run update"}</strong>
                  <p>{terminalMessage(selectedRun)}</p>
                  {selectedRun.errorCode && <code>{selectedRun.errorCode}</code>}
                </div>
              )}

              <div className="run-facts">
                <div><span>Workflow</span><strong>{session ? "Shared session" : "Verified handoff"}</strong></div>
                <div><span>Status phase</span><strong>{humanize(selectedRun.phase)}</strong></div>
                <div><span>Turns</span><strong>{details.turns.length} / {selectedRun.policy.maxTurns}</strong></div>
                <div><span>Attempt timeout</span><strong>{selectedRun.policy.perAttemptTimeoutMs / 1_000}s</strong></div>
              </div>

              {session && (
                <section className="session-state" aria-label="Session state">
                  <div><span>Protocol</span><strong>{selectedRun.policy.sessionProtocol === "free_chat" ? "Free chat" : "Countdown"}</strong></div>
                  {selectedRun.policy.sessionProtocol === "countdown" && (
                    <div className="expected-number"><span>{selectedRun.status === "completed" ? "Countdown state" : "Next expected number"}</span><strong>{selectedRun.status === "completed" ? "Complete" : selectedRun.sharedState?.nextExpectedNumber ?? "Unavailable"}</strong></div>
                  )}
                </section>
              )}

              <ParticipantMap details={details} />

              {session && (
                <section className="evidence-section transcript-section">
                  <div className="relay-section-heading"><div><span className="eyebrow">Shared conversation</span><h3>Transcript</h3></div><span className="evidence-count">{details.artifacts.filter(({ type }) => type === "session_message").length} messages</span></div>
                  <SessionTranscript details={details} />
                </section>
              )}

              <section className="evidence-section">
                <div className="relay-section-heading"><div><span className="eyebrow">Evidence timeline</span><h3>Workflow and attempts</h3></div><span className="evidence-count">{details.events.length} events</span></div>
                {ungroupedEvents.length > 0 && <ol className="event-list run-events">{ungroupedEvents.map((event) => <EventRow event={event} key={event.id} />)}</ol>}
                {details.turns.length === 0 ? <p className="relay-muted">No turns have been scheduled.</p> : details.turns.map((turn) => <TurnEvidence turn={turn} details={details} key={turn.id} />)}
              </section>

              {!session && (
                <section className="evidence-section">
                  <div className="relay-section-heading"><div><span className="eyebrow">Committed output</span><h3>Artifacts</h3></div><span className="evidence-count">{details.artifacts.length}</span></div>
                  {details.artifacts.length === 0
                    ? <p className="relay-muted">No artifacts have been committed yet.</p>
                    : <div className="artifact-list">{details.artifacts.filter((artifact): artifact is Exclude<CoordinationArtifact, { type: "session_message" }> => artifact.type !== "session_message").map((artifact) => <ArtifactCard artifact={artifact} key={artifact.id} />)}</div>}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
