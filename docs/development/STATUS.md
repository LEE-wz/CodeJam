# Relay Development Status

**Last audit:** 2026-08-30 (Phase 5 session contracts implemented)
**Audited base:** `1c51170` (`main`, session phase sheets merged)
**Implementation branch:** `phase5-p5-01-session-contracts` (base `1c51170`)
**Current phase:** Phase 5 — Session Contracts and Freeze
**Current gate:** Checkpoint 5 verified (2026-08-30, commit `2fe14eb`)
**Overall state:** Phases 0–5 `complete`; Phases 6–8 deferred to teammates by the team decision at P5-01; Phase 9 (release) not started

## Nine-phase plan

| Phase | Content | Status |
|---|---|---|
| 0 | Baseline and contract freeze | `complete` |
| 1 | In-memory walking skeleton (verified workflow) | `complete` |
| 2 | Durable backend and evidence ledger | `complete` |
| 3 | Real Agent runtime and recovery | `complete` |
| 4 | End-to-end UI and evidence experience | `complete` |
| 5 | Session contracts and freeze | `complete` (sheet: [`phases/05-session-contracts.md`](phases/05-session-contracts.md)) |
| 6 | Session core in memory | `not_started` (sheet: [`phases/06-session-core.md`](phases/06-session-core.md)) |
| 7 | Durable session backend and API | `not_started` (sheet: [`phases/07-session-durable.md`](phases/07-session-durable.md)) |
| 8 | Session UI and real rehearsal | `not_started` (sheet: [`phases/08-session-ui.md`](phases/08-session-ui.md)) |
| 9 | Documentation, demo, release candidate (both workflows) | `not_started` (sheet: [`phases/09-release.md`](phases/09-release.md)) |

The session extension was adopted from the team's Relay Sessions plan. Its repository-local contract authority is [`overview-sessions.md`](overview-sessions.md). Phase 9 was formerly Phase 5; its task IDs moved from P5-xx to P9-xx.

## Resume here

**Phase 5 is complete and Checkpoint 5 is verified.** The frozen session
contract commit is `2fe14eb`, gate-verified on 2026-08-30 with a clean working
tree, so the tree the gate tarred is exactly that commit.

The next task ID is **`P6-01`**, and it belongs to whoever picks up Phase 6.
Before they write routing:

1. **The free-chat unanimity rule is confirmed.** The whole team confirmed it
   on 2026-08-30, together with the final-artifact-pointer rule (the last
   committed session message). P6-01 encodes both; see
   `ASSUMPTIONS_AND_DECISIONS.md`.
2. Read the **Phase 6 handoff notes** in full. Items 2 and 3 describe defects
   the compiler will not surface.
3. Create a Phase 6 task branch from the recorded frozen commit.

Nine loud placeholders mark the work: every one throws with the task ID that
replaces it, so `grep -rn "lands in P6-" apps/server/src/coordination/` lists
all of them.

Outstanding decision for the team, not for Phase 6: whether to create a
convenience tag on `2fe14eb`. None was created. The immutable commit reference
is sufficient, and the Phase 0 experience — documentation claiming a
`relay/contracts-v1` tag that never existed — argues for deciding explicitly
rather than assuming.

## Phase 5 task ledger

All changes are additive. No existing type member, route, persisted shape, or
verified-handoff behaviour changed. Existing tests are unchanged at 377 server +
12 web = 389; Phase 5 adds 22 server tests, for 411 total. All verified by the
Checkpoint 5 gate below.

| Task | Status | Evidence |
|---|---|---|
| P5-01 | `complete` | Team approved the session mini-RFC with one amendment (free-chat `done` signal). Every question open in `overview-sessions.md` Section 11 settled and recorded in `ASSUMPTIONS_AND_DECISIONS.md`; Section 11 rewritten to match. Build scope settled: Phase 5 only, Phases 6–8 to teammates, `free_chat` frozen in contract but implemented in Phase 6. |
| P5-02 | `complete` | Nine-phase numbering and the `P5-xx`/`P9-xx` prefixes confirmed unchanged. Exhaustiveness scope amendment approved and recorded in the Phase 5 sheet and `ASSUMPTIONS_AND_DECISIONS.md`. |
| P5-03 | `complete` | `types.ts`: `participant`, `sessioning`, `session_turn`, `session_message`, `CoordinationWorkflowKind`, `SessionProtocol`, `policy.workflow`/`sessionProtocol`/`sessionStartValue`, `SessionMessagePayload` (with the approved optional `done`), `CoordinationSharedState`, `run.sharedState`, `CreateSessionRunRequest`, `CreateRunRequest`, `SESSION_LIMITS`. `DEFAULT_COORDINATION_POLICY` still names `verified_handoff_v1`. Loud placeholders added under the amendment. |
| P5-04 | `complete` | `contracts.ts`: `SharedSessionWorkflow`, `CoordinationWorkflowDispatch`, widened `createRun` input union. `VerifiedHandoffWorkflow` untouched. Zod schemas deliberately **not** written here — P6-04 owns them, and writing them now would collide with that task. |
| P5-05 | `complete` | New `testing/session-fixtures.ts`: four participants, the 10→1 transcript, round-robin author helper, wrong-number and skipped-number outputs, non-integer/empty/oversize/fenced/prose/forged-provenance cases, free-chat messages, unanimous/partial/withdrawn `done` rounds, committed artifacts, expected event sequences. No randomness, network, or secrets. Added as a new module so the frozen Phase 1 fixture pack is untouched. |
| P5-06 | `complete` | Existing `FixedClock`, `DeterministicIdGenerator`, `InMemoryCoordinationRepository` and `ScriptedCoordinationRuntime` confirmed sufficient; no control added. New shell module `session-workflow.ts` (`SharedSessionWorkflowV1`) throws until P6-01. |
| P5-07 | `complete` | `session-contracts.test.ts` (15 tests) and `session-placeholders.test.ts` (7 tests): dual-workflow construction with the real shell, construction without a session workflow, countdown create initialising `phase: "sessioning"` and `sharedState.nextExpectedNumber`, free-chat create with no shared state and `maxTurns` 6, selection order preserved, participant/duplicate/unknown-Agent rejections, verified-handoff create unchanged, `done`-signal fixture shapes, and every placeholder throwing with its task name. |
| P5-08 | `complete` | Frozen session contract commit: **`2fe14eb`** on `phase5-p5-01-session-contracts`, gate-verified 2026-08-30 with a clean working tree. Mirrors P0-11: an immutable commit reference, no convenience tag created. |

### Phase 6 handoff notes (consolidated 2026-08-30)

1. **The free-chat unanimity rule is confirmed.** The whole team confirmed it,
   together with the final-artifact-pointer rule. P6-01 encodes both.
2. **`TASK_INSTRUCTIONS` cannot express two protocols on one turn kind.** It is
   keyed by `CoordinationTurnKind` alone, but `session_turn` carries both
   countdown and free chat. P6-07 must change that map's shape (for example key
   it by workflow or protocol, or make it a lookup function), not just fill in
   the placeholder.
3. **Two silent sites are fixed by schedule.** `repository.ts`
   `expectedArtifactTypeForTurn` (bare `default:` returns `"proposal"`) is
   P7-02, which now converts it to an exhaustive typed map so the compiler
   enforces the case. `context-builder.ts` `capPayload` (bare fallthrough that
   a session message would take by coincidence) is P6-07, which now adds the
   explicit `session_message` branch.
