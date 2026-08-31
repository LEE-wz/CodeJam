# Relay Assumptions and Resolved Questions

**Last audited:** 2026-08-30  
**Current implementation base:** `139019b` (`main` after the Phase 4 merge; tag `phase-4-complete`)
**Accepted contract commit:** immutable reference `ea469b2` (optional `relay/contracts-v1` tag is absent)
**Contract authority:** Sections 4 and 6–11 of [`overview.md`](./overview.md) for the verified workflow; [`overview-sessions.md`](./overview-sessions.md) for the shared-session workflow (Phases 5–9)

This file closes questions that can be answered from the checked-out code and isolates the few items that require measurement or a team contract change.

## Checkpoint 7 clarification

**Recorded:** 2026-08-30 for P7-07. The Phase 7 sheet says both to preserve
coordination initialisation "exactly as today" and to keep a "scripted runtime
only." These phrases conflict after the completed Phase 3 production root,
which already uses `AgentServiceCoordinationRuntime`. P7-07 therefore preserves
that existing Phase 3 wiring and adds only session workflow/protocol dispatch;
the Phase 7 test matrix uses `ScriptedCoordinationRuntime`, and Phase 7 adds no
new real-Agent or provider connection. This is a clarification of the existing
P7-07 boundary, not a contract or runtime-seam change.

## Resolved Sprint 0 questions

| Question | Answer | Consequence |
|---|---|---|
| Does `AgentService` expose completion as a promise? | At the Sprint 0 baseline, no. Phase 3 now exposes internal `startExecution()` returning `AgentExecutionHandle`; public `sendMessage()` remains the compatibility wrapper. | Relay uses the handle and `cancelRun(agentRunId)` without bypassing AgentService. |
| Does `JsonStore` have a migration hook? | The Sprint 0 baseline did not. Phase 2 added explicit `DatabaseV1` parsing and additive v1→v2 migration; new databases are v2 and future/invalid versions are rejected before writes. | Preserve the additive migration and unknown-field retention behavior. |
| Where are route modules registered? | `createApp(config, service, coordination?)` conditionally registers Relay routes. `index.ts` now constructs the durable repository, workflow, protocol, context builder, AgentService runtime, and coordination service after `AgentService` initialization. | Preserve this composition seam and keep server internals out of the Phase 4 web client. |
| Which spelling is canonical? | Code and API values use `finalizer`. | Use “Finaliser” in user-facing copy to match the product narrative, but never use it as a stored enum or API value. Tests should assert `finalizer` in code. |
| How should stopping a terminal run behave? | The service returns the terminal run and the route returns `202` with `accepted: true`. | Stop is idempotent for MVP. Route tests cover completed, failed, and stopped runs; changing this now requires a mini-RFC. |

## Measured later, not open design questions

| Item | How it is resolved | Required evidence |
|---|---|---|
| Real model latency | Measured over three fresh real workflows: 12.919–59.585s per turn and 56.905–108.157s total. | The 120s attempt timeout is practical and remains unchanged. |
| Schema compliance of real output | Three real proposal/approve/final paths each committed on their first attempt. Validators remained authoritative. | Phase 3 real-provider gate passed with only redacted status/timing evidence recorded. |
| Old thread contamination | Every rehearsal used three newly created disposable Agents. | Each role began without a thread; the resulting thread ID persisted in its Agent record. |

## Resolved contract deviations

### Mini-RFC: artifact schema field limits

**Status:** Approved by the user on 2026-08-29 for P1-05.

**Current contract and blocker:** The frozen artifact contract requires strict
Zod schemas with bounded strings and arrays but does not assign numeric limits.
P1-05 cannot provide stable boundary behavior or tests without those values.

**Approved change:** Proposal/review section keys and review issue codes are
limited to 64 characters; section keys use the existing required-section slug
format. Section and final titles are limited to 120 characters, proposal
summaries to 1,000, section content to 6,000, issue messages to 1,000, review
feedback to 2,000, and final content to 16,000. Proposal sections contain 1–20
items and review issues 0–20 items. Every textual field is trimmed and non-empty.
All objects are strict. The separate raw `outputMaxChars` check remains P1-06.

**Affected files/workstreams:** Artifact schemas and tests, protocol parsing,
prompt output-contract documentation, and future API/UI artifact fixtures. There
is no persistence-shape change because the TypeScript payload fields are
unchanged.

**Required evidence:** Each valid fixture parses; exact string/array boundaries
are accepted; one-over boundaries, empty strings, invalid section-key slugs, and
unknown root/nested fields are rejected. Decision consistency and proposal
coverage remain P1-07 cross-field rules.

### Mini-RFC: workflow view includes committed turns

**Status:** Approved by the user on 2026-08-29 for P1-01.

**Current contract and blocker:** The frozen `WorkflowView` contains a run and
its artifacts, while P1-01 requires latest-artifact selectors to order artifacts
by committed turn sequence. An artifact contains only `turnId`; artifact array
order and timestamps are not ordering contracts, so the required selector cannot
be implemented from the frozen view without guessing.

**Approved change:** Add `turns: CoordinationTurn[]` to `WorkflowView`. The
workflow receives the turns already loaded in `CoordinationRunDetails` and uses
them only as immutable input. A candidate artifact is committed only when its
same-run turn has `status: "committed"` and `outputArtifactId` equal to the
artifact ID. Latest selection compares `turn.sequence`, never timestamps or
array position.

**Affected files/workstreams:** The overview and TypeScript workflow contract,
the coordination service call site, pure workflow selectors, and their tests.
There is no persisted-schema or HTTP API change. Phase 2 repositories must not
rely on artifact array ordering.

**Required evidence:** Focused pure selector tests cover shuffled input,
misleading timestamps, artifact type filtering, and exclusion of uncommitted,
mismatched, and cross-run records. The full Docker Compose `npm run check` must
pass.

### Phase 1 implementation decisions (confirmed)

**Status:** Recorded on 2026-08-29 for P1-06 to P1-17. **Confirmed unchanged by
the user on 2026-08-30 at the Phase 2 sign-off, before P2-01.** Each sits where
the frozen contract is silent. None changes a frozen type, route, or persisted
shape, so none required a mini-RFC. `sizeChars` was the one that becomes
expensive to change once Phase 2 persists artifacts; it is settled below and in
the Phase 2 handoff decision table.

| Decision | Choice made | Why | Reversal cost |
|---|---|---|---|
| `CoordinationArtifact.sizeChars` | Length of the raw Agent output that was measured against `outputMaxChars` | Only the parsed payload is stored, so this is the sole surviving record of how large the model's response was | Cheap now; a stored-field meaning change after Phase 2 |
| Retry feedback bounds | At most 10 messages, each at most 500 characters | Overview Section 11.3 requires concise feedback but assigns no numbers; the context cap still applies on top | Cheap, prompt-only |
| Context truncation | Fixed descending ladder of per-field caps (6000, 3000, 1500, 750, 400, 200), lowest rung then fails | A fixed ladder keeps the chosen cap, prompt, and digest reproducible; a search would not | Cheap, prompt-only |
| Truncatable fields | Proposal summary and section content, review feedback and issue messages, final content only | Section keys and titles stay intact so a truncated proposal still shows the coverage it claims (Section 11.6 forbids silently removing required section content) | Cheap, prompt-only |
| Artifact identifiers in prompts | Withheld; only payloads are serialised | The output contract forbids emitting IDs, so an Agent is never shown one it could echo back as forged provenance; the authoritative evidence is `CoordinationTurn.inputArtifactIds` | Cheap, prompt-only |
| Retry feedback placement | Appended inside `[YOUR TASK]`, not as a fifth envelope section | Keeps the Section 11.5 envelope literally four sections while satisfying Section 11.3 | Cheap, prompt-only |
| Required section key normalisation | Trimmed and lower-cased before the duplicate check, then rejected unless it matches the frozen slug format | Section 25.1 requires normalising to the documented slug format and rejecting duplicates; without this a run could be created that no Agent output could ever satisfy | Cheap; changes accepted create inputs |
| Create-time context check | `createRun` builds a probe prompt with the real context builder and rejects the run if it cannot fit | Section 11.6 requires failing creation when the objective and sections alone do not fit; using the real builder means creation cannot succeed for a run whose first prompt is impossible | Cheap |
| Cross-field rules for final artifacts | Non-empty final title and content are left to the bounded schema and asserted by test rather than re-checked in the cross-field step | The trimmed schema already guarantees it; a second check would be dead code | Cheap |

