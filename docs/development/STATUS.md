# Relay Development Status

**Last audit:** 2026-08-29 UTC  
**Audited commit:** `ea469b2` (`relay/contracts-v1`)
**Implementation branch:** `phase0-contract-freeze`
**Current phase:** Phase 0 — Baseline and Contract Freeze  
**Current gate:** Checkpoint 0 blocked only on manual baseline/demo-Agent evidence
**Overall state:** `in_progress`; contract/scaffolding implementation is verified, P0-04/P0-05 remain blocked

## Resume here

1. Obtain authorized access to the running app without copying credentials into commands or documentation.
2. **P0-04:** manually verify Agent list/create/edit/start/stop/delete and one Playground turn.
3. **P0-05:** create three fresh demo Agents and verify one ordinary turn for each, then record only redacted pass/fail evidence.

Do not mark Checkpoint 0 complete or connect real Agents until these actions and the full Phase 0 gate pass.

For all resumed work: create a new task branch first, consult `FILESYSTEM_MAP.md`, clarify uncertainties before acting, run every test through Docker Compose, and require a passing Docker Compose `npm run check` before marking implementation complete.

## Last checkpoint

The accepted contract checkpoint is commit `ea469b2`, tagged `relay/contracts-v1`. It freezes the overview-aligned types and interfaces, removes the accidental events route, adds all Phase 0 module shells and shared deterministic testing controls/fixtures/fakes, and proves service construction. This is not Checkpoint 0 completion until P0-04/P0-05 pass.

## Phase 0 task ledger

| Tasks | Status | Evidence |
|---|---|---|
| P0-01–P0-03 | `complete` | Compose reports Node `22.23.2`, npm `10.9.8`; clean lockfile install and full check pass. |
| P0-04–P0-05 | `blocked` | Live service is healthy but requires an undisclosed auth token; real turns require authorized model configuration. Browser runner also lacks Chrome. |
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

- Manual baseline application lifecycle and Playground-turn check (P0-04).
- Three fresh demo Agents with one ordinary real turn each (P0-05).

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

## Known blockers and risks

| Item | Impact | Resolution |
|---|---|---|
| Manual app authentication unavailable | P0-04/P0-05 cannot exercise protected APIs without disclosing or bypassing the configured token. | User supplies an authorized browser session or performs the checklist and returns redacted evidence. |
| Model credentials unavailable to this session | A real Playground turn and three demo-Agent turns cannot be proven. | Run with authorized scoped Ark configuration; never copy keys or raw output into status docs. |
| Browser runtime lacks Chrome | Playwright UI smoke could not start even though its CLI wrapper is available. | Install Chrome for Playwright or use an already-authorized manual browser. |
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