4. **No new `CoordinationEventType` for `done` (settled).** Unanimity is
   observable from committed artifacts; the evidence timeline shows the signal
   via the artifact payload. No event-type change.
5. **`createSessionRun` is the minimal P5-07 path.** Participant count,
   distinctness and Agent existence only. P6-10 now extends it with the full
   policy-range validation and the create-time context probe.

| Phase 4 gate condition | Evidence |
|---|---|
| Client contracts and create flow | Web-owned response types and list/create/detail/start/stop calls reuse existing bearer and structured-error behavior; the form validates role uniqueness, readiness, section keys, limits, and policy ranges while preserving input |
| Evidence experience | Run metadata, role mappings, events grouped by turn, nested attempts, retries/revisions, and escaped proposal/review/final artifacts render for all seven fixture scenarios |
| Polling and stop | One 1.5-second request chain cleans up on terminal state, selection change, and unmount; stop has pending/disabled state; a browser-discovered post-start polling defect has a regression test |
| Accessibility and responsive layout | Associated labels, error focus, meaningful terminal/status text, keyboard operation, and narrow layout passed; 390-pixel audit found no horizontal overflow or unlabeled inputs |
| Real browser evidence | Disposable Compose completed one real three-role run and one real stop flow; completion reached 15 events and the stop flow displayed cancellation and stale-result evidence |
| Full regression gate | Docker Compose `npm run check` passed: 21 server files / 377 tests, 2 web files / 12 tests, and both builds (389 tests total) |

`P5-01` (team approval of the session mini-RFC) is the next task ID, on the
Phase 5 sheet. Phase 9 release tasks (`P9-01` onwards) cover documentation,
demo, dependency/security, and clean-release checks for both workflows. The
optional `relay/contracts-v1` convenience tag remains a release-time decision;
immutable commit `ea469b2` already satisfies P0-11.

For all resumed work: create a new task branch first, consult `FILESYSTEM_MAP.md`, clarify uncertainties before acting, run every test through Docker Compose, and require a passing Docker Compose `npm run check` before marking implementation complete.

## Defects found in Phase 2

| Defect | How it was found | Resolution |
|---|---|---|
| Production 404s bypassed the frozen `ApiErrorResponse` envelope | Booting the real composition root (P2-17) returned `{"statusCode":404,"code":"NOT_FOUND","error":"Not Found",...}` where the injection tests returned `{"error":{"code":"NOT_FOUND",...}}`. Fastify's not-found context captures whichever error handler is installed when `setNotFoundHandler` runs, and `app.ts` registered the not-found handler **before** `setErrorHandler`. Only `NODE_ENV=production` registers a not-found handler, so no test-mode check could ever have caught it. | `setErrorHandler` now runs before the production static/not-found block, with a comment recording why the order matters. A regression test builds the app in production mode and asserts the frozen envelope; it provides a minimal web bundle when the real one has not been built yet and removes only what it created. |
| Unexpected `500` leaked arbitrary exception messages to responses and logs | Phase 2 review injected a credential-bearing connection string; the test checked only for stack/path leakage and therefore passed while the message remained exposed. | The handler logs only error classification and returns a fixed `INTERNAL_ERROR` message. Tests assert credential material is absent; runtime redaction also covers credential-bearing connection URLs. |

## Outstanding decisions

| Item | Status | Deadline |
|---|---|---|
| Dependency audit findings | Open: `npm ci` reports 1 moderate and 5 high findings. | P9-17 security/release review; do not apply breaking upgrades mid-phase. |
| Session mini-RFC approval | The session extension plan and `overview-sessions.md` are drafted but not yet team-approved. | Phase 5 `P5-01`, before any session code lands. |
| Session open decisions | `sessionStartValue` default 10 (2..12, countdown only), `workflow` field defaults to `verified_handoff_v1`, selection order is turn order, wrong numbers retry the same Agent then fail, free-chat sessions in scope (`sessionProtocol: "free_chat"`, default `maxTurns` 6). | Settle at `P5-01`; defaults recorded in `overview-sessions.md` Section 11. |
| Misleading countdown run in local data | The "Test Relay" run (objective "Count down from 10 to 0") contains a final artifact claiming a countdown was executed when nothing was. | `P9-19`: delete from local demo data before judging evidence. |
| Optional contract tag is absent | The accepted contract is immutably recorded as `ea469b2`, but neither the local nor remote repository has `relay/contracts-v1`. | Decide before release whether to create/push the convenience tag; no tag was created during cleanup. |

## Last checkpoint

Checkpoint 5 is complete. The additive session contract compiles, the session
fixtures and the shell workflow are in place, and `CoordinationService`
constructs with both workflows registered and initialises a session run's
durable shape. No session behaviour exists: routing, countdown validation,
transcript context and the free-chat completion rule are all Phase 6, and nine
loud placeholders throw with the task ID that replaces each. Every existing
verified-handoff test passes unchanged. Frozen at commit `2fe14eb`; no
convenience tag was created.

Checkpoint 4 is complete. The existing application owns a single Relay
workspace that consumes only the public API read model, never renders lease
capabilities or raw HTML, and presents run, turn, attempt, event, decision, and
artifact evidence. Controlled tests cover every required fixture state and
polling/stop behavior. Real browser flows passed in disposable Compose storage
at laptop and narrow viewport sizes; repository runtime data was not mounted or
touched.

Checkpoint 3 is complete. The production composition root calls real Agents
through `AgentService`, while the service retains ownership of ordinary Agent
state, messages, workspaces, threads, cancellation, and correlations. All real
smoke data used disposable Compose storage; repository `data/`, `workspaces/`,
and `codex-home/` were not mounted or touched.

Checkpoint 2 remains complete with its API/security follow-up applied and
verified by the Phase 3 full gate.

Checkpoint 1 is complete. The real workflow, artifact protocol, and role-scoped
context builder drive the real `CoordinationService` against an in-memory
repository and a scripted runtime, with no disk, HTTP server, timer, or model
call in any automated test. The full Docker Compose `npm run check` passed on the
Phase 1 tip: server and web typechecks, 14 server test files with 237 tests, web
build, and server build.

Checkpoint 0 remains as recorded: immutable commit `ea469b2` froze the
overview-aligned types and interfaces. Documentation previously claimed an
additional `relay/contracts-v1` tag, but the tag is absent locally and remotely.

## Phase 1 handoff to Phase 2

Four behaviours are specified in the frozen contract but cannot be produced by
Phase 1 code. They are deferred deliberately, not overlooked, and each needs an
owner in Phase 2:

| Item | Current state | Where it belongs |
|---|---|---|
| `attempt.stale_ignored` | No code path can produce this status. A late or duplicate result is correctly refused by the lease, but leaves no evidence row. | P2-05/P2-09, with events |
| `truncated` context flag | `PromptEnvelope.truncated` is computed correctly and then dropped by the service. `CoordinationAttempt` has no field for it, so overview Section 11.6's "record `truncated: true` in attempt metadata/event details" is unmet. | P2-05 event details, or a mini-RFC adding the attempt field |
| `attempt.outputDigest` | Declared in the frozen type and never written by any code path. | P2-09/P2-11, alongside commit |
| `includedArtifactIds` | Returned by the context builder and dropped by the service; `turn.inputArtifactIds` carries most of the same evidence. | P2-09, or drop it from the envelope by mini-RFC |

