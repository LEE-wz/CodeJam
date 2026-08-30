# Relay Development Status

**Last audit:** 2026-08-30 05:18 UTC
**Audited base:** `e899b52` (the `pre-phase4-cleanup` tip)
**Implementation branch:** `phase-4` (base `e899b52`)
**Current phase:** Phase 4 — complete
**Current gate:** Checkpoint 4 verified
**Overall state:** Phases 0–4 `complete`; Phase 5 not started

## Resume here

**Phase 4 is complete and Checkpoint 4 is verified.** Relay is integrated into
the existing web app: users can configure three distinct ready Agents, create
and explicitly start a run, observe ordered evidence and artifacts, stop active
runs, and understand terminal outcomes without reading server logs.

| Phase 4 gate condition | Evidence |
|---|---|
| Client contracts and create flow | Web-owned response types and list/create/detail/start/stop calls reuse existing bearer and structured-error behavior; the form validates role uniqueness, readiness, section keys, limits, and policy ranges while preserving input |
| Evidence experience | Run metadata, role mappings, events grouped by turn, nested attempts, retries/revisions, and escaped proposal/review/final artifacts render for all seven fixture scenarios |
| Polling and stop | One 1.5-second request chain cleans up on terminal state, selection change, and unmount; stop has pending/disabled state; a browser-discovered post-start polling defect has a regression test |
| Accessibility and responsive layout | Associated labels, error focus, meaningful terminal/status text, keyboard operation, and narrow layout passed; 390-pixel audit found no horizontal overflow or unlabeled inputs |
| Real browser evidence | Disposable Compose completed one real three-role run and one real stop flow; completion reached 15 events and the stop flow displayed cancellation and stale-result evidence |
| Full regression gate | Docker Compose `npm run check` passed: 21 server files / 377 tests, 2 web files / 12 tests, and both builds (389 tests total) |

`P5-01` is the next task ID. Phase 5 should freeze the demo scope, prepare the
documentation and templates, rehearse the submission flow and fallback, then
perform the dependency/security and clean-release checks. The optional
`relay/contracts-v1` convenience tag remains a release-time decision; immutable
commit `ea469b2` already satisfies P0-11.

For all resumed work: create a new task branch first, consult `FILESYSTEM_MAP.md`, clarify uncertainties before acting, run every test through Docker Compose, and require a passing Docker Compose `npm run check` before marking implementation complete.

## Defects found in Phase 2

| Defect | How it was found | Resolution |
|---|---|---|
| Production 404s bypassed the frozen `ApiErrorResponse` envelope | Booting the real composition root (P2-17) returned `{"statusCode":404,"code":"NOT_FOUND","error":"Not Found",...}` where the injection tests returned `{"error":{"code":"NOT_FOUND",...}}`. Fastify's not-found context captures whichever error handler is installed when `setNotFoundHandler` runs, and `app.ts` registered the not-found handler **before** `setErrorHandler`. Only `NODE_ENV=production` registers a not-found handler, so no test-mode check could ever have caught it. | `setErrorHandler` now runs before the production static/not-found block, with a comment recording why the order matters. A regression test builds the app in production mode and asserts the frozen envelope; it provides a minimal web bundle when the real one has not been built yet and removes only what it created. |
| Unexpected `500` leaked arbitrary exception messages to responses and logs | Phase 2 review injected a credential-bearing connection string; the test checked only for stack/path leakage and therefore passed while the message remained exposed. | The handler logs only error classification and returns a fixed `INTERNAL_ERROR` message. Tests assert credential material is absent; runtime redaction also covers credential-bearing connection URLs. |

## Outstanding decisions

| Item | Status | Deadline |
|---|---|---|
| Dependency audit findings | Open: `npm ci` reports 1 moderate and 5 high findings. | P5-16 security/release review; do not apply breaking upgrades mid-phase. |
| Optional contract tag is absent | The accepted contract is immutably recorded as `ea469b2`, but neither the local nor remote repository has `relay/contracts-v1`. | Decide before release whether to create/push the convenience tag; no tag was created during cleanup. |

## Last checkpoint

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

- Not started. `P5-01` is next: product documentation set, README integration,
  Agent/demo templates, rehearsal/fallback, clean release verification,
  security inspection, and submission commit.

## Verification log

| Date | Commit | Check | Result |
|---|---|---|---|
| 2026-08-30 05:18 UTC | `phase-4` working tree | Phase 4 final Docker Compose `npm run check` | **Passed (exit code 0):** server/web typechecks, 21 server test files with 377 tests, 2 web test files with 12 tests, web build, and server build. `npm ci` continues to report 1 moderate and 5 high findings deferred to P5-16. |
| 2026-08-30 05:05–05:16 UTC | `phase-4` working tree | Phase 4 real browser completion, stop, accessibility, and responsive evidence | **Passed:** a disposable Compose deployment completed a real Planner → Critic → Finaliser run while the UI advanced automatically to 15 events and all three artifacts. A second run stopped as `STOPPED_BY_USER` with request/cancel/stopped/stale evidence. Layout passed at 1440×900 and 390×844; the narrow audit found no horizontal overflow or unlabeled inputs. The initial live flow exposed a post-start polling reset defect; an explicit polling epoch fixed it and a regression test now proves detail polling resumes after start. |
| 2026-08-30 04:51 UTC | `pre-phase4-cleanup` working tree | Phase 4 preflight Docker Compose image build and full `npm run check` | **Passed (exit code 0):** server/web typechecks, 21 server test files with 377 tests, web build, and server build. The new three-test fixture suite covers all seven required UI scenarios, gapless evidence, consistent run IDs, and forbidden capability/secret strings. `npm ci` continues to report 1 moderate and 5 high findings deferred to P5-16. |
| 2026-08-30 03:36 UTC | `phase3-p3-01-real-runtime` working tree | Initial P3-01–P3-13 focused Compose suites | **Failed:** 84/85 tests passed; the scoped-cancellation test attempted to resolve the second deferred runner before it had started. The deterministic test waited for runner admission before resolving it; no product assertion was weakened. |
| 2026-08-30 03:38 UTC | `phase3-p3-01-real-runtime` working tree | P3-01–P3-13 focused Compose typecheck and tests | **Passed:** server typecheck plus 15 tests — eight AgentService regressions, six runtime gateway race/cleanup tests, and one complete three-role real-boundary integration test. |
| 2026-08-30 03:39 UTC | `phase3-p3-01-real-runtime` working tree | Phase 3 full Docker Compose `npm run check` | **Passed (exit code 0):** server/web typechecks, 20 server test files with 373 tests, web build, and server build. `npm ci` continues to report 1 moderate and 5 high findings deferred to P5-16. |
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
| 2026-08-30 02:25 UTC | `phase2-p2-08-durable-repository` | P2-08–P2-14/P2-20/P2-21 final scoped Docker Compose `npm run check` | **Passed (exit code 0):** server/web typechecks, 17 server test files with 336 tests, web build, and server build. `npm ci` continues to report 1 moderate and 5 high audit findings held for release review (P5-16). Sole completion evidence for these tasks. |
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
