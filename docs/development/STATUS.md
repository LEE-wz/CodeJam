# Relay Development Status

**Last audit:** 2026-08-30 02:17 UTC
**Audited commit:** `d81635a` (contracts frozen at `ea469b2`, amended by the approved P1-01 and P1-05 mini-RFCs)
**Implementation branch:** `phase2-p2-05-events-redaction` (chained from `phase2-p2-01-database-v2`, base `d81635a` on `main`)
**Current phase:** Phase 2 — Durable Backend and Evidence Ledger (in progress)
**Current gate:** Checkpoint 2 (not reached)
**Overall state:** Phase 0 `complete`; Phase 1 `complete`; Phase 2 authorised and started

## Resume here

Phase 2 is authorised and under way. All three Phase 1 exit gates are closed:

1. **Nine Phase 1 implementation decisions confirmed** unchanged by the user on
   2026-08-30, including `sizeChars`.
2. **Integration branch already at the Phase 1 tip.** `main` (`d81635a`) is
   content-identical to the verified tip `f1be1b7`; `git diff f1be1b7 d81635a`
   is empty. No fast-forward was needed.
3. **Phase 2 signed off** by the user on 2026-08-30.

The four open handoff decisions (§1.1, §1.2, §1.3, §2.1) were also answered
before P2-01 and are recorded in
[`ASSUMPTIONS_AND_DECISIONS.md`](./ASSUMPTIONS_AND_DECISIONS.md) under
**Phase 2 handoff decisions**. None required a mini-RFC.

Next executable actions:

1. **P2-08/P2-09** — the durable repository's deterministic read model
   (newest-first, cap 50, sorted detail) and the atomic
   create/start/schedule/begin-attempt commands, each in one `JsonStore.mutate()`.
   Use `testing/memory-repository.ts` as the accept/reject specification.
2. **P2-10–P2-13** — lease-scoped correlation, commit, and terminal commands.
3. **P2-14** — the race suite, driven by the scripted runtime's deferred
   promises rather than sleeps.

Still open, by design: handoff §2.2 (`PromptEnvelope.includedArtifactIds`) is
decided at P2-09; it does not affect persisted shape.

Do not connect Relay to real Agents until the Phase 2 correctness and race gates pass.

For all resumed work: create a new task branch first, consult `FILESYSTEM_MAP.md`, clarify uncertainties before acting, run every test through Docker Compose, and require a passing Docker Compose `npm run check` before marking implementation complete.

## Last checkpoint

Checkpoint 1 is complete. The real workflow, artifact protocol, and role-scoped
context builder drive the real `CoordinationService` against an in-memory
repository and a scripted runtime, with no disk, HTTP server, timer, or model
call in any automated test. The full Docker Compose `npm run check` passed on the
Phase 1 tip: server and web typechecks, 14 server test files with 237 tests, web
build, and server build.

Checkpoint 0 remains as recorded: commit `ea469b2`, tagged `relay/contracts-v1`,
froze the overview-aligned types and interfaces.

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
| P0-11 | `complete` | Immutable commit `ea469b2`, tag `relay/contracts-v1`. |
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
| P2-08–P2-18, P2-20–P2-22 | `not_started` | — |
| P2-19 | `complete` (verify-only) | Confirmed as the handoff predicted: `routes.test.ts` asserts `GET /api/coordination-runs/:id/events` returns `404`. No implementation was required. |

## Implemented inventory

| Area | Evidence | Status | Notes |
|---|---|---|---|
| Domain model/default policy | `apps/server/src/coordination/types.ts` | `complete` | Frozen against overview Sections 7–8 at `relay/contracts-v1`. |
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

## Outstanding by phase

### Phase 0

- Complete. No Phase 0 tasks remain.

### Phase 1

- Complete. No Phase 1 tasks remain. Four contract behaviours are carried into
  Phase 2; see **Phase 1 handoff to Phase 2** above.

### Phase 2

- Database v2 and explicit v1 migration are **done** (P2-01–P2-04). P2-19 is
  verified as already satisfied.
- Event factories and redaction are **done** (P2-05–P2-07).
- Remaining: the real atomic
  repository and its race suite (P2-08–P2-14), API validation/injection tests
  and composition wiring (P2-15–P2-18), and restart settlement plus the
  reservation helper and evidence-timeline check (P2-20–P2-22).

### Phase 3

- Backward-compatible Agent execution handle, correlated run cancellation, reservation enforcement, real runtime gateway, timeout settlement, real smoke flow, and timing evidence.

### Phase 4

- Web types/API, create form, run detail/timeline/artifacts, polling/stop, accessibility/responsiveness, and real browser verification.

### Phase 5

- Product documentation set, README integration, Agent/demo templates, rehearsal/fallback, clean release verification, security inspection, and submission commit.

## Verification log

| Date | Commit | Check | Result |
|---|---|---|---|
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
| Current Agent cancellation is keyed by Agent ID | Could cancel unrelated later work after races. | Implement run-scoped cancellation in Phase 3 only after Phase 2 correctness gates. |
| ~~Docker unreachable from the environment used for P1-07–P1-17~~ | Resolved. The gate was run on a host with Docker and passed; the tasks were promoted on that evidence. | Closed 2026-08-29. Any future assistant-run work must route the gate to a host with a container engine rather than substituting a host runner. |
| ~~Phase 1 implementation decisions not yet confirmed~~ | Resolved. All nine were confirmed unchanged on 2026-08-30 before P2-01, together with the four Phase 2 handoff decisions. | Closed 2026-08-30. |
| `stale_ignored` attempt status has no producer | By the confirmed §2.1 decision, evidence lives in the `attempt.stale_ignored` event, so the `CoordinationAttemptStatus` member stays unwritten. Phase 4 must read it from the event stream, not the attempt row. | Accepted. Revisit only if the Phase 4 timeline cannot render it from events. |

## Decision log summary

- Code enum/API spelling is `finalizer`; user-facing label is “Finaliser.”
- `AgentService` requires a new completion-handle seam; `sendMessage()` remains compatible.
- `JsonStore` requires explicit additive migration; there is no existing hook.
- Routes register through optional `createApp(..., coordination)`; real composition in `index.ts` is outstanding.
- Real latency/schema reliability are measured Phase 3 gates, not assumptions.
- Terminal stop is frozen as idempotent `202` with explicit completed/failed/stopped route tests.
- The detail route is the only event retrieval contract; the accidental `/events` endpoint was removed.
- Frozen contract commit is `ea469b2`, tagged `relay/contracts-v1`.
- Approved P1-01 mini-RFC adds committed turns to `WorkflowView`; selectors order by `turn.sequence`, never artifact array position or timestamps.
- Approved P1-05 mini-RFC freezes numeric artifact field/array limits while retaining the separate raw-output cap for P1-06.
- Nine Phase 1 implementation decisions are recorded in `ASSUMPTIONS_AND_DECISIONS.md`; they change no frozen type, route, or persisted shape, and were confirmed unchanged on 2026-08-30.
- Four Phase 2 handoff decisions settled on 2026-08-30: `sizeChars` stays the raw-output length; `truncated` is an `attempt.started` event detail only; `outputDigest` is populated at commit; `attempt.stale_ignored` is emitted as an event without extending the `finishAttempt` status union. None is a mini-RFC.
- `DatabaseV2` migration is additive by spread, so unknown fields in an existing v1 file are preserved rather than dropped.

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