The shared Phase 1 fixtures, fakes, deterministic controls, in-memory
repository, and scripted runtime are frozen for Phase 2 repository and API
tests, as the phase sheet's handoff requires. Extend them additively; changing
existing fixture behaviour requires a recorded decision because Phase 2 tests
will depend on it.

## Phase 0 task ledger

| Tasks | Status | Evidence |
|---|---|---|
| P0-01–P0-03 | `complete` | Compose reports Node `22.23.2`, npm `10.9.8`; clean lockfile install and full check pass. |
| P0-04–P0-05 | `complete` | User-performed authenticated checks passed for the full temporary-Agent lifecycle, one Playground turn, three fresh Agents, one ordinary turn each, readiness, persistence, and isolation. |
| P0-06–P0-10 | `complete` | Scope/ADRs reviewed; contracts corrected; extra endpoint removed; terminal stop semantics frozen with tests. |
| P0-11 | `complete` | Immutable commit reference `ea469b2`; the optional convenience tag `relay/contracts-v1` is not present. |
| P0-12–P0-17 | `complete` | Module shells, deterministic kit, shared fixtures/fakes, scripted runtime, and construction test pass. |

## Phase 1 task ledger

| Tasks | Status | Evidence |
|---|---|---|
| P1-01–P1-04 | `complete` | Pure workflow selectors, full routing table, ceilings, invalid-state guards; 26 pure tests. |
| P1-05 | `complete` | Strict bounded proposal/review/final schemas; 20 boundary tests. |
| P1-06 | `complete` | Frozen Section 11.4 parsing order as fail-fast steps; Compose check passed with 12 files / 87 tests. |
| P1-07 | `complete` | Section coverage and uniqueness, reject/approve issue consistency, backend provenance. |
| P1-08 | `complete` | 23-row valid/adversarial matrix plus forged-provenance and injected-instruction cases; 72 protocol tests total. |
| P1-09–P1-12 | `complete` | Contract envelope and four role templates, Section 5.2 visibility whitelist, canonical serialisation, reproducible truncation ladder with safe failure, bounded retry feedback, leakage and superseded-history tests; 45 context tests. |
| P1-13 | `complete` | Scripted runtime with queued outcomes, captured calls, deferred manually-resolvable completions, and start waiters; 9 kit tests. |
| P1-14 | `complete` | Create validation: slug normalisation before duplicate rejection, frozen key/title limits, create-time context-cap probe using the real builder, one local loop per run; 12 service tests. |
| P1-15–P1-17 | `complete` | Shared in-memory repository with lease/active-attempt/status enforcement, and the walking-skeleton matrix over the real components; 36 tests. |

All Phase 1 evidence is the single Docker Compose `npm run check` recorded below;
no task was promoted on a host-only or focused run.

## Phase 2 task ledger

| Tasks | Status | Evidence |
|---|---|---|
| P2-01–P2-04 | `complete` | Overview Section 17 mini-sprint 3A implemented as one unit, because `DatabaseV2` cannot compile without the store that loads it. `DatabaseV1`/`DatabaseV2`/`AnyDatabase` and optional `AgentRunCorrelation` fields added; `parseDatabaseDocument` parses v1 explicitly and migrates additively by spread, so unknown top-level and per-record fields survive; new databases are created at v2; future/malformed/unparseable documents are rejected before any write. 11 store tests. Compose `npm run check` passed: 14 files / 247 tests. |
| P2-05–P2-07 | `complete` | Overview Section 19 mini-sprint 5A. Pure factories for all 17 frozen event types return an identity-free `CoordinationEventDraft`, because Section 10.3 requires the per-run sequence to be allocated inside the repository's own `mutate()`. Details are redacted **inside** the factory, so a caller cannot append an unredacted event by forgetting a step. `truncated` rides on `attempt.started` and `attempt.stale_ignored` exists as an event, per the confirmed handoff decisions. The redactor is a key allowlist plus secret-pattern stripping that runs before truncation. 38 tests. Compose `npm run check` passed: 16 files / 285 tests. |
| P2-08–P2-14 | `complete` | `DurableCoordinationRepository`. Every command runs in exactly one `JsonStore.mutate()`; there is no read-check-write across store calls. Reads are deterministic (newest-first cap 50 with insertion-order tie-break; detail sorted by turn sequence then attempt number, never array position) and return deep copies. `startRun` checks created status, distinctness, Agent existence/readiness, derived coordination reservations, and in-flight ordinary Agent Runs together. Commit checks run status, both active pointers, attempt status, and the opaque lease as one condition. A losing caller writes nothing but an `attempt.stale_ignored` event. 51 tests, including concurrent same-run starts, concurrent overlapping-participant starts, disjoint starts, wrong/superseded lease, timeout-then-successful-retry, stop-versus-commit, duplicate completion, terminal overwrite prevention, per-run event numbering, and a leakage check. |
| P2-20, P2-21 | `complete` | `interruptActiveRuns()` settles run, turn, and attempt and appends `run.interrupted` then `run.failed` with `SERVER_RESTARTED`, which is what releases the derived reservations; it is idempotent and leaves created/terminal runs alone. `listReservedAgentIds()`/`isAgentReserved()` expose the Section 10.4 derived reservation for `AgentService`; tests prove release after stopped and interrupted. Wiring into `AgentService` and `index.ts` remains P2-17. |
| P2-15, P2-16 | `complete` | The frozen route surface already carried strict schemas, UUID params, and policy ranges; P2-15 verified them rather than reimplementing. P2-16 adds 26 Fastify-injection tests over the **real** durable stack: auth required on all five routes, create/list/detail/start/stop statuses, `DUPLICATE_AGENT` on repeated Agents, duplicate section keys, four policy-range rejections, unknown-field rejection, `404` for a missing Agent and an unknown run, `400` for a non-UUID param, `409` for `AGENT_NOT_READY` and `AGENT_RESERVED`, `413` for an oversized body proven not to reach the service, and a safe `500` that leaks no stack or source path. |
| P2-17 | `complete` | `index.ts` constructs the real `VerifiedHandoffWorkflowV1`, `VerifiedHandoffArtifactProtocol`, `RoleScopedContextBuilder`, and `DurableCoordinationRepository` over the real `JsonStore`, with a UUID id generator, a system clock, an `AgentService`-backed Agent directory, and the scripted runtime as the deliberate Phase 2 placeholder. Coordination initialises after `AgentService`. Verified by booting the built server in a disposable container: `/api/health` `200`, authenticated `/api/coordination-runs` `200 {"runs":[]}`, unknown run `404` in the frozen envelope, removed `/events` route `404`, and a freshly created database written at `"version": 2` with all five coordination collections. |
| P2-18 | `complete` | `CoordinationLogContext` admits only identifiers, enum values, counts, digests, and the truncation flag, so a prompt, raw output, or lease token cannot be logged even by mistake. Logs are emitted at run start, turn schedule, attempt start, commit settlement, and stop, and asserted to contain no prompt or objective text. |
| P2-19 | `complete` (verify-only) | Confirmed as the handoff predicted, in two places: `routes.test.ts` asserts `404`, and the live boot probe returned `404` for `/events`. |
| P2-22 | `complete` | The detail response is exercised as an evidence timeline over the real stack for six fixtures — normal, reject/revise/approve, invalid-then-retry, failed, stopped, and restart-interrupted — asserting ordered turns, per-turn attempt ordering, artifact order, the exact event-type sequence, gapless per-run event numbering, and `outputDigest` on every committed attempt. |

