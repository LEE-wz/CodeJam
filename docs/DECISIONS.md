# Decisions

Every architectural decision that shaped the coordination layer, with the
alternative that was rejected and why. ADR-01 through ADR-14 were frozen before
implementation began; the mini-RFCs amended them as evidence arrived.

A decision recorded here is binding. Where a later phase changed one, the change
is recorded as a mini-RFC rather than by silently editing the ADR.

## Part 1 — ADR-01 through ADR-14

| # | Decision | Rationale | Rejected alternative |
|---|---|---|---|
| **ADR-01** | Exactly three distinct pre-created Agents map to Planner, Critic, and Finaliser. | Keeps the UI and routing deterministic. | Dynamic creation or reassignment mid-run. *Superseded for sessions by the Session v2 amendment: 2–10 participants, no fixed roles.* |
| **ADR-02** | Turns are sequential; at most one active logical turn per run. | Makes correctness and evidence easy to explain. | Parallel branches. *Superseded by the Phase 13 mini-RFC.* |
| **ADR-03** | Routing is a pure backend state machine. | Model output cannot route itself; workflow tests need no real model. | Letting the model choose the next turn. |
| **ADR-04** | Handoffs are versioned JSON artifacts validated with Zod. | Makes contracts observable and testable. | Free-text handoffs parsed heuristically. |
| **ADR-05** | Strip at most one outer Markdown JSON code fence before parsing. | Tolerates a common model habit without building a permissive parser. | A lenient parser that repairs malformed JSON. |
| **ADR-06** | One invalid or failed attempt is retried once on the same role Agent. | Bounded recovery. | Unbounded retries, or failing over to a different Agent. |
| **ADR-07** | A Critic rejection is a successful committed review, not an execution failure. | It increments the revision counter and routes back to the Planner. | Treating rejection as an error path. |
| **ADR-08** | `maxRevisions = 2` means two revisions after the initial proposal. | Up to three proposal versions; exceeding fails the run. | Unbounded revision cycles. |
| **ADR-09** | Each attempt carries an opaque lease token; only the active lease may commit. | Late results become `stale_ignored` and cannot change state. | Trusting arrival order. |
| **ADR-10** | Reuse `JsonStore` with a v1 → v2 additive migration. | Fastest safe path; supports one backend process. | A database, which the timeline did not justify. |
| **ADR-11** | Poll the detail endpoint every 1–2 seconds while a run is active. | Matches the existing client; no streaming transport needed. | SSE or WebSockets. |
| **ADR-12** | Interrupted runs fail with `SERVER_RESTARTED`; they do not auto-resume. | Avoids pretending an external invocation can be safely reconstructed. | Replaying the interrupted turn. |
| **ADR-13** | Agents in an active run are reserved. | Prevents concurrent lifecycle or thread changes. | Allowing an Agent in two runs. |
| **ADR-14** | Events carry bounded, redacted metadata; artifacts carry bounded content. | The timeline must not become a secret or raw-prompt dump. | Logging full prompts for debuggability. |

## Part 2 — Mini-RFCs

Recorded in `development/ASSUMPTIONS_AND_DECISIONS.md`, summarised here with
their effect on the shipped system.

### Contract-era

- **Artifact schema field limits.** Bounded every artifact field explicitly
  rather than relying on model restraint.
- **Workflow view includes committed turns.** The workflow re-derives from
  committed turns, so a retry never advances round-robin position.
- **Additive repository inputs for `truncated` and `outputDigest`.** Kept the
  repository interface additive rather than versioned.
- **Public attempts exclude the internal lease capability.** The read model is
  `Omit<CoordinationAttempt, "leaseToken">` — the lease is a capability, not
  data.
- **Remove redundant `PromptEnvelope.includedArtifactIds`.** Deleted a field
  that duplicated derivable state.
- **Free-chat completion signal.** Introduced advisory `done` — an Agent may
  signal, never decide.