Two related gaps are deliberately left to their own phases rather than solved
here:

- A stale commit cannot record `attempt.stale_ignored`, because events are
  Phase 2 (P2-05) and `finishAttempt` does not accept that status. The late
  result is still refused; only its evidence row is missing.
- `CoordinationTurn.lastValidationErrors` records validator messages only. A
  runtime timeout or failure surfaces through the attempt's `errorCode` and
  `errorMessage` and through the failed run's message, not through that field.

### Mini-RFC: additive repository inputs for `truncated` and `outputDigest`

**Status:** Recorded on 2026-08-30 during P2-09/P2-11 and **approved by the
user on 2026-08-30** when authorising the Phase 2 fixes and Phase 3 work.

**Current contract and blocker:** The confirmed handoff decisions require the
repository to emit `truncated` on the `attempt.started` event (§1.2) and to
write `attempt.outputDigest` at commit (§1.3). Neither value can reach the
repository: the frozen `BeginAttemptInput` is `{ runId, turnId, attempt }` and
`CoordinationAttempt` has no `truncated` field, and the frozen
`CommitAcceptedArtifactInput` is `{ runId, turnId, attemptId, leaseToken,
artifact }` with no digest of the raw output. Both values exist in
`CoordinationService`, which holds the `PromptEnvelope` and the raw output.

**Proposed change:** Two optional input fields, nothing else.

- `BeginAttemptInput.truncated?: boolean | undefined`
- `CommitAcceptedArtifactInput.outputDigest?: string | undefined`

No frozen domain type, event type, route, or persisted shape changes.
`CoordinationAttempt.outputDigest` already exists and merely gains a producer.
Both fields are optional, so every existing caller and the Phase 1 fixtures
compile unchanged.

**Affected files/workstreams:** `coordination/contracts.ts`,
`coordination/repository.ts`, `coordination/service.ts` at the two call sites,
and the repository tests. `testing/memory-repository.ts` ignores both fields and
so is unchanged, preserving the frozen Phase 1 fixture behaviour.

**Required evidence:** `attempt.started` carries `truncated` for a truncated
prompt and for an untruncated one; a committed attempt records the supplied
`outputDigest`; omitting either field leaves the attempt and event exactly as
before. The full Docker Compose `npm run check` must pass.

**Alternative rejected:** deriving the digest inside the repository from the
stored payload. That would silently redefine `outputDigest` as a payload digest,
contradicting decision §1.3 and mirroring the `sizeChars` ambiguity the handoff
was written to close.

### Phase 2 handoff decisions

**Status:** Decided by the user on 2026-08-30, before P2-01, in answer to the
four open items in [`PHASE_2_HANDOFF.md`](./PHASE_2_HANDOFF.md) sections 1 and
2.1. None of the four requires a mini-RFC: no frozen type, route, or field is
added, removed, or changed by any of them.

| Handoff item | Decision | Consequence for Phase 2 |
|---|---|---|
| §1.1 `CoordinationArtifact.sizeChars` | **Length of the raw Agent output measured against `outputMaxChars`** — Phase 1 behaviour is confirmed, not changed | `DatabaseV2` stores the raw-output length. Only the parsed payload is persisted, so this remains the sole surviving record of the model response size. No Phase 1 code or test changes. |
| §1.2 `truncated` context flag | **Event detail only.** P2-05 emits `truncated` in the `attempt.started` event details | Satisfies overview Section 11.6 ("attempt metadata **or** event details") with no contract change and no persisted attempt field. `CoordinationAttempt` gains no `truncated` field, so `DatabaseV2` is unaffected. Phase 4's timeline is the consumer. |
| §1.3 `attempt.outputDigest` | **Populate it.** The digest of the raw Agent output is written when an attempt settles with output, in P2-09/P2-11 | The frozen field keeps a producer and `DatabaseV2` gets no permanently-null column. It mirrors the existing `promptDigest` and gives attempt→output evidence without persisting raw output. |
| §2.1 `attempt.stale_ignored` | **Event only.** The repository appends an `attempt.stale_ignored` event referencing the refused attempt; the attempt row keeps the status it settled as | The frozen `FinishAttemptInput.status` union is not extended, so a caller that lost its lease never writes to an attempt it does not hold. Accepted cost: the `stale_ignored` member of `CoordinationAttemptStatus` stays unwritten, and Phase 4 reads the evidence from the event stream. |

### Mini-RFC: public attempts exclude the internal lease capability

**Status:** Approved by the user on 2026-08-30 as part of the Phase 2 fixes.

**Current contract and blocker:** `CoordinationAttempt.leaseToken` is required
internally for atomic commit ownership, while the original
`GetCoordinationRunResponse extends CoordinationRunDetails` exposed that field
to every authenticated HTTP client. No HTTP route consumes it, but Phase 4
would otherwise copy the capability into browser state.

**Change:** Keep `CoordinationRunDetails` and the durable attempt unchanged for
repository/service use. Define `CoordinationAttemptResponse` as the attempt
without `leaseToken`, override `attempts` in `GetCoordinationRunResponse`, and
strip the field at the route boundary. Tests assert no detail attempt owns a
`leaseToken` property. No database migration is required.

### Mini-RFC: remove redundant `PromptEnvelope.includedArtifactIds`

**Status:** Approved by the user on 2026-08-30 as part of the Phase 2 fixes.

**Current contract and blocker:** The context builder returned
`includedArtifactIds`, but the service deliberately dropped it. The persisted
turn already carries the workflow-selected `inputArtifactIds`, and prompt tests
directly verify the stricter role visibility filter. Keeping a second unused
array suggested authority it did not have.

**Change:** Remove `includedArtifactIds` from `PromptEnvelope`. Keep
`CoordinationTurn.inputArtifactIds` as the durable evidence and retain the
prompt-content visibility/leakage tests. This changes no route or stored shape.

### Extra events endpoint

The implementation previously exposed `GET /api/coordination-runs/:id/events`, but the frozen route table only requires list, create, detail, start, and stop. The detail response already contains events. The extra route was removed in `ea469b2`, and its route test now verifies `404` so it cannot silently return as an accidental UI dependency.

### Contract export drift

The same contract freeze restored the API response envelopes, `Redactor`, and the future `AgentExecutionControl` boundary from overview Sections 8–9. The service-only logger interface moved into `service.ts` so it does not impose an implementation detail on other workstreams.

### Contracts merged before the contract gate

The domain types, interfaces, service, and routes were present before the contract gate. Commit `ea469b2` adds the missing shared deterministic artifacts, controls, fakes, module shells, construction test, and explicit contract corrections. Checkpoint 0 still requires the manual baseline and three-Agent checks.

### Contract tag discrepancy

P0-11 allowed either a Git tag or an immutable commit reference. The immutable
reference is `ea469b2`, so the contract gate remains satisfied. Earlier status
text also claimed that `relay/contracts-v1` existed, but a Phase 4 preflight
check found no such local or remote tag. Cleanup corrects the record and does
not create or push a tag; that optional repository-level action requires an
explicit decision before release.