## Phase 3 task ledger

| Tasks | Status | Evidence |
|---|---|---|
| P3-01–P3-07 | `complete` | `AgentService.startExecution()` returns the persisted Agent Run/message IDs and a completion promise; `sendMessage()` remains its compatibility wrapper. Runs store source plus coordination run/turn/attempt correlations. Cancellation is keyed and guarded by Agent Run ID, and reservations reject Playground send/edit/delete/start/stop while allowing only the matching internal coordination run. Eight regression tests cover compatibility, concurrent admission, failure recovery, correlation visibility, scoped cancellation, conflict, and terminal release. |
| P3-08–P3-13 | `complete` | `AgentServiceCoordinationRuntime` maps real execution into the frozen runtime contract, persists the Agent Run ID before awaiting completion, owns an attempt→Agent-run map, applies the unchanged attempt timeout, requests correlated cancellation, waits a bounded 2-second settlement grace, fails safely when settlement is unconfirmed, redacts safe messages including connection-URL credentials, and cleans timers/maps in `finally`. Six fake-control tests cover success, failure, timeout win, late success, user cancellation, unconfirmed settlement, targeted cancellation, and cleanup. |
| P3-14, P3-15 | `complete` | Disposable Compose one-Agent probe invoked the configured real provider through the real gateway. It succeeded in 4.789 seconds; its correlated Agent Run and user/assistant messages were visible, and its thread ID persisted. No identifiers, prompts, output, credentials, or lease values were recorded. |
| P3-16, P3-17 | `complete` | Three fresh real Planner → Critic → Finaliser runs completed with valid proposal/review/final artifacts and one attempt per role. During every active run, a competing Critic Playground send returned structured `409 AGENT_RESERVED`; automated coverage proves the same reservation releases after terminal settlement. |
| P3-18 | `complete` | Three successful disposable-Compose rehearsals used the configured local-process runtime profile. Redacted run fingerprints: `9b487919`, `6191748d`, `f753a107`. Total times: 87.549s, 108.157s, 56.905s (range 56.905–108.157s). Per-turn times: 26.273/14.760/46.428s; 59.585/24.617/23.461s; 22.809/12.919/20.860s (range 12.919–59.585s). Every attempt completed below the unchanged 120s timeout, so the default is feasible. |

## Phase 4 task ledger

| Tasks | Status | Evidence |
|---|---|---|
| P4-01–P4-05 | `complete` | Web-owned public coordination types and API functions; validated create form with exactly three distinct ready Agents, unique section keys, bounded policy controls, preserved input, structured field errors, and explicit create then start. |
| P4-06–P4-09 | `complete` | Detail renders status/phase/revision, roles, limits, actionable terminal summaries, ordered per-turn evidence, nested attempts, retries/revisions, and escaped artifacts across safe empty/loading/error/long-content states. |
| P4-10–P4-12 | `complete` | A single 1.5-second polling chain cleans up correctly; stop reconciles terminal state without duplicate requests; seven redacted fixture scenarios and error envelopes have automated coverage. |
| P4-13–P4-16 | `complete` | Minimal `App.tsx` integration preserves Agent/Playground ownership; labels, error focus, keyboard and responsive checks pass; disposable real-browser completion and stop flows passed. |

## Implemented inventory

| Area | Evidence | Status | Notes |
|---|---|---|---|
| Domain model/default policy | `apps/server/src/coordination/types.ts` | `complete` | Frozen against overview Sections 7–8 at immutable contract commit `ea469b2`. |
| Component contracts | `apps/server/src/coordination/contracts.ts` | `complete` | Frozen overview boundaries include repository/runtime/workflow/context/protocol/redaction/execution control. |
| Coordination error envelope | `coordination/errors.ts`, `app.ts` | `complete` | `CoordinationError` receives structured API envelope. |
| Service create/list/detail | `coordination/service.ts` | `complete` | P1-14 adds slug normalisation of required sections, frozen title/key limits, and a create-time context-cap probe that builds a real probe prompt. |
| Background orchestration | `coordination/service.ts` | `complete` | Scheduling, retries, runtime attachment, validation, commits, completion/failure, and local loop cleanup exist. |
| Stop handling | `coordination/service.ts` | `complete` | Durable request, active-attempt cancellation, and finish-stop flow exist; terminal HTTP semantics are frozen, while race evidence remains Phase 1/2 work. |
| HTTP routes | `coordination/routes.ts`, `app.ts` | `complete` | Frozen list/create/detail/start/stop surface; accidental events route removed and tested as absent. |
| Phase 0 testing kit | `coordination/testing/**`, `construction.test.ts` | `complete` | Deterministic controls, full fixture pack, fakes, scripted runtime, and construction proof pass. |
| Pure workflow selectors/routing | `coordination/workflow.ts`, `coordination/workflow.test.ts` | `complete` | P1-01–P1-04 pass: deterministic selectors, all routing transitions, revision/turn ceilings, invalid-state guards, and exhaustive pure decision tables. |
| Strict artifact schemas | `coordination/schemas.ts`, `coordination/schemas.test.ts` | `complete` | P1-05 strict bounded proposal/review/final Zod schemas pass exact string/array boundaries, trimming, slug, discriminator, optional-field normalization, and unknown-field tests. |
| Artifact parser/protocol | `coordination/artifact-protocol.ts`, `artifact-protocol.test.ts` | `complete` | P1-06–P1-08: frozen Section 11.4 order enforced as fail-fast steps (size, trim, one outer fence, one JSON parse, expected type, schema version, bounded schema, cross-field rules, backend provenance), plus the coverage/consistency rules and a 72-test valid/adversarial matrix including forged provenance and injected instructions. |
| Role-scoped context builder | `coordination/context-builder.ts`, `context-builder.test.ts` | `complete` | P1-09–P1-12: Section 11.5 envelope, four role templates, the Section 5.2 visibility whitelist, canonical key-sorted serialisation, a reproducible truncation ladder with safe failure, bounded retry feedback, and leakage tests covering identifiers, bookkeeping, and superseded history. |
| Shared Phase 1 fakes | `coordination/testing/memory-repository.ts`, `testing/fakes.ts` | `complete` | P1-13/P1-15: scripted runtime gains deferred, manually resolvable completions plus start waiters for race tests; the in-memory repository enforces lease, active-attempt, and status checks and returns deep copies so callers must reload. |
| Walking-skeleton evidence | `coordination/walking-skeleton.test.ts` | `complete` | P1-15–P1-17: the real workflow, protocol, and context builder drive normal, reject/revise/approve, invalid→retry→success, invalid twice, timeout→retry, failure twice, start-failure, revision-limit, turn-limit, duplicate-start, stop-during-deferred, and late-result cases with no disk, HTTP, timers, or model. |
| Service/API tests | `coordination/service.test.ts`, `coordination/routes.test.ts` | `complete` | Create-validation coverage added in P1-14; walking-skeleton coverage now uses real components rather than test-local stubs. |
| Relay web workspace | `apps/web/src/RelayWorkspace.tsx`, `coordination-api.ts`, `coordination-types.ts` | `complete` | Create/start, list/detail, polling/stop, grouped evidence and escaped artifacts are integrated through `App.tsx`; Vitest/RTL tests cover all fixture states and request lifecycle behavior. |