- **Schedule decisions identify a repeated-role participant.** Disambiguated
  scheduling when one Agent holds a role twice.
- **Phase 5 exhaustiveness exception.** A recorded, scoped exception to the
  exhaustive-switch rule.

### Session v2 contract amendments (Phases 10–15)

Amended frozen contracts that the original design had listed as explicit
non-goals:

1. **Parallel fan-out turns** — previously an "explicit cut". Reversed.
2. **Countdown protocol removal** — previously "the headline acceptance demo".
   Deleted, along with the verified-handoff UI surface.
3. **Session termination semantics** — completion became an explicit user
   action rather than automatic at unanimous `done`.
4. **Participant range 2–6 → 2–10**, and `maxTurns` 3–12 → up to 100,000.
5. **Turn assignment by a planning artifact** — the middleware validates the
   plan's *shape* only.
6. **Reservation scope** — narrowed, so an idle session does not hold its
   Agents.

### Phase 11 — lifecycle reconciliation (approved, P11-02)

Classified every orchestration exit that did not make a terminal repository
call, and gave each one a required response. Closed the "stuck Agents" defect by
construction rather than by patching the six known cases.

### Phase 13 — parallel-wave state (approved, P13-01)

Replaced `activeTurnId` with `activeTurnIds`. A wave is scheduled atomically in
one mutation, so siblings cannot invalidate each other and a partial wave is
impossible. Per-turn settlement became independent. A verified-handoff run still
holds zero or one entry, asserted by test.

### Phase 14 — coordinator planning (approved, P14-03)

Added the `session_plan` artifact and made `coordinator` the default planning
mode. The coordinator proposes; the backend validates structure and schedules.
`done` is not consulted under coordinator planning. Removed the countdown
protocol and its rule that rejected `done` on a countdown message.

### Phase 15 — storage decision (approved, P15-04)

**Fix the data model; defer the engine swap.**

The evidence: measurement showed everything scaled quadratically, and the cause
was a single line — every scheduled turn stored `inputArtifactIds` for the whole
transcript, so turn *n* stored *n* ids. At 400 turns, 93% of the turn ledger was
id entries.

This is a **data-model** property. A repository swap would have moved those
bytes without removing them. Replacing the field with a single
`inputThroughSequence` bound made storage linear: at 2,000 turns the database
shrank 92%, a mutation got 13× faster, one prompt got 11.6× faster, and the hard
serialisation wall moved from ~4,426 to ~120,000 committed turns.

`JsonStore` is kept. `CoordinationRepository` remains the seam if the decision
is ever revisited — and the argument for revisiting it is now about performance,
not data loss.

**Recorded deviation:** the phase sheet asked that the 100,000 ceiling stay
available to callers who ask explicitly. The create route instead refuses more
than `maxSaveableSessionTurns` (50,000). A request that large was measured to be
unsaveable, and refusing a request is recoverable where losing a session is not.

## Part 3 — Decisions deliberately left open

- **The coordination engine choice.** An alternative auction/bidding model
  exists as a parallel design under
  `development/phases/parallel/`, implemented on a separate branch. It has not
  been adopted. `main` carries the wave-and-coordinator-planning model, and this
  documentation describes that model. If the alternative is ever adopted it must
  record its own mini-RFC first.
- **The delta read-path cost.** An idle delta poll returns ~1,620 bytes but
  costs ~355 ms of server time at 2,000 turns, because the route clones the
  whole database before filtering. Measured, recorded, not fixed.
- **First-open cost.** A 2,000-turn session ships 88 MiB to the browser on first
  render. A paginated or artifact-only first read would fix it.

## Related documents

- [Architecture](COORDINATION_ARCHITECTURE.md)
- [Protocol](COORDINATION_PROTOCOL.md)
- [API](COORDINATION_API.md)
- [Operations](COORDINATION_OPERATIONS.md)
