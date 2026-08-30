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