## Outstanding by phase

### Phase 0

- Complete. No Phase 0 tasks remain.

### Phase 1

- Complete. No Phase 1 tasks remain.

### Phase 2

- Complete. No Phase 2 implementation or decision tasks remain.

### Phase 3

- Complete. No Phase 3 tasks remain.

### Phase 4

- Complete. No Phase 4 tasks remain. Checkpoint 4 passed through automated
  fixture/request-lifecycle tests, the full Compose gate, and real browser
  completion and stop flows.

### Phase 5

- Complete. No Phase 5 tasks remain. P5-01–P5-08 landed on `phase5-p5-01-session-contracts`, one commit per task ID, and were promoted on the single Checkpoint 5 gate recorded in the verification log. Frozen contract commit `2fe14eb`.

### Phase 6

- Not started; **deferred to teammates by the team decision recorded at P5-01**. Instruction sheet is [`phases/06-session-core.md`](phases/06-session-core.md). Pure session workflow, countdown and free-chat protocols, transcript context, and the in-memory walking skeleton.
- Branch from the frozen session contract commit `2fe14eb`.
- Read **Open questions carried into Phase 6** above before starting. Every Phase 5 placeholder throws with the task ID that replaces it, so `grep -rn "lands in P6-" apps/server/src/coordination/` lists all nine of them.
- The Phase 5 fixtures, the shell workflow, and the session contract surface are frozen for Phase 6 and 7 tests. Extend them additively; changing existing behaviour needs a recorded decision.

### Phase 7

- Not started. Instruction sheet is [`phases/07-session-durable.md`](phases/07-session-durable.md). Durable session commits, the API create union, and race tests.

### Phase 8

- Not started. Instruction sheet is [`phases/08-session-ui.md`](phases/08-session-ui.md). Session form mode, transcript view, and the real 10-to-1 rehearsal.

### Phase 9

- Not started (renumbered from the original Phase 5; task IDs are now `P9-xx`). Instruction sheet is [`phases/09-release.md`](phases/09-release.md). `P9-01` is next: product documentation set for both workflows, README integration, Agent/demo templates, rehearsal/fallback, clean release verification, security inspection, and submission commit.

## Verification log