### Phase 4 web testing strategy

**Status:** Implemented and verified on 2026-08-30 during Phase 4.

Phase 4 adds Vitest plus React Testing Library with a jsdom environment to the
web workspace. Automated tests render the redacted fixture matrix and cover completed,
rejection/revision, retry, timeout, stopped, failed, and interrupted states.
Polling tests use controlled timers and requests to prove one request chain and
cleanup on terminal state, selection change, and unmount. The web test script
is part of the root `npm run check` gate.

Browser verification passed for one real create/start/poll/complete flow and
one stop flow (P4-16), plus keyboard, responsive, and legibility checks at
1440×900 and 390×844. Fixture tests supplement that evidence; they do not
replace the real browser gate. The live normal flow exposed a post-start polling
reset defect; an explicit polling epoch fixed it and a regression test now
covers that transition.

### Shared conversation availability

The supplied ChatGPT share URL was inaccessible during this audit: the page reader could not fetch it, direct HTTP was stopped by a Cloudflare challenge, and the available browser runner requires Node 20 while the environment currently has Node 18. The implementation plan was therefore treated as authoritative, per the user request. If the shared conversation contains decisions absent from `overview.md`, copy those decisions into this file before freezing Checkpoint 0.

## Repository assumptions confirmed

- The project is TypeScript with ECMAScript modules.
- Fastify and Zod are the server route/validation pattern; React is the client.
- `AgentService.initialize()` marks queued/running Agent runs cancelled and busy Agents ready after restart.
- The JSON database is version 2; `JsonStore` migrates v1 additively and serializes mutations for a single process.
- The web client uses the existing API wrapper/polling style.
- Node.js 22+ and npm 10+ are repository prerequisites.

## Invariants that may not be weakened

- Exactly three distinct, pre-created Agents map to fixed roles.
- Backend state, never model prose, chooses the next role and terminal state.
- Artifacts are strict, bounded, versioned JSON and immutable after commit.
- Critic rejection is a committed workflow outcome; invalid/runtime output is an attempt failure.
- Only the active attempt and lease may commit.
- A timeout must settle/cancel the correlated Agent run before retrying the same Agent.
- Stops and restarts settle conservatively; late results are visible but ignored.
- Events and logs contain bounded, allowlisted, redacted metadata—not raw prompts or output.

## Mandatory workflow decisions

- Every task begins on a new task branch created from the intended current base. Direct implementation on `main` or the shared integration branch is prohibited.
- Every task consults `FILESYSTEM_MAP.md` first and limits file access to its mapped primary and justified conditional paths.
- All testing and verification runs through Docker Compose. Host Node/npm results are not accepted as completion evidence.
- Every completed development or implementation ends with a passing Docker Compose execution of `npm run check`; focused tests do not replace it.
- When any contract, phase instruction, file boundary, behavior, or acceptance criterion is unclear, work pauses for clarification. The answer is recorded before implementation resumes; assumptions are not silently substituted.

## Session extension plan (Phases 5–9)

### Nine-phase numbering decision

**Status:** Adopted by the team on 2026-08-30. The plan documentation was
authored on branch `session-phase-sheets`.

The team's Relay Sessions extension plan becomes the session mini-RFC. Its
repository-local authority is [`overview-sessions.md`](./overview-sessions.md),
authored during the same planning pass.

| Element | Decision |
|---|---|
| Phase numbering | Session build takes Phases 5–8; the former Phase 5 release phase becomes Phase 9 |
| Task IDs | Release tasks renumber from `P5-01..P5-18` to `P9-01..P9-20`; `P5-xx`, `P6-xx`, `P7-xx`, `P8-xx` belong to the new session phases |
| Checkpoints | Phase number equals checkpoint number; release is Checkpoint 9 |
| Release sheet | `phases/05-release.md` renamed to `phases/09-release.md`; historical STATUS references to P5-16 updated to P9-16 for zero dangling IDs |
| Sheet files | `phases/05-session-contracts.md`, `06-session-core.md`, `07-session-durable.md`, `08-session-ui.md`, `09-release.md` |

### Phase placement clarifications

The extension plan's phase rows were refined to mirror the original Phase 0 and
Phase 1 split, and the discrepancy is recorded rather than silently coded:

| Item | Decision |
|---|---|
| Additive contract code (types, contracts, fixtures, construction test) | Lands in **Phase 5**, matching Phase 0. The Phase 5 gate "contracts compile" requires it there. |
| Session behavior (workflow, countdown protocol, transcript context) | Lands in **Phase 6**, matching Phase 1. |
| Service create branch and workflow dispatch | Lands in **Phase 6** (walking skeleton requires it), matching original P1-14. |
| Repository commit case, routes union, composition root | Land in **Phase 7**, matching Phase 2. |
| Docs and rehearsal (the old standalone S4) | Folded into **Phase 9** release, which now covers both workflows. |

### Session semantics settled for the build

| Item | Decision |
|---|---|
| Expected-number authority | The session prompt never states the expected number. Agents read the transcript and derive it; the countdown validator is the sole authority. |
| Wrong-number recovery | Retry the same Agent once with validation errors; a second failure ends the run with `MAX_ATTEMPTS_EXCEEDED`. Reassignment is cut. |
| Session creation | `workflow` defaults to `"verified_handoff_v1"`; session variant requires 2–6 ordered distinct Agents and `sessionProtocol` (`"countdown"` default, `"free_chat"`). Countdown: `sessionStartValue` 2–12 (default 10), `maxTurns >= sessionStartValue`. Free chat: no start value, `maxTurns` 3–12 (default 6). No required sections, no max revisions. |
| Shared state | `run.sharedState.nextExpectedNumber` is public read-model evidence for countdown runs; free-chat runs have no shared state. Leases stay hidden. |
| Second session protocol | `free_chat` is in scope on the same `shared_session_v1` workflow: bounded non-empty messages (1..500) with an advisory `done` signal, completion on a unanimous `done` round, at `maxTurns` (default 6, range 3..12), or on user stop, no `sessionStartValue`, no `nextExpectedNumber`, and no substance judgement by the middleware. |
| Failure demo | One demo Agent is instructed to occasionally subtract 2 instead of 1. The Agent genuinely misbehaves; middleware behaviour is never simulated. |
| Latency | Live 10-turn runs can exceed the 3-minute demo budget. Mitigations: fast demo endpoint, pre-executed full run, live shorter run narrated over polling. |

### Session decisions settled at P5-01 (2026-08-30)

The team read `overview-sessions.md` and approved the session mini-RFC **with one
amendment** (the free-chat completion signal, recorded as its own mini-RFC below).
Every question previously listed as open in Section 11 is now settled:

| Question | Decision |
|---|---|
| `sessionStartValue` default and range | 10; range 2..12 (countdown only). Per-run policy field, so a shorter demo run needs no code change. |
| Participant ordering UX | Selection order is the turn order. Drag reordering stays a Phase 8 stretch goal; it changes no API. |
| Free-chat default `maxTurns` | 6; range 3..12, reusing the bound already shipped in `routes.ts`. |
| Misleading countdown run in local data | Delete before judging evidence (P9-19). |

`overview-sessions.md` Section 11 previously listed six open decisions while this
file already recorded two of them as settled. Section 11 has been rewritten to
match; this file remains the record of the decision.

### Session build scope settled at P5-01 (2026-08-30)

The team chose to implement **Phase 5 only** for now and leave Phases 6-8 for
teammates to pick up later. Both decisions were taken deliberately:

| Decision | Choice | Rationale |
|---|---|---|
| Build the session extension before releasing? | **Phase 5 only, then reassess.** | Phase 5 is 8 tasks of additive types, contracts and fixtures with no behaviour that can regress. It freezes the session contract cheaply and leaves the go/no-go on Phases 6-8 open until the team knows its pace. Phase 9 (release) remains unstarted and is what produces the submission. |
| Keep or cut `free_chat`? | **Keep in the frozen contract; defer implementation.** | `sessionProtocol` freezes with both members now, because reserving an enum member costs nothing and adding one after the contract freeze costs a mini-RFC plus rework in whichever phase the team is in. Countdown and free chat are both implemented in Phase 6. |

The team's stated intent for `free_chat`: participants share one chat, share the
transcript context, and work on any given task together. The first two are what
the contract already provides. The third is what the completion-signal mini-RFC
below exists to address.

**Consequence to carry forward:** if the project is submitted before Phases 6-8
land, the codebase contains session types, contracts and fixtures that nothing
implements, and the Phase 9 sheet is written for "both workflows" throughout
(P9-01, P9-09, P9-11, P9-12). Either implement the session phases or de-scope
Phase 9 to the verified workflow; do not ship documentation that claims a
protocol which does not run.

### Mini-RFC: free-chat completion signal

**Current contract.** `overview-sessions.md` Section 6.5 completes a free-chat run
"when all allowed turns are committed (`maxTurns`) or on user stop", and Section 2
lists semantic evaluation of free-chat content as an explicit non-goal.

**Blocker.** A free-chat run reaching `completed` therefore means *N turns
happened*, not *the task was done*. That is a materially weaker claim than the
team's stated goal of Agents completing a task together, and stating the stronger
claim in the README or the demo would be dishonest.

**Proposed change (approved 2026-08-30).** Add an optional `done?: boolean` to
`SessionMessagePayload`. It is **advisory**: a participant may declare that it
considers the shared objective met, and never ends the run by doing so.
`SharedSessionWorkflowV1` completes a free-chat run when **every participant's
most recent committed message carries `done: true`** -- unanimous consent across
one full round -- or at `maxTurns`, or on user stop, whichever comes first. A
later message from the same participant without the flag clears that
participant's own signal.

**Why this shape.**

- The rule is computed by backend code from committed artifacts only, so
  overview.md Section 5.1's trust boundary is unchanged: Agents supply input, the
  state machine decides. A single Agent asserting `done` cannot truncate the
  collaboration.
- It is pure and deterministic, computable from committed turns exactly like the
  round-robin position, so it fits `SharedSessionWorkflowV1` without new state.
- It degrades safely. If no Agent ever signals, behaviour is identical to the
  frozen `maxTurns` rule, so this is strictly additive.
- Unanimity requires at least one message from every participant, so a run can
  never complete before `participantCount` committed turns.

**Affected files and workstreams.** `coordination/types.ts` (Phase 5, done);
`SharedSessionWorkflowV1` completion routing and its table tests (P6-01, P6-03);
the free-chat schema and the countdown cross-field rejection of `done` (P6-04,
P6-05); the output contract shown in the prompt (P6-07); the transcript view
(P8-06); the documented completion claim (P9-01, P9-03).

**Required tests.** Unanimous round completes; partial round does not; a withdrawn
signal reopens the run; `done` on a countdown message is rejected with
`INVALID_AGENT_OUTPUT`; a free-chat run with no signals still completes at
`maxTurns`. Fixtures for the first three exist in `testing/session-fixtures.ts`.

**Confirmed (2026-08-30).** The whole team approved the unanimity rule exactly
as written above, together with the final-artifact-pointer rule: on any session
completion the run's `finalArtifactId` points at the last committed session
message (countdown: the message with value `1`; free chat: the closing message
of the unanimous round, or the message that consumed `maxTurns`). `P6-01`
encodes both rules.

### Mini-RFC: schedule decisions identify a repeated-role participant

**Status:** Approved by the user on 2026-08-30 during P6-01.

**Current contract and blocker.** Phase 5 made `SharedSessionWorkflow` reuse
`WorkflowDecision`. A schedule decision named only a `role`, and the service
resolved that role with the first matching run participant. This is sufficient
for verified handoff, whose three roles are unique, but every shared-session
member has role `participant`. The pure workflow could compute the required
round-robin Agent but could not communicate that identity to the service; every
real session turn would otherwise go to the first Agent.

**Approved change.** Add optional `agentId?: AgentId` to the schedule member of
`WorkflowDecision`. `SharedSessionWorkflowV1` always supplies the selected
round-robin participant ID. Turn construction resolves both role and Agent ID
when it is present. Existing verified-handoff decisions omit the field and keep
their existing role-only lookup unchanged.

**Scope and compatibility.** This is an additive internal workflow contract
change. It changes no persisted type, API request or response, event shape, or
verified-handoff routing behavior. Retries remain on the already scheduled
logical turn and therefore on the same Agent.

**Required evidence.** Pure workflow tests assert the selected Agent across
round-robin cycles; Phase 6 walking-skeleton tests assert the real service
schedules those Agents in order; the verified-handoff regression suite remains
green.

### Mini-RFC: Phase 5 exhaustiveness exception (approved, P5-02)

**Current contract.** `FILESYSTEM_MAP.md` scopes Phase 5 to `types.ts`,
`contracts.ts`, `testing/**`, and new session modules named by the phase sheet.

**Blocker.** This codebase expresses several backend-owned tables as
`Readonly<Record<CoordinationTurnKind, ...>>` and
`Readonly<Record<ArtifactType, ...>>`. Adding the session enum members
(`participant`, `sessioning`, `session_turn`, `session_message`) makes every one
of those tables fail to compile. Phase 5's own gate -- "session contracts and
fixtures compile" -- therefore cannot pass without editing files outside the map.

**Approved change.** Phase 5 may edit those files for **one purpose only**:
adding loud placeholder entries. A placeholder throws at runtime and names the
task that replaces it. Placeholders must never look like working instructions.
No real session instruction, prompt, routing, or validation is written in Phase 5.

**Placeholders are getters, not IIFEs.** The pattern first proposed was
`session_turn: (() => { throw new Error("..."); })()`. An IIFE inside an object
literal is evaluated when the **module is imported**, so that form throws on
import: the server would not boot and all 389 existing tests would fail,
including the test meant to prove the placeholder throws. A getter
(`get session_turn(): string { throw new Error("..."); }`) satisfies the same
`Record` type, keeps module load clean, and throws only when something reads the
session entry -- which nothing in Phase 5 does.

**Tables amended, and the task that replaces each.**

| File | Table | Replaced by |
|---|---|---|
| `coordination/context-builder.ts` | `TASK_INSTRUCTIONS.session_turn` | P6-07 |
| `coordination/context-builder.ts` | `OUTPUT_SHAPES.session_message` | P6-07 |
| `coordination/context-builder.ts` | `OUTPUT_LIMITS.session_message` | P6-07 |
| `coordination/context-builder.ts` | `ROLE_VISIBILITY.session_turn` | P6-07 |
| `coordination/events.ts` | `ROLE_LABELS.participant` | P6-01 |
| `coordination/events.ts` | `TURN_KIND_LABELS.session_turn` | P6-01 |
| `coordination/artifact-protocol.ts` | `EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND.session_turn` | P6-05 |
| `coordination/workflow.ts` | local `expectedOutput.session_turn` | P6-01 |

`workflow.ts` was found by the typecheck and is not in the amendment's original
list: its `expectedOutput` map is indexed by `turn.kind`, so the new member
produced `TS7053`. It takes the same placeholder treatment.

**Deliberately not fixed.** Two sites accept the new members **without** a
compile error and are therefore out of scope by explicit instruction:

- `repository.ts` `expectedArtifactTypeForTurn` returns `"proposal"` from a bare
  `default:`, so a session turn is silently recorded as expecting a proposal
  artifact. **P7-02 owns this. TypeScript will not remind anyone.**
- `context-builder.ts` `capPayload` ends in a bare fallthrough. Because
  `SessionMessagePayload` also has a `content` field, a session message would
  take the final-artifact branch and appear to work. **Phase 6 owns this.**

Both were verified to compile cleanly in their current form, which is precisely
why they are recorded here: nothing in the build will surface them.

**One file outside the amendment.** `coordination/service.ts` is edited for the
create dispatch and the minimal session create, because P5-07's required
construction test cannot exist otherwise ("a session create produces a `created`
run with `phase: \"sessioning\"` and `sharedState.nextExpectedNumber`
initialized"). Full create validation and the session context probe remain P6-10.

**Required tests.** `session-placeholders.test.ts` proves every placeholder
throws with its task name, and proves the amended modules still import cleanly.
The four `context-builder.ts` tables are module-private and `build()` reads the
expected artifact type first, so they are covered collectively through the real
public entry point rather than individually; exporting four internal tables to
assert them would widen the module surface, which this phase may not do.

### Session invariants that may not be weakened

- Round-robin selection derives from committed session turns only; retries never advance the position.
- A countdown session commit updates `nextExpectedNumber` in the same atomic mutation as turn and attempt settlement; free-chat commits update no shared state.
- Free-chat completion is unanimous-`done`, turn-bound, or user-stopped; the middleware never judges message substance, only whether participants have declared completion. On completion the run's `finalArtifactId` points at the last committed session message.
- Only the active lease may commit; late results stay visible but ignored.
- Countdown prompts never contain the expected number; free-chat prompts contain no hidden state. Prompts never contain lease tokens, events, or another Agent's raw history beyond the bounded transcript.
- All existing verified-handoff and single-Agent behaviors, tests, and stored shapes remain unchanged.

---

## Mini-RFC: Session v2 contract amendments

**Status:** Approved by the user on 2026-08-30 for P10-01.
**Plan:** [`plans/session-v2-plan.md`](./plans/session-v2-plan.md). Implementation sheets: [`phases/10-session-v2-surface.md`](./phases/10-session-v2-surface.md) through [`phases/15-scale-and-release.md`](./phases/15-scale-and-release.md).

**Current contract and blocker.** [`overview-sessions.md`](./overview-sessions.md)
freezes the shared-session workflow around a single-shot, strictly sequential,
countdown-first run with 2..6 participants. Six requested changes are outside
that contract, and three of them are named in Section 2 as explicit non-goals.
The work cannot proceed under the document as written.

**Approved changes.** Each names the phase that implements it, so the contract
never describes behaviour the code does not have.

| # | Amendment | Section | Phase |
|---|---|---|---|
| 1 | Parallel fan-out turns are in scope; a wave of turns may be scheduled and executed concurrently | 2 | 13 |
| 2 | The countdown protocol is removed. Ordered output becomes an emergent property of planned sequential scheduling, not of an engine-side numeric validator | 1, 2, 6.1–6.4 | 10 (UI), 14 (engine) |
| 3 | A session is long-lived. It accepts repeated user prompts and terminates only on explicit user action, user stop, failure, or the hard turn ceiling | 6.5 | 12 |
| 4 | Participants range 2..10; session `maxTurns` ceiling rises to 100,000 with a default of 200 | 4, 7 | 10 |
| 5 | Turn assignment may come from a validated `session_plan` artifact authored by a participant. The middleware validates the plan's structure only and never its substance | 5, 6 | 14 |
| 6 | An Agent is reserved while it has a **running attempt** in a non-terminal run, not merely while it appears in a running run | 8 (and `overview.md` 10.4) | 11 |

**Affected files/workstreams.** Session types, routes, service create/validate,
session workflow, artifact protocol, context builder, repository commit and
reservation reads, the whole web session surface, and every fixture and test
that pins a session limit, protocol, or lifecycle assumption. Verified-handoff
semantics, routes, and stored shapes are unchanged throughout.

**Migration and tests.** No database migration. Every change is additive to the
v2 shape or a limit widening; removed engine behaviour (countdown) keeps its
stored fields readable, asserted by a fixture test in P14-07. Each phase sheet
carries its own required test matrix.

### Recorded answers to the Session v2 open questions

| Question | Answer | Consequence |
|---|---|---|
| Legacy verified-handoff runs in the UI after the workflow is removed from the frontend (P10-06) | Keep them in the run index, opening read-only behind a legacy-workflow banner | Checkpoint 8 verified evidence stays reachable from the browser; one render branch plus a fixture test |
| Default `maxTurns` for a new session (P10-04) | 200. Ceiling stays 100,000 for callers that ask explicitly | A runaway loop costs ~200 turns, and Phase 12 sessions do not hit the ceiling in normal use |
| Reservation model (P11-05) | Reserve per running attempt | Idle participants of a live session stay usable in the Playground, which is what stops Phase 12 sessions from feeling permanently stuck |
| Coordinator identity (P14-03) | Deferred to Phase 14 entry | Recorded there before `P14-03` starts |
| API and module naming (P10-08) | The product renames to Session; `/api/coordination-runs` and the server-side `coordination*` modules keep their names | Deliberate divergence between product name and API path, to avoid ~1,100 lines of test churn for no user-visible gain |
| Phase 9 | Superseded by Phase 15 | Releasing the pre-v2 feature set would document a product that no longer exists |

## Mini-RFC: Phase 11 lifecycle reconciliation (approved, P11-02)

**Current contract.** `overview.md` Section 7.2 freezes the coordination event
set and Section 10.4 derives Agent reservations from run membership. Neither
describes a run whose orchestration loop has exited without a terminal
transition, because the frozen design assumed every loop exit was terminal.

**Blocker.** It is not. `P11-01` enumerates six exits in
`CoordinationService` that returned without a terminal repository call. Each one
left the run `running` with its `activeTurnId` set and its participants
reserved, with nothing left to drive it — the reported "stuck Agents" defect.
Neither the error-code enum nor the event set could express the outcome.

**Approved additions.** Both are additive; no stored shape changes and no
migration is required.

| # | Addition | Where | Why |
|---|---|---|---|
| 1 | `RUN_ABANDONED` joins `CoordinationErrorCode` | `types.ts` | Names a run whose loop exited and could not be resumed. It is not an Agent fault, so no existing code fits. |
| 2 | `run.reconciled` joins the frozen event set | `types.ts`, `events.ts` | Records that a stranded turn and attempt were settled while the run stayed schedulable. It never replaces a terminal event, and one run may carry several. |

**Redaction.** `run.reconciled` carries only `code` and `reason`, both already on
the `ALLOWED_EVENT_DETAIL_KEYS` allowlist, so the allowlist itself is unchanged.
The event's `reason` passes through `defaultRedactor` inside the factory like
every other event, proven by a test that plants a lease token in the reason and
asserts it is replaced.

### Reservation model as implemented (P11-05)

The recorded Session v2 answer is "reserve per running attempt". Implementing it
literally everywhere would also have allowed one Agent to be enrolled in two
concurrently live coordination runs, which the decision's stated consequence
("idle participants stay usable in the Playground") never asked for and which
would put two state machines on one Agent. The rule is therefore implemented at
two levels, both in `repository.ts`:

| Level | Helper | Governs | Rule |
|---|---|---|---|
| Attempt | `collectReservedAgentIds`, `findReservingRunId` | Playground turns, Agent edit/start/stop/delete | Reserved while the Agent holds a `running` attempt in a non-terminal run |
| Run | `collectEnrolledAgentIds` | `startRun` participant admission | Refused while the Agent is a participant of another non-terminal run |

This satisfies the phase sheet's requirement that `startRun` "keep refusing an
Agent that is genuinely mid-attempt" — it refuses strictly more — and it is why
the existing verified-handoff reservation tests in `api.test.ts` pass unchanged.
Two repository/agent-service tests that asserted the old whole-run rule were
updated and now prove the new one; the justification is this entry.

`getReservingRunSummary` is a separate, display-only read. It is enrolment-shaped
on purpose: a user whose Agent is refused wants the session named whether or not
that Agent happens to be mid-attempt at that instant. It returns the run id and
name snapshot and nothing else.

### `stop_requested` runs are settled by the sweep

`reconcileRun` refuses any run that is not `running`: terminal runs are
immutable, and a `stop_requested` run belongs to the stop path. That leaves one
gap — a `stop_requested` run whose `stopRun` call died before `finishStopped`
would hold its reservations forever. The Phase 11 sweep closes it by calling
`finishStopped`, which is idempotent and is exactly the transition `stopRun`
would have made next, so racing an in-flight stop request is harmless. Recorded
here because it extends `P11-06` beyond the sweep's literal wording.

---

## Mini-RFC: auction-track parallel waves

**Status:** Approved by the user on 2026-08-31 for `PA13-01` on branch
`bidding-agent-implementation`.
**Authority:**
[`phases/parallel/13-auction-foundation.md`](./phases/parallel/13-auction-foundation.md)
and
[`phases/parallel/14-adaptive-auction-coordination.md`](./phases/parallel/14-adaptive-auction-coordination.md)
govern this branch's Phase 13 and Phase 14 work. They do not amend the main
coordinator-planning track.

**Common base.** This branch starts at `aa17407`, the completed Checkpoint 12
merge also used by `main` when the parallel tracks diverged. It inherits the
Phase 12 multi-prompt lifecycle, transcript ordering, delta reads, loop fencing,
Stop-versus-End behaviour, and restart guarantees unchanged. The auction and
main coordinator tracks must remain separate until both have been exercised
against the documented manual comparison suite.

**Current contract and blocker.** The Session v2 mini-RFC authorises bounded
parallel fan-out, but it does not distinguish why a wave exists. Fair bidding
also cannot be built safely from mutable Agent descriptions, hidden prior model
thread context, or estimated token use. Treating bid failures like execution
failures would let one unavailable bidder fail an otherwise healthy round;
treating execution failures like bid failures would silently weaken the existing
session contract. The following additions are therefore required before Phase
14 may introduce selection or award logic.

### Approved additions

| # | Addition | Contract |
|---|---|---|
| 1 | Purpose-aware waves | Session turns may carry backend-owned `session_bidding` or `session_execution` purpose. Old history and verified-handoff turns normalize to execution. A single active wave cannot mix purposes for one user-message round. |
| 2 | Concurrent active turns | `CoordinationRun.activeTurnIds` replaces the singular pointer. Scheduling a wave is one version-checked mutation; sibling settlement removes only that sibling, while stop, failure, and restart settle the whole active set atomically. |
| 3 | Agent specialisation snapshot | Agents may have bounded optional `perspective`, normalized `focusAreas`, and `biddingInstructions`. Session creation snapshots that structure into the participant, so later Agent edits cannot change an existing round's routing evidence or prompt digest. Specialisation remains subordinate to system, policy, and output contracts. |
| 4 | Actual attempt usage | Runtime `RunUsage` crosses the execution-completion boundary and is stored on the attempt that incurred it, including failed, cancelled, and retried attempts. Public reads expose numeric input, cached-input, and output counts only. |
| 5 | Isolated execution threads | The Agent execution boundary gains an `agent_default` / `fresh` thread policy. Bids always use `fresh`; awarded execution defaults to `fresh` and receives its complete bounded context explicitly. No provider thread identifier becomes public or durable coordination evidence. |
| 6 | Purpose-specific settlement | Execution siblings retain the strict Phase 13 rule: retry exhaustion fails the run after all siblings settle. Bid failures mark only that bidder unavailable; healthy bids remain usable. Phase 14 owns the bounded zero-valid-bid fallback and cannot interpret zero bids as success. |
| 7 | Bid and award evidence | Phase 14 may add durable bid, award, and execution-plan artifacts keyed by `lastUserArtifactId`. They travel through ledger-sequenced delta reads but are not automatically chat-visible; only an accepted direct candidate or final execution result enters the transcript. No second mutable current-auction pointer is added. |

**Migration behaviour.** No eager file or database migration is written. On
read, legacy `activeTurnId` becomes a zero- or one-element `activeTurnIds` array;
missing wave purpose normalizes to `session_execution`; missing Agent
specialisation, participant snapshots, attempt usage, and thread policy retain
their pre-auction meanings. Historical fields may remain in stored files and
must not be destructively rewritten. New optional public fields are additive.

**Trust and privacy boundaries.** Wave purpose, membership, concurrency,
budgets, retries, leases, settlement, and award validation remain backend-owned.
Agent-authored text cannot select a purpose or alter policy. Events and public
attempt reads continue to exclude prompts, raw outputs, lease tokens,
credentials, provider thread identifiers, and mutable runtime handles.

**Verified-handoff non-regression.** `workflow.ts` decision logic remains outside
the auction implementation paths; `PA13-02` may mechanically adapt its active-
turn guard from the singular pointer to `activeTurnIds.length` so the frozen
invalid-state behaviour still compiles and passes unchanged. `scheduleTurn`
stays a one-turn wrapper, verified runs must always have zero or one active
turn, and the existing verified-handoff workflow, event, API, persistence, and
restart regression matrices must pass unchanged at Auction Checkpoint 13.

**Required evidence.** The `PA13-15` through `PA13-20` race, supervisor, usage,
specialisation, isolation, web, and real ten-participant tests are the acceptance
matrix. Auction Phase 14 must not begin while a purpose-aware wave race is
flaky, while actual usage attribution is incomplete, or while an earlier Agent
thread can influence a bid.

### Addendum: contract additions made by `PA13-09`–`PA13-19` (2026-08-31)

These are the concrete contract widenings the approved auction mini-RFC above
implied but did not name. All are additive, all are backend-owned, and none
changes a verified-handoff shape.

**One new frozen event type: `turn.failed`.** Bidding-wave tolerance needs a
durable record that one member was retired while the run continued. The frozen
set had no turn-level failure event — `run.failed` is terminal and
`attempt.failed` is per attempt — so the set is widened exactly as `P11-02`
widened it for `run.reconciled`. It is emitted only by `failTurn`, only for a
member of a live wave, and it carries `sequence`, `role`, `agentId`, `code`,
and `reason` and nothing else. An execution wave never produces one: its
failure is the run's failure.

**Two new event-detail allowlist keys: `wavePurpose` and `waveSize`.** Both are
enum values or small integers. `turn.scheduled` carries `wavePurpose` whenever
the turn has one, and `waveSize` only when more than one turn was scheduled in
the same mutation, so a single-turn schedule is still distinguishable from a
one-member wave in the ledger. Neither can carry free text.

**One new repository command: `failTurn`.** It retires exactly one member of a
live wave: it cancels that member's running attempt, marks the turn `failed`,
removes only that turn from `activeTurnIds`, bumps the run version, and appends
`turn.failed` — all in one mutation. It refuses a turn that already settled, a
turn that is not a member of the run's active wave, and any non-`running` run,
so it can never resurrect or re-settle anything. Because it cancels the attempt
in the same mutation, the reservation invariant holds the instant it returns.

**Three new optional session policy fields.**

| Field | Meaning | Default |
|---|---|---|
| `sessionWaveMode` | `sequential` keeps the exact Phase 12 one-turn-at-a-time behaviour; `parallel` answers each user message with one atomic wave of every participant | `sequential` |
| `sessionWavePurpose` | The purpose stamped on every member of that wave | `session_execution` |
| `maxParallelTurns` | Concurrency cap for a wave | `min(participantCount, 4)`, ceiling `SESSION_LIMITS.maxParallelTurns` (10) |

All three are validated by the route and the service, fixed at create time, and
read only by backend code. Absent fields mean the pre-auction behaviour, so every
run stored before this branch reloads unchanged. Three combinations are refused:
a bidding purpose on a sequential session (there is nothing to bid against), a
wave on the strictly ordered countdown protocol, and a cap outside `[1, 10]`.

`sessionWavePurpose` is a **Phase 13 rehearsal seam**, not the auction's routing
contract. It exists so a bid-shaped wave can be exercised end to end and
measured before any award logic exists. Parallel Phase 14 replaces it with the
`direct` / `auction` / `auto` routing policy and per-round overrides; when it
does, this field should be folded into that policy rather than kept alongside it.

**Scope note on `agent-service.ts`.** The Phase 13 filesystem map lists it as a
conditional path "only for the busy-Agent contention path". `PA13-09` also
requires the thread policy at that same boundary, which is where `codexThreadId`
is read and written. Both changes are confined to `startExecution` and
`executeRun`. A `fresh` execution passes `threadId: null` to the runner **and
does not write the resulting thread back to the Agent**; without that second
half, the first bid would seed a thread that every later bid inherits, which is
the exact asymmetry `PA13-09` exists to prevent.

**Concurrency is structural, not timed.** `runBoundedWave` creates exactly
`min(limit, memberCount)` workers, each pulling the next member only after its
previous one settled. No test asserts the cap by measuring elapsed time, and no
production path sleeps or polls waiting for a busy Agent: contention consumes one
unit of the turn's existing retry budget and is then handled by the wave's
failure policy.

## Proposed addendum: adaptive auction routing and scoring

**Status:** Approved by the user on 2026-08-31 for `PA14-01` on branch
`bidding-agent-phase-14`.
**Authority:** This addendum applies only to the auction track governed by
[`phases/parallel/14-adaptive-auction-coordination.md`](./phases/parallel/14-adaptive-auction-coordination.md).
It does not amend the main coordinator-planning Phase 14 sheet.

**Current contract and blocker.** The approved Phase 13 mini-RFC permits bid and
award evidence, but deliberately leaves routing defaults, bid bounds, scoring
rounding, cost weights, history windows, fallback evidence, and feedback writes
undefined. The Phase 14 entry criteria prohibit code until those choices are
mechanical. The live Phase 13 rehearsal also found a roughly 20% first-attempt
invalid-output rate and confirmed that an idle session reserves its roster until
Ended. This proposal settles both observations without weakening validation or
changing the established session lifecycle.

### Routing and migration

- New auction-capable free-chat sessions default to `routingMode: "auto"`.
  A missing auction policy means **legacy session routing**, not Direct: stored
  pre-auction sessions continue their existing sequential/parallel behaviour
  byte-for-byte. Legacy countdown history remains readable. New auction policy
  and the Phase 13 rehearsal-only `sessionWaveMode` / `sessionWavePurpose`
  fields are mutually exclusive.
- Auction sessions are long-lived. `awaiting_input` continues to reserve the
  snapshotted roster, and End remains the explicit release action. Phase 14 adds
  no implicit expiry or participant stealing; Phase 15 must document this
  operational cost prominently.
- Per-round input may choose `auto`, `direct`, or `auction`, select one existing
  participant, and declare `riskLevel: "normal" | "high"` plus
  `coordinationPreference: "single" | "team" | "either"`. It cannot supply or
  raise a budget. High risk or a `team` preference forces Auction; a conflicting
  explicit Direct request is rejected rather than silently widened.
- Primary selection follows the phase sheet order. Tag matching normalizes the
  current user message and each snapshotted focus-area tag with Unicode NFKC,
  lower-casing, and Unicode letter/number tokenization. A tag matches only when
  all its tokens occur as whole message tokens. Rank by matched-tag count, then
  matched character count, stored participant order, and Agent ID. This is an
  advisory local routing heuristic, never a complexity or quality judgment.
- An unavailable primary is replaced by the next candidate from that same
  deterministic ordering. If none is available, apply the configured fallback;
  never wait for an Agent without consuming a bounded attempt.

### Policy defaults and hard bounds

| Field | Default | Accepted bound / rule |
|---|---:|---|
| `routingMode` | `auto` | `direct | auction | auto` |
| `defaultAgentId` | absent | must be a snapshotted participant |
| `directConfidenceThresholdBps` | 8,000 | integer 0..10,000 |
| `directOutputTokenBudget` | 4,000 | integer 1..4,000 |
| `minimumValidBids` | 2 | integer 1..participant count |
| `maxBidOutputTokens` | 2,048 | integer 128..4,096 |
| `maxBidAttempts` | 2 | integer 1..3 |
| `auctionExecutionTokenBudget` | 4,000 | integer 128..16,000 |
| `auctionOnDirectFailure` | `false` | boolean; explicit opt-in only |
| `fallback` | `round_robin` | `default_agent | round_robin | fail`; `default_agent` requires `defaultAgentId` |
| `scoringVersion` | `confidence_cost_v1` | that literal only |

Team size cannot exceed the participant count, remaining turn ceiling, or the
existing `maxParallelTurns` cap. A direct recommendation must estimate no more
than `directOutputTokenBudget`; every executable plan must estimate no more than
`auctionExecutionTokenBudget`.

### Bid validation and the invalid-output finding

`session_bid` uses the strict discriminated shape in the Phase 14 sheet. Text
limits are: candidate answer 1..8,000 characters, plan summary 1..1,000,
assignment instruction 1..2,000, and each risk/assumption 1..500. Assignments
contain 1..10 members; risks and assumptions contain 0..10 items each; the raw
artifact remains subject to the run's `outputMaxChars` ceiling. Direct requires
a candidate answer and a single plan assigned to the bidder. Auction may omit
the candidate answer. All objects reject unknown fields.

The bid prompt will include one minified valid example for each recommendation,
state `JSON only` immediately before the output contract, repeat the applicable
numeric limits beside their fields, and return field-specific retry feedback.
No markdown fence or prose wrapper is accepted. This directly addresses the
rehearsal finding; validation is not relaxed, and bid count is not treated as a
quality signal.

### Projected cost and `confidence_cost_v1`

All arithmetic uses non-negative safe integers and floors integer division.
For planning, estimated input tokens are `ceil(UTF-8 bytes of the fully rendered
execution prompt / 3)`. Sequential plans additionally reserve each earlier
assignment's declared output allowance in every later prompt. This is a
documented conservative estimator, not provider billing. Projected cached input
is zero.

The v1 bid schema declares one execution output estimate rather than a separate
allowance per assignment. Therefore each earlier sequential assignment reserves
that full bid estimate in every later prompt. This intentionally overestimates
multi-step plans and is deterministic until a later schema version introduces
per-assignment allowances.

Weighted token units are `4 * input + 1 * cachedInput + 16 * output` (equivalent
to weights 1, 0.25, and 4 without floating point). The normalization ceiling is
the same formula using the run context ceiling estimate and
`auctionExecutionTokenBudget`. Therefore:

```text
normalizedProjectedCostBps = min(10000, floor(10000 * projectedUnits / ceilingUnits))
```

Confidence calibration uses only earlier feedback for awards won by that Agent:

- fewer than five rated awards: cold-start penalty = 500 bps;
- otherwise use the latest 20 rated awards, compute observed acceptance in
  basis points, and subtract `min(2500, max(0, declaredConfidence - observedAcceptance))`.

Reliability uses the latest 20 earlier awarded executions for the Agent. It is
`min(3000, floor(2000 * failed / observed) + floor(1000 * severeUnderestimate /
observed))`, where a severe underestimate means actual output tokens exceeded
125% of the bid estimate. No execution history yields zero reliability penalty;
the separate cold-start confidence rule still applies.

```text
rawScore = floor(
  (70 * calibratedConfidenceBps
   - 25 * normalizedProjectedCostBps
   - 5 * reliabilityPenaltyBps) / 100
)
scoreBps = clamp(rawScore, 0, 10000)
```

Ties resolve by higher calibrated confidence, lower projected weighted units,
stored participant order, then Agent ID. Ranking occurs only after every bid in
the bounded opportunity set settles, so completion order cannot affect it.
Scoring explanations expose inputs, integer components, version, and tie-break
reason only; they contain no prompt or raw output and call the result the
highest-ranked valid bid, never the objectively best Agent.

### Award, fallback, publication, and feedback

- `session_award` is a strict backend-authored discriminator with
  `selectionKind: "bid" | "fallback"`. Bid awards require
  `winningBidArtifactId`; fallback awards prohibit it and record the configured
  fallback plus selected Agent. `outcome` is `publish_candidate | execute_plan |
  fallback_execution`. Safe-failure fallback records one durable fallback
  decision event and fails the run; it does not fabricate an award or answer.
- The award key is `(runId, userArtifactId)`. Award creation, and Auto candidate
  award plus transcript publication, use version-checked atomic repository
  mutations. A collision reloads the committed decision; it never re-scores.
- Round-robin fallback selects by the count of earlier fallback awards modulo
  stored participant order, skipping unavailable Agents deterministically.
  Fallback is attempted once per user-message round. Winning execution failure
  never promotes a runner-up.
- Feedback is one mutable `accepted | rejected` projection per award, written
  with an expected version. Repeating the current value is idempotent; changing
  it appends another ID-and-enum-only audit event while leaving the award
  immutable. Feedback never blocks or resumes a session.
- Actual bid usage is the sum of every bid attempt; projected execution usage is
  the awarded estimator; actual execution usage is the sum of awarded/fallback
  execution attempts. The three categories remain separately named in API and
  UI. Tokens are never converted into a provider cost claim.

### Required evidence

This approved addendum completes `PA14-01` and authorizes implementation of
`PA14-02` onward. Every bound and formula above requires boundary or snapshot
coverage; compatibility fixtures must prove absent auction policy retains the
legacy path. The full Phase 14 race, failure, redaction, UI, Compose, and live
rehearsal gates remain mandatory.

## Addendum: contract additions made by `PA14-09`–`PA14-26` (2026-08-31)

Recorded per the source-of-truth rule: the implementation of the approved
adaptive-auction addendum needed these concrete shapes, and two of them differ
from the wording approved at `PA14-01`. Nothing here widens a budget, a
concurrency cap, an attempt ceiling, or participant scope.

### Award shape

- `session_award` is a turn-less, Agent-less artifact: `{ type, payload,
  createdBy: { kind: "system" }, sizeChars, createdAt }`. It has no
  `createdByAgentId` and no `transcriptSequence`, so it is structurally
  impossible for an Agent to author and it can never enter a transcript
  projection.
- **Deviation from the approved wording.** The approved addendum named an
  explicit `selectionKind: "bid" | "fallback"` discriminator. The implemented
  payload discriminates on `outcome` alone and derives the same rule
  structurally: `fallback_execution` prohibits `winningBidArtifactId` and
  requires `fallback`; the other two outcomes require a committed bid from the
  current round. A separate `selectionKind` would have been a second source of
  truth for a fact `outcome` already carries, and the repository rejects either
  inconsistent combination.
- The award key remains `(runId, userArtifactId)`. `awardSessionBid` is the only
  writer, takes `expectedRunVersion`, and returns `already_awarded` when an
  award for that user message exists — so a competing loop and a restarted loop
  both observe the committed decision instead of re-scoring.

### Feedback

- **Deviation from the approved wording.** The approved addendum described one
  *mutable projection per award written with an expected version*. Feedback is
  implemented as an `award.feedback_recorded` event carrying only the award id,
  the selected Agent id, and the enum; the current rating of an award is the
  newest such event. This keeps the "the award is immutable" invariant literal
  rather than nearly-literal, needs no second mutable record, and is idempotent
  in the sense that matters: re-rating changes the derived rating and appends
  one audit event, and nothing about the award or the run changes either way.

### Per-round routing on a user message (`PA14-14`)

- `POST /api/coordination-runs/:id/messages` accepts an optional strict
  `routing` object: `routingMode` (`direct | auction`), `selectedAgentId`,
  `coordinationPreference` (`any | single | team`), and `riskLevel`
  (`standard | high`). The strict schema is the escalation boundary: a budget,
  concurrency, attempt, or participant field is rejected as an unknown key
  rather than ignored.
- `riskLevel: "high"` is normalized to `routingMode: "auction"` on the stored
  message and a high-risk message may not request `direct`. A routing request
  is stored only on an auction-capable session, and an unknown
  `selectedAgentId` is a `409 INVALID_STATE` conflict rather than a silent
  downgrade.
- `coordinationPreference` and `riskLevel` are rendered into bid prompts as
  advisory text. They never change the output contract, the participants, or a
  budget.

### Execution prompt provenance (`PA14-11`, `PA14-12`)

- An awarded execution turn carries the award artifact id on its
  `inputArtifactIds`, and the context builder renders one
  `[AWARDED PLAN AND YOUR ASSIGNMENT]` section from the award plus the winning
  bid it names. Only the winning bid is reachable this way, which is the
  structural form of "losing bids never enter an execution prompt".

### Read model (`PA14-15`)

- Every run detail read carries `auctionUsage` with `actualBidding`,
  `actualExecution`, and `projectedExecution`. An attempt belongs to bidding
  exactly when its turn is a `session_bid` turn, so the two actual totals always
  reconstruct `usageTotals`, and `projectedExecution` is summed only from
  committed awards. No field is a currency amount.

## Corrective audit: auction routing and scoring evidence (2026-08-31)

The post-implementation review found four places where the code did not yet
implement the already-approved Phase 14 contract. These corrections clarify
mechanics; they do not change a budget, participant scope, scoring formula, or
trust boundary.

- When `auctionOnDirectFailure` is true, retry exhaustion retires the failed
  Direct turn without failing the run. The durable workflow then schedules one
  bounded bid opportunity set and resolves it normally. Awarded execution turns
  are identified by carrying the committed award id, so the earlier failed
  Direct turn can never be mistaken for a failed winning execution after a
  restart. With the flag false, Direct still fails without hidden expansion.
- Before each auction workflow decision, the service snapshots which session
  participants are currently `ready`. The pure selector, bid-wave builder,
  scorer, and fallback resolver receive the same snapshot. It can narrow the
  currently eligible set but never reorder or add durable participants. Omitted
  availability in legacy fixtures means all snapshotted participants are ready.
- An accepted Auto-direct candidate is scored directly with
  `confidence_cost_v1`; `minimumValidBids` applies only to competitive ranking.
  Its award therefore records calibrated confidence, projected cost, score, and
  projected tokens from the real scorer rather than zero-valued placeholders.
- Reliability history derives actual output tokens from durable attempt usage
  across every execution turn and retry linked to an award. Artifact character
  counts are not token evidence. A team plan's whole awarded execution is
  attributed to the Agent whose bid won, including delegated failures.
