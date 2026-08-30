import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "./api";
import { coordinationApi } from "./coordination-api";
import type {
  CoordinationArtifact,
  CoordinationEvent,
  CoordinationRun,
  CoordinationRunDetails,
  CoordinationRunStatus,
  CoordinationTurn,
  CreateCoordinationRunRequest,
  RequiredSection,
} from "./coordination-types";
import type { Agent } from "./types";

const activeStatuses = new Set<CoordinationRunStatus>(["running", "stop_requested"]);
const roleLabels = { planner: "Planner", critic: "Critic", finalizer: "Finaliser" } as const;

interface RelayWorkspaceProps {
  agents: Agent[];
}

interface FormState {
  name: string;
  objective: string;
  sections: RequiredSection[];
  plannerAgentId: string;
  criticAgentId: string;
  finalizerAgentId: string;
  maxRevisions: string;
  maxTurns: string;
  perAttemptTimeoutSeconds: string;
}

const initialForm = (agents: Agent[]): FormState => {
  const ready = agents.filter(({ status }) => status === "ready");
  return {
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

function RunStatus({ status }: { status: CoordinationRunStatus }) {
  return <span className={`relay-status relay-status-${status}`}>{humanize(status)}</span>;
}

function validateForm(form: FormState, agents: Agent[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = form.name.trim();
  const objective = form.objective.trim();
  if (!name || name.length > 80) errors.name = "Use a name between 1 and 80 characters.";
  if (!objective || objective.length > 4_000) errors.objective = "Use an objective between 1 and 4,000 characters.";
  if (form.sections.length < 1 || form.sections.length > 10) errors.sections = "Add between 1 and 10 required sections.";
  const keys = form.sections.map(({ key }) => key.trim());
  if (keys.some((key) => !/^[a-z0-9][a-z0-9_-]*$/.test(key))) errors.sections = "Section keys must be lower-case slugs.";
  if (new Set(keys).size !== keys.length) errors.sections = "Section keys must be unique.";
  if (form.sections.some(({ title }) => !title.trim() || title.trim().length > 120)) errors.sections = "Each section needs a title of at most 120 characters.";

  const selections = [form.plannerAgentId, form.criticAgentId, form.finalizerAgentId];
  if (selections.some((id) => !id) || new Set(selections).size !== 3) errors.agents = "Choose three different ready Agents.";
  const readyIds = new Set(agents.filter(({ status }) => status === "ready").map(({ id }) => id));
  if (selections.some((id) => !readyIds.has(id))) errors.agents = "Every selected Agent must be ready.";

  const maxRevisions = Number(form.maxRevisions);
  const maxTurns = Number(form.maxTurns);
  const timeout = Number(form.perAttemptTimeoutSeconds);
  if (!Number.isInteger(maxRevisions) || maxRevisions < 0 || maxRevisions > 3) errors.policy = "Maximum revisions must be 0–3.";
  if (!Number.isInteger(maxTurns) || maxTurns < 3 || maxTurns > 12) errors.policy = "Maximum turns must be 3–12.";
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 180) errors.policy = "Attempt timeout must be 10–180 seconds.";
  return errors;
}

function ArtifactCard({ artifact }: { artifact: CoordinationArtifact }) {
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

function TurnEvidence({ turn, details }: { turn: CoordinationTurn; details: CoordinationRunDetails }) {
  const attempts = details.attempts.filter(({ turnId }) => turnId === turn.id).sort((a, b) => a.number - b.number);
  const events = details.events.filter(({ turnId }) => turnId === turn.id);
  return (
    <article className="turn-evidence">
      <header>
        <span className="turn-number">{turn.sequence}</span>
        <div>
          <span className="eyebrow">{roleLabels[turn.role]}</span>
          <h4>{humanize(turn.kind)}</h4>
        </div>
        <span className={`turn-status turn-status-${turn.status}`}>{turn.status}</span>
      </header>
      <div className="attempt-list" aria-label={`Attempts for turn ${turn.sequence}`}>
        {attempts.map((attempt) => (
          <div className="attempt-row" key={attempt.id}>
            <strong>Attempt {attempt.number}</strong>
            <span className={`attempt-status attempt-status-${attempt.status}`}>{humanize(attempt.status)}</span>
            {attempt.errorMessage && <p>{attempt.errorMessage}</p>}
          </div>
        ))}
      </div>
      {events.length > 0 && <ol className="event-list">{events.map((event) => <EventRow event={event} key={event.id} />)}</ol>}
    </article>
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
  const sectionRef = useRef<HTMLInputElement>(null);
  const policyRef = useRef<HTMLInputElement>(null);
  const readyAgents = agents.filter(({ status }) => status === "ready");

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
          : nextErrors.agents ? plannerRef.current
            : nextErrors.sections ? sectionRef.current
              : policyRef.current;
      firstInvalid?.focus();
      return;
    }
    setSubmitting(true);
    const request: CreateCoordinationRunRequest = {
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
    <form className="relay-create" onSubmit={submit} noValidate>
      <div className="relay-section-heading">
        <div><span className="eyebrow">New Relay run</span><h2>Configure a verified handoff</h2></div>
        <button type="button" className="button button-ghost" onClick={onCancel}>Cancel</button>
      </div>
      {serverError && <div className="error-banner" role="alert">{serverError}</div>}
      <div className="relay-form-grid">
        <label>Run name<input ref={nameRef} autoFocus value={form.name} maxLength={80} aria-invalid={Boolean(errors.name)} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label className="relay-objective">Objective<textarea ref={objectiveRef} rows={4} value={form.objective} maxLength={4_000} aria-invalid={Boolean(errors.objective)} onChange={(event) => setForm({ ...form, objective: event.target.value })} /></label>
      </div>
      {(errors.name || errors.objective) && <p className="field-error" role="alert">{errors.name ?? errors.objective}</p>}

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

      <details className="policy-controls">
        <summary>Safety limits</summary>
        <div className="relay-policy-grid">
          <label>Maximum revisions<input ref={policyRef} type="number" min="0" max="3" value={form.maxRevisions} onChange={(event) => setForm({ ...form, maxRevisions: event.target.value })} /></label>
          <label>Maximum turns<input type="number" min="3" max="12" value={form.maxTurns} onChange={(event) => setForm({ ...form, maxTurns: event.target.value })} /></label>
          <label>Attempt timeout (seconds)<input type="number" min="10" max="180" value={form.perAttemptTimeoutSeconds} onChange={(event) => setForm({ ...form, perAttemptTimeoutSeconds: event.target.value })} /></label>
        </div>
        {errors.policy && <p className="field-error" role="alert">{errors.policy}</p>}
      </details>

      <div className="relay-create-footer"><p>Creating the run does not start it. You can review the configuration first.</p><button className="button button-primary" disabled={submitting}>{submitting ? "Creating…" : "Create run"}</button></div>
    </form>
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
    if (!details) return;
    setAction("stop");
    setError(null);
    try {
      const { run } = await coordinationApi.stop(details.run.id);
      setDetails({ ...details, run });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setAction(null);
    }
  };

  const selectedRun = details?.run;
  const ungroupedEvents = useMemo(() => details?.events.filter(({ turnId }) => !turnId) ?? [], [details]);

  if (showCreate) return <CreationForm agents={agents} onCreated={(run) => void created(run)} onCancel={() => setShowCreate(false)} />;

  return (
    <section className="relay-workspace" aria-labelledby="relay-title">
      <header className="relay-hero">
        <div><span className="eyebrow">Agent middleware</span><h1 id="relay-title">Relay</h1><p>Verified Planner → Critic → Finaliser handoffs with durable evidence.</p></div>
        <button className="button button-primary" onClick={() => setShowCreate(true)} disabled={agents.filter(({ status }) => status === "ready").length < 3}>Create Relay run</button>
      </header>
      {agents.filter(({ status }) => status === "ready").length < 3 && <div className="relay-notice" role="status">Create or start at least three Agents before configuring Relay.</div>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}>×</button></div>}

      <div className="relay-layout">
        <aside className="run-index" aria-label="Relay runs">
          <div className="run-index-heading"><span>Runs</span><strong>{runs.length}</strong></div>
          {loadingRuns && <p className="relay-muted" role="status">Loading runs…</p>}
          {!loadingRuns && runs.length === 0 && <div className="empty-run-list"><strong>No Relay runs yet</strong><p>Create one to coordinate three ready Agents.</p></div>}
          {runs.map((run) => (
            <button className={`run-index-item ${run.id === selectedRunId ? "selected" : ""}`} key={run.id} onClick={() => setSelectedRunId(run.id)}>
              <strong>{run.name}</strong><RunStatus status={run.status} /><span>{formatDate(run.updatedAt)}</span>
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
                <div><span>Status phase</span><strong>{humanize(selectedRun.phase)}</strong></div>
                <div><span>Revision</span><strong>{selectedRun.revision} / {selectedRun.policy.maxRevisions}</strong></div>
                <div><span>Turns</span><strong>{details.turns.length} / {selectedRun.policy.maxTurns}</strong></div>
                <div><span>Attempt timeout</span><strong>{selectedRun.policy.perAttemptTimeoutMs / 1_000}s</strong></div>
              </div>

              <section className="role-map" aria-label="Role assignments">
                {selectedRun.participants.map((participant) => <div key={participant.role}><span>{roleLabels[participant.role]}</span><strong>{participant.agentNameSnapshot}</strong></div>)}
              </section>

              <section className="evidence-section">
                <div className="relay-section-heading"><div><span className="eyebrow">Evidence timeline</span><h3>Workflow and attempts</h3></div><span className="evidence-count">{details.events.length} events</span></div>
                {ungroupedEvents.length > 0 && <ol className="event-list run-events">{ungroupedEvents.map((event) => <EventRow event={event} key={event.id} />)}</ol>}
                {details.turns.length === 0 ? <p className="relay-muted">No turns have been scheduled.</p> : details.turns.map((turn) => <TurnEvidence turn={turn} details={details} key={turn.id} />)}
              </section>

              <section className="evidence-section">
                <div className="relay-section-heading"><div><span className="eyebrow">Committed output</span><h3>Artifacts</h3></div><span className="evidence-count">{details.artifacts.length}</span></div>
                {details.artifacts.length === 0 ? <p className="relay-muted">No artifacts have been committed yet.</p> : <div className="artifact-list">{details.artifacts.map((artifact) => <ArtifactCard artifact={artifact} key={artifact.id} />)}</div>}
              </section>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