| Date | Commit | Check | Result |
|---|---|---|---|
| 2026-08-30 08:32 UTC | `2fe14eb` | **Checkpoint 5 gate** — final scoped Docker Compose `npm run check` | **Passed (exit 0):** server and web typechecks, 23 server test files with 399 tests, 2 web test files with 12 tests, web build, and server build. 411 tests total; the 389-test baseline is intact and Phase 5 adds 22. Run in the Compose container (`/workspace`) against a clean working tree, so the tarred source is exactly commit `2fe14eb`. Web bundle hashes matched the pre-check byte for byte. `npm ci` continues to report 1 moderate and 5 high audit findings held for P9-16. **This is the sole completion evidence for P5-01–P5-08.** |
| 2026-08-30 | `phase5-p5-01-session-contracts` | Earlier state: gate not runnable | No container engine was reachable from the environment the work was done in — `docker`, `podman`, `nerdctl`, `colima` and `lima` all absent, no daemon. Phase 5 was held at `implemented_unverified` rather than promoted on a host run. **Superseded by the passing gate recorded above.** |
| 2026-08-30 | `phase5-p5-01-session-contracts` | Non-authoritative pre-check | Full `npm run check` passed (exit 0) from a clean `npm ci --include=dev` over the same source snapshot the Compose command copies, **run outside the checkout** on Node 22.22.2 / npm 10.9.7: server and web typechecks, 23 server test files with 399 tests, 2 web test files with 12 tests, web build, and server build. The 389-test baseline is intact (377 server + 12 web); Phase 5 adds 22 server tests. `npm ci` continues to report 1 moderate and 5 high audit findings held for P9-16. **Recorded only to predict the Compose result. This is not completion evidence and satisfies no gate.** Its prediction was exact: the Compose gate returned the same 399/12 counts and the same web bundle hashes. |
| 2026-08-30 | `phase5-p5-01-session-contracts` | Placeholder-pattern correction | The amendment's proposed form, `session_turn: (() => { throw ... })()`, evaluates at **module load**, so it throws on import: the server would not boot and all 389 tests would fail, including the test meant to prove the placeholder throws. Verified by running it. Placeholders use getters instead, which satisfy the same `Record` type (tsc exit 0), keep module load clean, and throw only when the session entry is read. |
| 2026-08-30 | `phase5-p5-01-session-contracts` | Frozen-contract assertion vs. the placeholder | `artifact-protocol.test.ts` asserted `EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND` through `toEqual`, which enumerates properties and therefore triggered the new getter. Rewritten to assert each verified-handoff mapping individually plus the exact key set, so no coverage was lost and the assertion was not weakened. |
| 2026-08-30 | `session-phase-sheets` (uncommitted) | Session phase sheets and nine-phase renumbering | Documentation-only change: added `overview-sessions.md`, phases 05–08 instruction sheets, renamed `05-release.md` to `09-release.md` with P9-xx task IDs, and updated the runbook, FILESYSTEM_MAP, and this file. No code changed, so no Compose gate was run or required; the Phase 4 gate evidence below remains the authoritative code status. |
| 2026-08-30 05:18 UTC | `phase-4` working tree | Phase 4 final Docker Compose `npm run check` | **Passed (exit code 0):** server/web typechecks, 21 server test files with 377 tests, 2 web test files with 12 tests, web build, and server build. `npm ci` continues to report 1 moderate and 5 high findings deferred to P9-16. |
| 2026-08-30 05:05–05:16 UTC | `phase-4` working tree | Phase 4 real browser completion, stop, accessibility, and responsive evidence | **Passed:** a disposable Compose deployment completed a real Planner → Critic → Finaliser run while the UI advanced automatically to 15 events and all three artifacts. A second run stopped as `STOPPED_BY_USER` with request/cancel/stopped/stale evidence. Layout passed at 1440×900 and 390×844; the narrow audit found no horizontal overflow or unlabeled inputs. The initial live flow exposed a post-start polling reset defect; an explicit polling epoch fixed it and a regression test now proves detail polling resumes after start. |
| 2026-08-30 04:51 UTC | `pre-phase4-cleanup` working tree | Phase 4 preflight Docker Compose image build and full `npm run check` | **Passed (exit code 0):** server/web typechecks, 21 server test files with 377 tests, web build, and server build. The new three-test fixture suite covers all seven required UI scenarios, gapless evidence, consistent run IDs, and forbidden capability/secret strings. `npm ci` continues to report 1 moderate and 5 high findings deferred to P9-16. |
| 2026-08-30 03:36 UTC | `phase3-p3-01-real-runtime` working tree | Initial P3-01–P3-13 focused Compose suites | **Failed:** 84/85 tests passed; the scoped-cancellation test attempted to resolve the second deferred runner before it had started. The deterministic test waited for runner admission before resolving it; no product assertion was weakened. |
| 2026-08-30 03:38 UTC | `phase3-p3-01-real-runtime` working tree | P3-01–P3-13 focused Compose typecheck and tests | **Passed:** server typecheck plus 15 tests — eight AgentService regressions, six runtime gateway race/cleanup tests, and one complete three-role real-boundary integration test. |
| 2026-08-30 03:39 UTC | `phase3-p3-01-real-runtime` working tree | Phase 3 full Docker Compose `npm run check` | **Passed (exit code 0):** server/web typechecks, 20 server test files with 373 tests, web build, and server build. `npm ci` continues to report 1 moderate and 5 high findings deferred to P9-16. |
| 2026-08-30 03:40–03:46 UTC | `phase3-p3-01-real-runtime` working tree | P3-14–P3-18 real-provider disposable Compose smoke | **Passed:** one direct gateway execution (4.789s), then three fresh Planner → Critic → Finaliser workflows (56.905–108.157s total; 12.919–59.585s per turn), each with three first-attempt commits. Agent records/messages/threads/correlations remained visible, active Playground conflicts returned `409 AGENT_RESERVED`, detail leases were absent, and no real repository runtime directories were mounted. |
| 2026-08-29 | `3d24d1b` | `npm run check` | **Blocked before typecheck:** `tsc: not found`; dependencies are not installed. Environment reports Node `18.19.1`, below repository requirement Node 22+. No test/build result may be inferred. |
| 2026-08-29 | `3d24d1b` | Static repository audit | Coordination files/routes/tests are present; `index.ts` does not construct/pass a coordination service; `JsonStore` is v1-only; `AgentService` exposes no completion handle. |
| 2026-08-29 | `docs/development-workflow-rules` | Workflow-rule documentation | Branch rule, filesystem access map, Docker Compose-only verification, mandatory final `npm run check`, and clarify-before-assuming rules added and verified. |
| 2026-08-29 | `docs/development-workflow-rules` | Initial documented Compose check | **Failed:** production image user could not remove a root-owned host Vite cache (`EACCES` under `apps/server/node_modules/.vite`). Verification command updated to isolate dependencies/build outputs in named volumes. |
| 2026-08-29 | `docs/development-workflow-rules` | Named-volume Compose check | **Failed:** separate workspace `node_modules` mounts prevented npm workspace scripts from finding `tsc`. Verification command updated to copy a clean, read-only source snapshot into one disposable workspace volume. |
| 2026-08-29 | `docs/development-workflow-rules` | Clean-copy Compose check | **Failed:** tar could not preserve host UID/GID metadata in the anonymous volume and the source snapshot was broader than the filesystem map permits. Command narrowed to npm/TypeScript contracts plus `apps/` and uses `--no-same-owner`. |
| 2026-08-29 | `docs/development-workflow-rules` | Scoped-copy Compose check | **Failed:** Compose sets `NODE_ENV=production`, so plain `npm ci` omitted TypeScript/Vitest development dependencies. Command updated to `npm ci --include=dev`. |
| 2026-08-29 | `docs/development-workflow-rules` | Final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 7 server test files with 17 tests, web build, and server build. |
| 2026-08-29 | `ea469b2` | Focused Compose typecheck and contract tests | **Passed:** server/web typechecks plus construction and route contract tests. |
| 2026-08-29 | `ea469b2` | Final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 9 server test files with 23 tests, web build, and server build. `npm ci` reported 1 moderate and 5 high audit findings for later security review. |
| 2026-08-29 | `ea469b2` | Live application availability | **Partial:** `/api/health` is healthy and `/api/auth` confirms authentication is required. Manual authenticated lifecycle/model turns were not attempted without authorized credentials. |
| 2026-08-29 10:04:04 UTC | `d806e8f` | P0-04 manual existing-application regression | **Passed:** health, Agent list/create/edit/stop/start, one ordinary Playground run, return to ready, message persistence after refresh, deletion, and post-delete refresh. Optional stopped-Agent message rejection was not checked. |
| 2026-08-29 10:04:04 UTC | `d806e8f` | P0-05 manual three-Agent baseline | **Passed:** three genuinely fresh Agents began ready with empty histories; Planner, Critic, and Finaliser each completed one ordinary turn; all returned ready; final isolation and readiness passed. |
| 2026-08-29 10:27:04 UTC | `bd691de` | P1-01 focused Docker Compose test | **Passed:** `workflow.test.ts`, 4 tests covering deterministic sequence selection and invalid candidate exclusion. |
| 2026-08-29 10:27:04 UTC | `bd691de` | Final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 10 server test files with 27 tests, web build, and server build. `npm ci` continues to report 1 moderate and 5 high audit findings for later security review. |
| 2026-08-29 10:32:20 UTC | `eb6756a` | P1-02 focused Docker Compose test | **Passed:** `workflow.test.ts`, 10 tests covering selectors and all normal routing transitions, including revised-proposal precedence. |
| 2026-08-29 10:32:20 UTC | `eb6756a` | Final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 10 server test files with 33 tests, web build, and server build. |
| 2026-08-29 10:34:53 UTC | `phase1-p1-03-workflow-guards` | Initial P1-03 focused Docker Compose test | **Failed:** 17/18 passed; the revised-proposal fixture reset `nextTurnSequence` below its committed turns and correctly received `INVALID_STATE`. The fixture was corrected without weakening the guard. |
| 2026-08-29 10:35:17 UTC | `6f03c3e` | P1-03 focused Docker Compose test | **Passed:** `workflow.test.ts`, 18 tests covering selectors, normal routing, ceilings, and malformed durable states. |
| 2026-08-29 10:36:10 UTC | `6f03c3e` | Final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 10 server test files with 41 tests, web build, and server build. |
| 2026-08-29 10:38:50 UTC | `b0c1292` | P1-04 focused Docker Compose test | **Passed:** `workflow.test.ts`, 26 pure tests: 4 selector tests, 9 routing/limit table rows, and 13 invalid-state table rows. |
| 2026-08-29 10:39:39 UTC | `b0c1292` | Final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 10 server test files with 49 tests, web build, and server build. |
| 2026-08-29 11:10 UTC | `phase1-p1-05-artifact-schemas` | Initial P1-05 full Docker Compose `npm run check` | **Failed at server typecheck:** Zod's optional `sectionKey` output included explicit `undefined`, conflicting with the frozen exact-optional `ReviewIssue` type. Schema output was normalized to omit undefined rather than weakening the type. |
| 2026-08-29 11:12:02 UTC | `162da1d` | P1-05 focused Docker Compose test | **Passed:** `schemas.test.ts`, 20 tests covering valid fixtures, every string/array boundary, whitespace, strictness, slugs, discriminators, and optional normalization. |
| 2026-08-29 11:12:47 UTC | `162da1d` | Final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 11 server test files with 69 tests, web build, and server build. |
| 2026-08-29 | `ea15e37` | P1-06 final scoped Docker Compose `npm run check` | **Passed** (user-run): 12 server test files with 87 tests, both builds. P1-06 is `complete` on this evidence. |
| 2026-08-29 17:40 UTC | `f3caed5` | P1-07–P1-17 Docker Compose `npm run check` | **Not run.** No container engine is reachable from the environment the work was done in: the shell holding the checkout has no Docker, Podman, or Colima, and the alternative host is blocked from pulling `node:22-bookworm-slim` (403). Per the runbook these tasks therefore stay `implemented_unverified`; the check must be run on a host with Docker before any promotion. **Superseded by the passing gate recorded below.** |
| 2026-08-29 17:43:51 UTC | `f3caed5` | **Checkpoint 1 gate** — final scoped Docker Compose `npm run check` | **Passed:** server and web typechecks, 14 server test files with 237 tests, web build, and server build. Image built from `node:22-bookworm-slim`; `npm ci` continues to report 1 moderate and 5 high audit findings held for release review. This is the sole completion evidence for P1-07–P1-17. |
| 2026-08-30 02:15 UTC | `phase2-p2-05-events-redaction` | P2-05–P2-07 focused Docker Compose typecheck and tests | **Passed:** server typecheck plus 38 tests — 25 redaction tests (bearer/authorization/cookie/set-cookie/JWT/provider-key/lease-token patterns, redaction ordered before truncation, visible truncation, allowlist rejection of prompts and lease tokens under five spellings, bounded arrays, dropped objects, stable key order) and 13 event tests (all 17 frozen types covered, stable messages, actor attribution, `truncated` detail, Finaliser label with `finalizer` enum). |
| 2026-08-30 02:17 UTC | `phase2-p2-05-events-redaction` | P2-05–P2-07 final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 16 server test files with 285 tests, web build, and server build. Sole completion evidence for P2-05–P2-07. |
| 2026-08-30 02:22 UTC | `phase2-p2-08-durable-repository` | P2-08–P2-14/P2-20/P2-21 focused Docker Compose typecheck and `repository.test.ts` | **Passed:** server typecheck plus 51 repository tests. |
| 2026-08-30 02:24 UTC | `phase2-p2-08-durable-repository` | Race suite repeated ten times through Docker Compose | **Passed 10/10, no flakes.** Required by the phase sheet before the lease/race gate can be considered met. Races are driven by `Promise.all` over the store's serialised mutation queue and by explicit state sequencing — no sleeps anywhere in the suite. |
| 2026-08-30 02:25 UTC | `phase2-p2-08-durable-repository` | P2-08–P2-14/P2-20/P2-21 final scoped Docker Compose `npm run check` | **Passed (exit code 0):** server/web typechecks, 17 server test files with 336 tests, web build, and server build. `npm ci` continues to report 1 moderate and 5 high audit findings held for release review (P9-16). Sole completion evidence for these tasks. |
| 2026-08-30 02:29 UTC | `phase2-p2-15-api-composition` | P2-15/P2-16/P2-22 focused Docker Compose typecheck and `api.test.ts` | **Passed:** 25 tests over the real durable stack. Two initial failures were test defects, not product defects: the service correctly returns the frozen `DUPLICATE_AGENT` code where the test expected `VALIDATION_FAILED`, and a temp-directory cleanup raced a still-running background loop. Both were corrected without weakening an assertion. |
| 2026-08-30 02:31 UTC | `phase2-p2-15-api-composition` | Race and API suites repeated eight times through Docker Compose | **Passed 8/8, no flakes.** |
| 2026-08-30 02:32 UTC | `phase2-p2-15-api-composition` | **P2-17 live composition-root boot** in a disposable container | **Passed:** the built server started, `/api/health` returned `200`, authenticated `/api/coordination-runs` returned `200 {"runs":[]}`, an unknown run returned `404` in the frozen envelope, the removed `/events` route returned `404`, and the new database was written at `"version": 2` with all five coordination collections. Run against container-local temporary data directories; real `data/`, `workspaces/`, and `codex-home/` were never mounted or touched. |
| 2026-08-30 02:32 UTC | `phase2-p2-15-api-composition` | Production error-envelope reproduction | **Failed, then fixed.** Production returned Fastify's default 404 serialization instead of the frozen `ApiErrorResponse`. Root cause and fix recorded under **Defects found in Phase 2**. Re-verified: both `test` and `production` now return `{"error":{"code":"NOT_FOUND","message":"Coordination run not found"}}`. |
| 2026-08-30 02:34 UTC | `phase2-p2-15-api-composition` | **Checkpoint 2 gate** — final scoped Docker Compose `npm run check` | **Passed (exit code 0):** server/web typechecks, 18 server test files with 362 tests, web build, and server build. Sole completion evidence for P2-15–P2-19 and P2-22, and the Checkpoint 2 gate. |
| 2026-08-30 02:06 UTC | `d81635a` | Phase 2 baseline Docker Compose `npm run check` on branch `phase2-p2-01-database-v2` | **Passed** before any edit: server/web typechecks, 14 server test files with 237 tests, web build, and server build. Establishes the green baseline the Phase 2 work starts from. |
| 2026-08-30 02:09 UTC | `phase2-p2-01-database-v2` | P2-01–P2-04 focused Docker Compose typecheck and `store.test.ts` | **Passed:** server typecheck plus 11 store tests covering empty v2 startup, realistic v1 migration with field/timestamp preservation, unknown-field preservation, v2 round-trip with coordination collections and Agent Run correlation, and non-overwriting rejection of future, malformed, and unparseable documents. |
| 2026-08-30 02:10 UTC | `phase2-p2-01-database-v2` | P2-01–P2-04 final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 14 server test files with 247 tests, web build, and server build. Sole completion evidence for P2-01–P2-04. |
| 2026-08-29 17:40 UTC | `f3caed5` | Non-authoritative pre-check | 14 server test files, 237 tests, both builds pass under Node 22.23.2 / npm 10.9.8 from a clean `npm ci --include=dev` over the same source snapshot the Compose command copies, run outside the checkout. Recorded only to predict the Compose result. **This is not completion evidence and does not satisfy any gate.** |

