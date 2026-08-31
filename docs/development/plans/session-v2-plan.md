# Session v2 — Feasibility Assessment and Implementation Plan

**Status:** Draft for approval. No code has been written for this plan.
**Author:** Prepared 2026-08-30 against `main` @ `2344f2c` (Phases 0–8 complete, Phase 9 not started).
**Scope:** The nine change requests listed below, all of which target the `shared_session_v1` workflow and the web UI.
**Authority note:** This plan **amends frozen contracts**. It cannot be executed under the current documents as written — see [Contract amendments required](#3-contract-amendments-required-blocking).

---

## 1. Verdict at a glance

| # | Request | Feasible? | Size | Main obstacle |
|---|---|---|---|---|
| 1 | Agents stuck after session completion | Yes | S–M | Two distinct bugs plus one design conflict with request 6 |
| 2 | Remove verified handoff from the frontend | Yes | S | Web fixtures/tests reference it; server keeps the workflow |
| 3 | Remove countdown, keep free chat only | Yes | M | ~140 references, mostly tests; removes the headline demo until #9 lands |
| 4 | Up to 10 agents | Yes | S | Context budget and process concurrency, not the limit itself |
| 5 | Max turns up to 100,000 | Yes, with caveats | M–L | `JsonStore` rewrites the whole DB per mutation; read model returns everything |
| 6 | Long-lived multi-prompt sessions | Yes | L | New run status, user-message artifacts, loop resumption, reservation model |
| 7 | Relabel "Relay" → "Session" | Yes | S | Decide whether API paths and internal names move too |
| 8 | Parallel agents instead of round-robin | Yes | L | `run.activeTurnId` is a single pointer across the whole repository |
| 9 | Context-aware ordering/assignment | Yes | L | Needs a typed planning turn to stay inside the trust boundary |

Everything asked for is achievable on the existing engine. Nothing requires replacing the architecture. The two structural items are #6 (session lifecycle) and #8 (single active turn → wave of active turns); #9 rides on top of #8 and replaces what #3 removes.

---

## 2. What the code does today (established facts)

These are the specific mechanisms each request has to move.

**Run lifecycle.** [`CoordinationRun.status`](../../../apps/server/src/coordination/types.ts) is `created | running | stop_requested | completed | failed | stopped`. Terminal states are immutable — [`repository.ts:614`](../../../apps/server/src/coordination/repository.ts#L614) refuses to re-open a terminal run. There is no "alive but idle" state.

**One active turn.** [`CoordinationRun.activeTurnId`](../../../apps/server/src/coordination/types.ts) is a single optional pointer. `scheduleTurn` refuses to schedule while it is set ([`repository.ts:465`](../../../apps/server/src/coordination/repository.ts#L465)), and `commitAcceptedArtifact`, `finishAttempt`, `settleActiveWork`, and `finishStopped` all read and clear it. 34 references across the tree.

**Orchestration is a strictly sequential `while` loop.** [`CoordinationService.runLoop`](../../../apps/server/src/coordination/service.ts) decides, schedules one turn, awaits `executeTurnWithRetries`, repeats. `WorkflowDecision` is `schedule | complete | fail` ([`contracts.ts`](../../../apps/server/src/coordination/contracts.ts)).

**Turn selection is pure round-robin.** `participants[committedArtifacts.length % participants.length]` in [`session-workflow.ts`](../../../apps/server/src/coordination/session-workflow.ts). The workflow also re-validates the entire committed history on every decision, which is why any change to turn shape ripples into `validateSessionView`.

**Reservations are derived, not stored.** An agent is reserved while it appears in a run whose status is `running` or `stop_requested` ([`repository.ts:133`](../../../apps/server/src/coordination/repository.ts#L133), mirrored in [`agent-service.ts`](../../../apps/server/src/agent-service.ts)). Reservation blocks Playground use, edit, delete, start/stop of that agent.

**Start requires every participant to be `ready`.** [`repository.ts:206`](../../../apps/server/src/coordination/repository.ts#L206) returns `AGENT_NOT_READY` if any participant's agent status is not exactly `ready`; a failed Codex run leaves the agent in `error` ([`agent-service.ts`](../../../apps/server/src/agent-service.ts), `executeRun` catch branch).

**Storage.** [`JsonStore.mutate`](../../../apps/server/src/store.ts) deep-clones the entire database, runs the mutation, serialises the whole document to JSON, writes a temp file and renames — **on every single mutation**. One committed turn costs roughly four such whole-file writes (schedule, begin attempt, commit, plus events inside them).

**Read model.** `GET /api/coordination-runs/:id` returns every turn, attempt, artifact, and event for the run, unpaginated ([`routes.ts`](../../../apps/server/src/coordination/routes.ts)), and the UI polls it every 1.5s while active ([`RelayWorkspace.tsx`](../../../apps/web/src/RelayWorkspace.tsx)).

**Prompting.** [`RoleScopedContextBuilder`](../../../apps/server/src/coordination/context-builder.ts) renders the full transcript as `Name: content` lines, with a fixed truncation ladder against `policy.contextMaxChars` (default 12,000). Session turn instructions are hard-coded per protocol.

**There is no user-message concept anywhere.** Artifacts are always produced by an agent turn and always carry `turnId`, `createdByRole`, `createdByAgentId`.

---

## 3. Contract amendments required (blocking)

[`docs/development/README.md`](../README.md) forbids silently editing frozen contracts, and [`overview-sessions.md`](../overview-sessions.md) Section 2 explicitly lists as non-goals the exact things requests 8 and 9 ask for. Before any code, record a mini-RFC in [`ASSUMPTIONS_AND_DECISIONS.md`](../ASSUMPTIONS_AND_DECISIONS.md) and amend `overview-sessions.md` for:

1. **Parallel fan-out turns** — currently "explicit cut" (Section 2 non-goals). Request 8 reverses it.
2. **Countdown protocol removal** — currently "the headline acceptance demo" (Sections 1, 2, 6.1). Request 3 deletes it.
3. **Session termination semantics** — currently a session completes at unanimous `done`, `maxTurns`, or stop (Section 6.5). Request 6 makes completion an explicit user action.
4. **Participant range 2..6 → 2..10** and **`maxTurns` 3..12 → up to 100,000** (Sections 4, 7).
5. **Turn assignment by a planning artifact** — new; the middleware still never judges substance, it only validates the plan's *shape* (see D3).
6. **Reservation scope** (see D5) — the derived-reservation rule in `overview.md` Section 10.4 changes meaning once sessions outlive their active work.

Also update the Phase 9 sheet: releasing today's feature set no longer matches the product. Recommendation: **defer Phase 9 until after this plan**, and re-run it as the final phase.

---

## 4. Design decisions

Each decision states the recommendation and the alternative that was rejected.

### D1 — Sessions become long-lived: add an `awaiting_input` status
Add `awaiting_input` to `CoordinationRunStatus`: non-terminal, no active turn, no running loop. The workflow returns a new decision `{ kind: "await_input" }` instead of `complete` when the current wave is exhausted. A session becomes terminal only on explicit **End session** (→ `completed`), **Stop** (→ `stopped`), failure, or the hard `maxTurns` ceiling.

Consequence: `interruptActiveRuns` on boot should settle only `running`/`stop_requested` runs and **leave `awaiting_input` sessions alive** — a session with no in-flight work survives a restart, which is exactly the Codex/Claude Code behaviour requested.

*Rejected:* creating a new run per prompt and chaining them. It loses one transcript, one evidence ledger, and one participant set — the whole point of a session.

### D2 — User prompts become a first-class artifact
Add artifact type `user_message` with payload `{ schemaVersion: 1, type: "user_message", content: string }`, bounded like a session message but larger (recommend 4,000 chars).

- Widen `CoordinationRole` with `"user"`, or (preferred) make the artifact variant carry `createdBy: { kind: "user" }` while agent artifacts keep `createdByRole`/`createdByAgentId`. The union is already discriminated, so this is additive.
- `turnId` becomes optional **on this variant only** — a user message is not a turn.
- Add `transcriptSequence: number` to session artifacts so ordering is deterministic without relying on `createdAt` ties.

The context builder's session branch renders `User: <content>` inline with agent lines, in transcript order. `ROLE_VISIBILITY.session_turn` widens to `["session_message", "user_message"]`.

*Rejected:* a separate `coordinationUserMessages` collection. It would force every consumer (workflow view, context builder, transcript UI, read model) to merge two ordered lists.

### D3 — Ordering and parallelism come from a validated plan artifact
Add turn kind `session_plan` and artifact type `session_plan`:

```jsonc
{ "schemaVersion": 1, "type": "session_plan",
  "mode": "parallel" | "sequential",
  "assignments": [ { "agentId": "<participant id>", "position": 1, "instruction": "<= 500 chars" } ] }
```

After each user prompt the backend schedules **one coordinator turn** (by default the first participant; configurable) whose prompt contains the roster, the transcript, and the new user message. The backend then validates the plan mechanically — agent IDs must be participants, distinct, positions contiguous from 1, assignment count ≤ participant count, instruction bounded — and executes it: `parallel` fans out one wave, `sequential` schedules assignments in position order. An invalid plan is rejected through the existing retry path, exactly like a wrong countdown number today.

This keeps the trust boundary intact: the agent proposes, the backend validates shape and owns all scheduling, leases, limits, and cancellation. It answers request 9 ("count down from 10" → a sequential plan with explicit per-agent numbers) and it is what replaces the countdown protocol deleted in request 3.

Policy escape hatch: `sessionPlanning: "coordinator" | "round_robin"` (default `coordinator`), so a session can fall back to today's deterministic behaviour if the model plans badly during a demo.

*Rejected:* backend heuristics that parse the user's prompt for ordering intent (fragile, and it puts the middleware in the business of judging content); and letting each agent self-assign from the transcript (no mechanism prevents two agents claiming the same slot).

### D4 — Parallelism: `activeTurnId` → `activeTurnIds`
Replace the single pointer with `activeTurnIds: CoordinationTurnId[]` (keep `activeTurnId` as a derived read-only alias during migration if it reduces churn in the verified-handoff tests).

- New repository command `scheduleTurns(turns[])` schedules an entire wave in **one** `store.mutate`, so the optimistic `expectedRunVersion` check is taken once rather than racing per turn.
- `commitAcceptedArtifact` / `finishAttempt` / `settleActiveWork` remove only their own turn from the set; the run stays schedulable while siblings are in flight.
- `CoordinationService` gains a wave supervisor: start N attempt pipelines, `await Promise.allSettled`, then re-decide. Per-turn retry logic is unchanged.
- New policy `maxParallelTurns` (default `min(participants, 4)`, ceiling 10) enforced by a semaphore — each parallel turn is a live Codex process.

Verified handoff keeps returning single-turn waves, so its semantics do not change.

### D5 — Reservation scope must narrow (this is also half of request 1)
Today, being in a `running` run reserves an agent. Once sessions live for hours (D1), whole-run reservation means the agents are unusable for their entire life — the "stuck agents" complaint, made permanent by design.

**Recommendation:** reserve an agent while it has a **running attempt** in a non-terminal run, plus a soft, visible "in session" marker in the UI. Playground use of an idle session participant is then allowed; a mid-wave scheduling attempt on a busy agent already fails cleanly via `startExecution`'s `busy` check and can be retried by the supervisor.

**Alternative if you want stricter isolation:** keep whole-run reservation but require an explicit **End session** to release, and surface that button prominently. This is safer but makes agents feel locked.

This one genuinely changes product behaviour — flagged as an open question in §7.

### D6 — Limits, context, and the read model
- `SESSION_LIMITS.maxParticipants` 6 → 10; mirrored in `routes.ts` (`.max(6)`), `service.createSessionRun`, `session-workflow.validateSessionView`, and the web form.
- `maxTurns` ceiling 12 → 100,000 in `routes.ts`, `service.validatePolicy`, and the UI. Keep a much lower **default** (recommend 200) so an accidental runaway is bounded.
- `contextMaxChars` must rise with 10 participants and long transcripts (recommend default 40,000, configurable) **and** the session context branch should window the transcript: always include the most recent K messages plus the active user prompt, and summarise or drop older ones rather than uniformly truncating everything. The existing truncation ladder degrades every message equally, which is the wrong shape for a chat.
- `GET /:id` gains `?sinceSequence=` (events/turns/artifacts after a cursor); the UI keeps a local transcript and appends deltas instead of refetching the whole run every 1.5s.

### D7 — Storage is the real ceiling on request 5
At 100,000 turns the JSON store is the binding constraint, not the type limits: every mutation serialises the entire database. A 10,000-message session is already tens of MB rewritten several times per turn.

Staged answer:
1. **Now:** raise the limits, keep `JsonStore`, and document a *practical* recommended ceiling (a few thousand turns per session) plus the delta read model from D6.
2. **If long sessions are actually exercised:** move the five coordination collections to per-run append-only JSONL, or to SQLite (`better-sqlite3`), behind the existing `CoordinationRepository` interface — which is exactly the seam that makes this swappable. Budget this as its own phase; it is not required for the other eight requests.

---

## 5. Request-by-request analysis

### R1 — Agents stuck after session completion
Three separate causes; fix all three.

**(a) The loop can exit without settling the run.** `runLoop` returns whenever `executeTurnWithRetries` returns `false`, and several of those paths are non-terminal: `beginAttempt` returned `stale`, the turn was no longer `scheduled`, `attachAgentRun` returned `stale`, or `commitAcceptedArtifact` returned `stale`. In each case the loop stops while `run.status` is still `running` — so the run never becomes terminal, and its participants stay reserved **forever**. Recoverable today only by pressing Stop (if the user realises) or restarting the server.
*Fix:* on loop exit, reload the run; if it is still `running` with no active turn and no live loop, either resume the loop (preferred) or fail it with a specific code (`INTERNAL_ERROR` / new `RUN_ABANDONED`). Add a startup and periodic reconciler that settles runs with no owning loop.

**(b) A failed Codex run leaves the agent in `error`.** `startRun` demands `ready` for every participant, so one bad run blocks all future sessions with that agent. `POST /api/agents/:id/start` already resets to `ready`; the UI needs to surface that clearly as a "Reset agent" affordance next to `lastError`.

**(c) Whole-run reservation** — see D5. This becomes the dominant cause once sessions are long-lived, so R1 must be fixed *before* R6 ships.

### R2 — Remove verified handoff from the frontend
Frontend-only removal. Delete the workflow toggle, role selects, required-sections editor, `maxRevisions`, `ArtifactCard`, and the verified branches of `validateForm` in [`RelayWorkspace.tsx`](../../../apps/web/src/RelayWorkspace.tsx) (~8 references), trim [`coordination-types.ts`](../../../apps/web/src/coordination-types.ts), and rewrite the verified fixtures in [`coordination-fixtures.ts`](../../../apps/web/src/testing/coordination-fixtures.ts) and the 7 verified cases in [`RelayWorkspace.test.tsx`](../../../apps/web/src/RelayWorkspace.test.tsx). The server keeps `verified_handoff_v1` intact, so all 474 server tests stay green and old runs still render. Historical verified runs in the run list should be shown read-only rather than hidden, or filtered out — pick one (§7).

### R3 — Remove countdown, keep free chat
~140 references across 20 files, ~85% of them tests and fixtures. Touches `types.ts` (`SessionProtocol`, `sharedState`, `sessionStartValue`, `SESSION_LIMITS`), `routes.ts`, `service.createSessionRun`, `session-workflow.ts`, `artifact-protocol.ts`, `repository.nextCountdownValue`, `context-builder.taskInstruction`, plus web form/state display.

**Sequencing matters:** deleting countdown removes the one demo that proves ordered coordination, and the replacement (D3 planning) does not exist until Phase 14. So: **hide countdown from the UI in Phase 10, delete the backend branch in Phase 14** once the coordinator demonstrably reproduces "count down from 10 to 1" through free chat. That keeps a working demo at every commit.

### R4 — Up to 10 agents
Mechanically trivial (D6). The real work is downstream: 10 concurrent Codex processes (D4's semaphore) and a transcript that grows 10× faster per round (D6 windowing). No blockers.

### R5 — Max turns 100,000
Type/validation changes are trivial; see D7 for the honest limitation. Also raise `maxAttemptsPerTurn` if desired (currently 2, hard-coded in `DEFAULT_COORDINATION_POLICY`) and confirm `nextTurnSequence` and event sequence numbers have no implicit bounds — they do not.

### R6 — Multi-prompt sessions
Composed of D1 + D2 plus:
- `POST /api/coordination-runs/:id/messages` — appends a `user_message` artifact, transitions `awaiting_input` → `running`, and restarts the loop. Must be idempotent-safe under double-submit (client message id or version check).
- `startRun` is no longer the only entry into the loop; extract a `resumeRun(id)` path that shares the same guard as `startRun` (`activeLoops` map already prevents double loops).
- Stop semantics: Stop must cancel the current wave and return to `awaiting_input`, **not** kill the session. Add a separate **End session** action for the terminal transition.
- UI: replace create-then-start-then-watch with a chat surface — message list, composer, "agents are working" indicator, Stop/End controls, and delta polling (D6).

### R7 — Relabel "Relay" → "Session"
User-visible strings, nav item, hero, empty states, CSS class prefixes (68 `relay-*` rules), and the component/file rename `RelayWorkspace.tsx` → `SessionWorkspace.tsx` + its test. **Recommendation: leave `/api/coordination-runs` and the server-side `coordination*` names alone** — renaming them churns ~1,100 lines of API tests for no user-visible gain. Note the product-name decision in `ASSUMPTIONS_AND_DECISIONS.md`, and sweep `README.md`, `STATUS.md`, and `docs/development/*` in the release phase.

### R8 — Parallel agents
See D4. This is the largest single refactor: 34 `activeTurnId` references, the repository's race tests ([`repository.test.ts`](../../../apps/server/src/coordination/repository.test.ts), 1,466 lines), and the workflow's `validateSessionView`, which currently asserts strict round-robin routing against sequence order and will reject any parallel history until rewritten.

New tests required: two turns committing concurrently, one committing while a sibling times out, stop during a wave (all siblings cancelled), restart mid-wave, and a wave whose agent is busy from the Playground.

### R9 — Context-aware ordering
See D3. Depends on R8 for the `parallel` branch and on R6 for having a user prompt to plan against. `sequential` mode alone already delivers the countdown example, so R9 can ship in two steps if time is short.

---

## 6. Phased plan

Continues the repository's numbering. Each phase = one task branch, tasks tracked in `STATUS.md`, and the standard Docker Compose `npm run check` gate from [`docs/development/README.md`](../README.md) before any task is marked complete.

Each phase has a full instruction sheet in the phases folder, written to the same standard as Phases 0–9. The tables below are the summary; the sheet is the authority for its phase.

| Phase | Sheet | Requests covered |
|---:|---|---|
| 10 | [`phases/10-session-v2-surface.md`](../phases/10-session-v2-surface.md) | R2, R3 (UI), R4, R5 (limits), R7 |
| 11 | [`phases/11-lifecycle-reconciliation.md`](../phases/11-lifecycle-reconciliation.md) | R1 |
| 12 | [`phases/12-durable-multi-prompt-sessions.md`](../phases/12-durable-multi-prompt-sessions.md) | R6 |
| 13 | [`phases/13-parallel-waves.md`](../phases/13-parallel-waves.md) | R8 |
| 14 | [`phases/14-coordinator-planning.md`](../phases/14-coordinator-planning.md) | R9, R3 (backend deletion) |
| 15 | [`phases/15-scale-and-release.md`](../phases/15-scale-and-release.md) | R5 (scale truth), release |

### Phase 10 — Contract amendment, UI simplification, limit raise
*Delivers R2, R7, R4, R5 (limits), R3 (UI half). Low risk, immediately visible.*

| Task | Description |
|---|---|
| P10-01 | Mini-RFC in `ASSUMPTIONS_AND_DECISIONS.md`; amend `overview-sessions.md` Sections 1, 2, 4, 6, 7 per §3 |
| P10-02 | Raise `SESSION_LIMITS.maxParticipants` to 10 and `maxTurns` ceiling to 100,000 (types, `routes.ts`, `service.ts`, `session-workflow.ts`); keep conservative defaults |
| P10-03 | Raise `contextMaxChars` default and add a session transcript window (most recent K + user prompt) in `context-builder.ts` |
| P10-04 | Remove the verified-handoff surface from the web app; keep server workflow intact; decide list treatment of legacy runs |
| P10-05 | Remove the countdown option from the web app; free chat becomes the only creatable protocol (backend branch stays) |
| P10-06 | Rename Relay → Session in all user-visible strings, CSS prefixes, and component/file names |
| P10-07 | Update web fixtures/tests for the reduced surface; add 10-participant and high-`maxTurns` cases |

**Gate:** full check passes; a 10-agent free-chat session runs end to end in the Compose browser deployment.

### Phase 11 — Lifecycle reconciliation (R1)
| Task | Description |
|---|---|
| P11-01 | Settle-on-exit: `runLoop` reconciles a still-`running` run when the loop ends without a terminal decision |
| P11-02 | Startup + periodic reconciler for runs with no owning loop |
| P11-03 | Regression tests for each stale path (begin/attach/commit stale, turn no longer scheduled) proving the run always reaches a terminal or resumable state |
| P11-04 | Narrow reservations per D5 (pending the §7 decision); update `agent-service.ts`, `repository.getReservingRunId`, and their tests |
| P11-05 | UI: agent `error` recovery affordance, and a clear "reserved by session X" message with a link to that session |

**Gate:** no sequence of stop/restart/failure leaves an agent unusable; proven by test, not by inspection.

### Phase 12 — Durable multi-prompt sessions (R6)
| Task | Description |
|---|---|
| P12-01 | `awaiting_input` status + `await_input` workflow decision; `interruptActiveRuns` leaves idle sessions alive |
| P12-02 | `user_message` artifact variant, `transcriptSequence`, schema, redaction, and event types |
| P12-03 | Repository `appendUserMessage` (single atomic mutation, version-checked) |
| P12-04 | `POST /api/coordination-runs/:id/messages` + `resumeRun`; double-submit safety |
| P12-05 | Stop returns to `awaiting_input`; new **End session** action for the terminal transition |
| P12-06 | Delta read model (`?sinceSequence=`) and incremental client transcript |
| P12-07 | Chat UI: message list, composer, working indicator, Stop / End session |
| P12-08 | Tests: prompt → wave → idle → prompt again; restart while idle; stop mid-wave then resume; commit racing an incoming prompt |

**Gate:** a real session accepts three consecutive prompts, survives a server restart while idle, and the transcript is intact.

### Phase 13 — Parallel waves (R8)
| Task | Description |
|---|---|
| P13-01 | `activeTurnIds` migration across types, repository, workflow validation, and fixtures |
| P13-02 | `scheduleTurns` batch command (one mutation per wave) |
| P13-03 | Wave supervisor in `CoordinationService`; per-turn retry unchanged |
| P13-04 | `maxParallelTurns` policy + semaphore; busy-agent backoff |
| P13-05 | Race tests: concurrent commits, sibling timeout, stop mid-wave, restart mid-wave, Playground contention |

**Gate:** a 6-agent parallel wave completes with correct evidence and no lease violations; verified handoff regression still passes.

### Phase 14 — Coordinator planning and ordered assignment (R9), countdown deletion (R3 backend)
| Task | Description |
|---|---|
| P14-01 | `session_plan` turn kind, artifact type, schema, and mechanical validator (D3) |
| P14-02 | Coordinator turn scheduling after each user prompt; `sessionPlanning` policy with `round_robin` fallback |
| P14-03 | Plan execution: `sequential` in position order, `parallel` as one wave |
| P14-04 | Invalid-plan retry evidence, mirroring the wrong-number rejection pattern |
| P14-05 | Delete the countdown protocol from the backend, now that ordered coordination is demonstrated by plans |
| P14-06 | Live rehearsal: "count down from 10" with 10 agents produces correct order via a sequential plan; a parallel prompt fans out |

**Gate:** the ordering demo works through agent coordination rather than a hard-coded validator.

### Phase 15 — Scale and release (R5 tail, re-run of Phase 9)
| Task | Description |
|---|---|
| P15-01 | Long-session soak: measure store latency and file growth at 500 / 2,000 / 10,000 turns; record real numbers |
| P15-02 | Decide and, if warranted, implement the storage swap behind `CoordinationRepository` (JSONL or SQLite) |
| P15-03 | Documentation sweep: README, architecture/protocol/API/operations docs, naming, honest limits |
| P15-04 | Re-run the Phase 9 release checklist against the new feature set |

---

## 7. Open questions (need your decision)

1. **Reservation model (D5).** Free idle participants for Playground use, or keep them locked until End session? This changes how "stuck" feels day to day.
2. **Legacy verified-handoff runs in the UI (R2).** Hide them entirely, or list them read-only?
3. **Coordinator identity (D3).** First participant doubles as coordinator, a dedicated 11th "coordinator" agent, or a direct model call with no agent attached?
4. **API/product naming (R7).** Rename `/api/coordination-runs` → `/api/sessions` (breaking, ~1,100 lines of test churn), or keep the path and rename only the product surface?
5. **`maxTurns` default.** 100,000 is the ceiling; what should the default be? (Recommendation: 200.)
6. **Phase 9.** Confirm it is deferred to the end rather than run against the current feature set.

---

## 8. Cut order if time is short

Cut from the bottom: storage swap (P15-02) → `parallel` plan mode (keep `sequential`) → delta read model (keep full polling) → 10-agent support (keep 6) → parallel waves entirely (keep round-robin, keep multi-prompt).

Never cut: the lifecycle reconciliation of Phase 11, lease and version enforcement, the plan validator's mechanical checks, stop/cancel, or the durable evidence ledger. Those are what make the middleware trustworthy rather than a prompt chain.
