# Relay Development Status

**Last audit:** 2026-08-29 10:04:04 UTC
**Audited commit:** `d806e8f` (contracts frozen at `ea469b2`, tag `relay/contracts-v1`)
**Implementation branch:** `phase0-contract-freeze`
**Current phase:** Phase 1 — In-Memory Walking Skeleton (ready to start)
**Current gate:** Checkpoint 0 verified
**Overall state:** Phase 0 `complete`; all P0-01–P0-17 tasks and required evidence are complete

## Resume here

1. Create a new Phase 1 task branch from the completed Phase 0 checkpoint.
2. Review the Phase 1 filesystem map and begin **P1-01**, deterministic latest-artifact selectors.
3. Run focused checks through Docker Compose and retain the full repository check as the completion gate.

Do not connect Relay to real Agents until the Phase 2 correctness and race gates pass.

For all resumed work: create a new task branch first, consult `FILESYSTEM_MAP.md`, clarify uncertainties before acting, run every test through Docker Compose, and require a passing Docker Compose `npm run check` before marking implementation complete.

## Last checkpoint

Checkpoint 0 is complete. Commit `ea469b2`, tagged `relay/contracts-v1`, freezes the overview-aligned types and interfaces, removes the accidental events route, adds all Phase 0 module shells and shared deterministic testing controls/fixtures/fakes, and proves service construction. The authenticated manual baseline and three-Agent checks passed against Phase 0 HEAD `d806e8f` at 2026-08-29 10:04:04 UTC.

## Phase 0 task ledger

| Tasks | Status | Evidence |
|---|---|---|
| P0-01–P0-03 | `complete` | Compose reports Node `22.23.2`, npm `10.9.8`; clean lockfile install and full check pass. |
| P0-04–P0-05 | `complete` | User-performed authenticated checks passed for the full temporary-Agent lifecycle, one Playground turn, three fresh Agents, one ordinary turn each, readiness, persistence, and isolation. |
| P0-06–P0-10 | `complete` | Scope/ADRs reviewed; contracts corrected; extra endpoint removed; terminal stop semantics frozen with tests. |
| P0-11 | `complete` | Immutable commit `ea469b2`, tag `relay/contracts-v1`. |
| P0-12–P0-17 | `complete` | Module shells, deterministic kit, shared fixtures/fakes, scripted runtime, and construction test pass. |

## Implemented inventory

| Area | Evidence | Status | Notes |
|---|---|---|---|
| Domain model/default policy | `apps/server/src/coordination/types.ts` | `complete` | Frozen against overview Sections 7–8 at `relay/contracts-v1`. |
| Component contracts | `apps/server/src/coordination/contracts.ts` | `complete` | Frozen overview boundaries include repository/runtime/workflow/context/protocol/redaction/execution control. |
| Coordination error envelope | `coordination/errors.ts`, `app.ts` | `implemented_unverified` | `CoordinationError` receives structured API envelope. |
| Service create/list/detail | `coordination/service.ts` | `implemented_unverified` | Dependency injection, participant snapshots, defaults, and validations exist. |
| Background orchestration | `coordination/service.ts` | `implemented_unverified` | Scheduling, retries, runtime attachment, validation, commits, completion/failure, and local loop cleanup exist. |
| Stop handling | `coordination/service.ts` | `implemented_unverified` | Durable request, active-attempt cancellation, and finish-stop flow exist; terminal HTTP semantics are frozen, while race evidence remains Phase 1/2 work. |
| HTTP routes | `coordination/routes.ts`, `app.ts` | `complete` | Frozen list/create/detail/start/stop surface; accidental events route removed and tested as absent. |
| Phase 0 testing kit | `coordination/testing/**`, `construction.test.ts` | `complete` | Deterministic controls, full fixture pack, fakes, scripted runtime, and construction proof pass. |
| Service/API tests | `coordination/service.test.ts`, `coordination/routes.test.ts` | `implemented_unverified` | Existing orchestration is ahead of the gate; Phase 1 still needs exhaustive workflow/protocol evidence. |

## Outstanding by phase

### Phase 0

- Complete. No Phase 0 tasks remain.

### Phase 1

- Real pure workflow implementation and exhaustive table tests.
- Strict artifact schemas/parser/protocol and adversarial tests.
- Role-scoped context builder, digest, bounds, and leakage tests.
- Reusable scripted runtime with deferred/failure/timeout/cancel outcomes.
- Walking-skeleton tests using real workflow/protocol/context rather than test-local stubs.
- Full reject→revise path, timeout/retry, late result, and stop race evidence.

### Phase 2

- Database v2, explicit v1 migration, real repository, atomic leases/events, redaction, reservations, restart settlement, composition-root wiring, and race/API integration suites.

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

## Decision log summary

- Code enum/API spelling is `finalizer`; user-facing label is “Finaliser.”
- `AgentService` requires a new completion-handle seam; `sendMessage()` remains compatible.
- `JsonStore` requires explicit additive migration; there is no existing hook.
- Routes register through optional `createApp(..., coordination)`; real composition in `index.ts` is outstanding.
- Real latency/schema reliability are measured Phase 3 gates, not assumptions.
- Terminal stop is frozen as idempotent `202` with explicit completed/failed/stopped route tests.
- The detail route is the only event retrieval contract; the accidental `/events` endpoint was removed.
- Frozen contract commit is `ea469b2`, tagged `relay/contracts-v1`.

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