## Manual Phase 0 verification report

### P0-04 — Existing application regression

| Check | Result |
|---|---|
| Health endpoint | Passed |
| Agent list | Passed |
| Create temporary Agent | Passed |
| Edit temporary Agent | Passed |
| Stop temporary Agent | Passed |
| Stopped-Agent message rejection | Not checked; optional and not required by P0-04 |
| Start temporary Agent | Passed |
| Execute one ordinary Playground run | Passed |
| Agent returned to ready | Passed |
| Messages persisted after refresh | Passed |
| Delete temporary Agent | Passed |
| Refresh after deletion | Passed |
| Overall P0-04 | **Passed** |

### P0-05 — Three fresh Agents

| Check | Result |
|---|---|
| Create three genuinely fresh Agents | Passed |
| All began ready with empty histories | Passed |
| Verify three-Agent baseline | Passed |
| Planner ordinary turn | Passed |
| Critic ordinary turn | Passed |
| Finaliser ordinary turn | Passed |
| All returned to ready | Passed |
| Final isolation and readiness | Passed |
| Overall P0-05 | **Passed** |

## Known blockers and risks

| Item | Impact | Resolution |
|---|---|---|
| Shared ChatGPT context inaccessible in this environment | Possible decisions outside `overview.md` were not audited. | Copy any missing decisions into `ASSUMPTIONS_AND_DECISIONS.md`; overview remains current authority. |
| Code ahead of gates | Merged code can create false confidence about completion. | Retain `implemented_unverified` until required phase evidence passes. |
| Dependency audit reports 6 findings | Later security/release review must assess 1 moderate and 5 high findings without blindly applying breaking upgrades. | Review in the appropriate dependency/security task before release. |
| ~~Detail response exposes lease tokens~~ | Resolved by a public attempt read model that omits the internal capability. | Closed 2026-08-30; API and live smoke assert absence. |
| ~~Current Agent cancellation is keyed by Agent ID~~ | Resolved by `cancelRun(agentRunId)` plus an active-run ownership guard; the provider's Agent-keyed primitive is invoked only while that exact run still owns the Agent. | Closed 2026-08-30; stale-run regression passes. |
| ~~Docker unreachable from the environment used for P1-07–P1-17~~ | Resolved. The gate was run on a host with Docker and passed; the tasks were promoted on that evidence. | Closed 2026-08-29. Any future assistant-run work must route the gate to a host with a container engine rather than substituting a host runner. |
| ~~Phase 1 implementation decisions not yet confirmed~~ | Resolved. All nine were confirmed unchanged on 2026-08-30 before P2-01, together with the four Phase 2 handoff decisions. | Closed 2026-08-30. |
| `stale_ignored` attempt status has no producer | By the confirmed §2.1 decision, evidence lives in the `attempt.stale_ignored` event, so the `CoordinationAttemptStatus` member stays unwritten. | Accepted. Phase 4 successfully renders the event-stream evidence in the stopped flow; revisit only if the contract changes. |
| Optional `relay/contracts-v1` tag is absent | Older status text incorrectly implied the convenience tag existed. The immutable commit remains sufficient for the contract gate. | Recorded during Phase 4 preflight. Create/push a tag only after an explicit decision. |

## Decision log summary

- Code enum/API spelling is `finalizer`; user-facing label is “Finaliser.”
- `AgentService.startExecution()` owns the completion-handle seam; `sendMessage()` remains its compatible wrapper.
- `JsonStore` requires explicit additive migration; there is no existing hook.
- Routes register through optional `createApp(..., coordination)`; `index.ts` composes the real repository and AgentService-backed runtime.
- Three real rehearsals measured 12.919–59.585 seconds per turn; the 120-second default attempt timeout remains unchanged.
- Terminal stop is frozen as idempotent `202` with explicit completed/failed/stopped route tests.
- The detail route is the only event retrieval contract; the accidental `/events` endpoint was removed.
- Frozen contract commit is the immutable reference `ea469b2`; the optional `relay/contracts-v1` convenience tag is absent.
- Approved P1-01 mini-RFC adds committed turns to `WorkflowView`; selectors order by `turn.sequence`, never artifact array position or timestamps.
- Approved P1-05 mini-RFC freezes numeric artifact field/array limits while retaining the separate raw-output cap for P1-06.
- Nine Phase 1 implementation decisions are recorded in `ASSUMPTIONS_AND_DECISIONS.md`; they change no frozen type, route, or persisted shape, and were confirmed unchanged on 2026-08-30.
- Four Phase 2 handoff decisions settled on 2026-08-30: `sizeChars` stays the raw-output length; `truncated` is an `attempt.started` event detail only; `outputDigest` is populated at commit; `attempt.stale_ignored` is emitted as an event without extending the `finishAttempt` status union. None is a mini-RFC.
- `DatabaseV2` migration is additive by spread, so unknown fields in an existing v1 file are preserved rather than dropped.
- `app.ts` must register `setErrorHandler` before the production static/not-found block; the reverse order silently breaks the frozen error envelope in production only.
- The approved additive mini-RFC adds `BeginAttemptInput.truncated?` and `CommitAcceptedArtifactInput.outputDigest?`, the only route by which the confirmed §1.2 and §1.3 decisions can reach the repository.
- Approved Phase 2 follow-up mini-RFCs remove redundant `PromptEnvelope.includedArtifactIds` and exclude `leaseToken` only from the public attempt read model, leaving durable lease enforcement unchanged.
- Phase 4 uses fixture-driven automated component tests for all required UI states, with browser verification for the real normal and stop flows; both gates passed and details are recorded in `ASSUMPTIONS_AND_DECISIONS.md`.
- Active detail polling uses a monotonic epoch to restart after the explicit start transition, avoiding dependence on React batching when the selected run ID is unchanged.
- The implementation plan now has nine phases. Phases 5–8 build the shared-session workflow (session contracts, session core, session durable, session UI); the former Phase 5 release phase becomes Phase 9 with its task IDs renumbered from P5-xx to P9-xx. Phase 9 releases both workflows.
- The frozen session contract is the immutable commit `2fe14eb`, verified by the Checkpoint 5 Compose gate. No convenience tag was created; whether to add one is an open team decision, deliberately not assumed after the Phase 0 `relay/contracts-v1` discrepancy.
- Phase 5 was granted an exhaustiveness scope amendment: it may add loud throwing placeholders to `Readonly<Record<...>>` tables outside its filesystem map, for that purpose only. Placeholders are getters, not IIFEs — an IIFE in an object literal evaluates at module load and would throw on import.
- `repository.ts` `expectedArtifactTypeForTurn` and `context-builder.ts` `capPayload` accept the session enum members with no compile error and were deliberately left unfixed; they belong to P7-02 and Phase 6. No build or test will surface them.
- Free-chat runs complete on unanimous `done` across one round, or `maxTurns`, or user stop. The signal is advisory and evaluated by backend code, so no Agent ends a run. The unanimity rule is proposed, not team-chosen, and must be confirmed before P6-01.
- The session extension is governed by `overview-sessions.md` (repository-local authority, adapted from the team's extension plan); `overview.md` remains the authority for the verified workflow and the shared engine semantics.
- Session contract code (additive types, contracts, fixtures) lands in Phase 5; session behavior (workflow, protocol, context, service create branch, walking skeleton) lands in Phase 6, mirroring the original Phase 0 and Phase 1 split.
- The session prompt never states the expected number; Agents derive it from the transcript and the countdown validator is the sole authority. Wrong numbers retry the same Agent and a second failure ends the run with `MAX_ATTEMPTS_EXCEEDED`.
- The session extension includes a second protocol, `free_chat`, on the same `shared_session_v1` workflow: bounded non-empty messages, completion on a unanimous `done` round, at `maxTurns` (default 6), or on user stop, no start value and no next-expected state. The middleware guarantees mechanics and never judges message substance.
- 2026-08-30 consolidation pass: the free-chat completion signal (unanimous `done`) and the final-artifact-pointer rule (last committed session message) were confirmed by the whole team. No new `CoordinationEventType` for `done`; it rides on committed artifacts. The Phase 6–9 sheets, `FILESYSTEM_MAP.md`, and the README source-of-truth order were synced so the docs match the frozen contract.

See [`ASSUMPTIONS_AND_DECISIONS.md`](./ASSUMPTIONS_AND_DECISIONS.md) for full rationale.

## How to update this file

After each work session:

1. change the audit date/commit;
2. record the task branch and base commit;
3. move task IDs only when their required evidence exists;
4. append Docker Compose verification results, including the final `npm run check` and failures;
5. update **Resume here** to the next one to three executable actions;
6. record clarified questions, deviations/mini-RFCs, and new risks;
7. never record secrets, raw prompts/output, or lease tokens.
