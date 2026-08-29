# Relay Development Status

**Last audit:** 2026-08-29 UTC  
**Audited commit:** `3d24d1b` (`main`)  
**Documentation work branch:** `docs/development-workflow-rules`  
**Current phase:** Phase 0 — Baseline and Contract Freeze  
**Current gate:** Checkpoint 0 not yet verified  
**Overall state:** `in_progress`; some Phase 1 run-manager work is merged ahead of the gate

## Resume here

1. **P0-01:** switch to Node.js 22+ and npm 10+.
2. **P0-02/P0-03:** install from the lockfile and run `npm run check`; record actual results.
3. **P0-08/P0-09:** review the merged contract files against overview Sections 7–11 and resolve the extra `/events` endpoint.
4. **P0-12–P0-17:** add remaining module shells, shared deterministic fixtures/fakes, and the compile construction test.

Do not mark Checkpoint 0 complete or connect real Agents until these actions and the full Phase 0 gate pass.

For all resumed work: create a new task branch first, consult `FILESYSTEM_MAP.md`, clarify uncertainties before acting, run every test through Docker Compose, and require a passing Docker Compose `npm run check` before marking implementation complete.

## Last checkpoint

The latest repository checkpoint is merge commit `3d24d1b`, “Merge branch 'branch-coordination-run-manager-and-api'.” It adds the coordination domain/contracts, service/orchestration loop, routes, error mapping, and tests. This is a code merge, not a completed integration checkpoint under the implementation plan.

## Implemented inventory

| Area | Evidence | Status | Notes |
|---|---|---|---|
| Domain model/default policy | `apps/server/src/coordination/types.ts` | `implemented_unverified` | Matches the planned type family on static review; must be formally diffed/frozen. |
| Component contracts | `apps/server/src/coordination/contracts.ts` | `implemented_unverified` | Repository/runtime/workflow/context/protocol boundaries exist. |
| Coordination error envelope | `coordination/errors.ts`, `app.ts` | `implemented_unverified` | `CoordinationError` receives structured API envelope. |
| Service create/list/detail | `coordination/service.ts` | `implemented_unverified` | Dependency injection, participant snapshots, defaults, and validations exist. |
| Background orchestration | `coordination/service.ts` | `implemented_unverified` | Scheduling, retries, runtime attachment, validation, commits, completion/failure, and local loop cleanup exist. |
| Stop handling | `coordination/service.ts` | `implemented_unverified` | Durable request, active-attempt cancellation, and finish-stop flow exist; terminal status tests still needed. |
| HTTP routes | `coordination/routes.ts`, `app.ts` | `implemented_unverified` | List/create/detail/start/stop plus an extra non-contract events route. Registration seam exists. |
| Service/API tests | `coordination/service.test.ts`, `coordination/routes.test.ts` | `implemented_unverified` | In-file memory fakes cover some paths; they are not yet the shared Sprint 0 fixture pack. |

## Outstanding by phase

### Phase 0

- Environment baseline and successful `npm run check`.
- Manual baseline app and three fresh-Agent checks.
- Formal team review/freeze of scope, decisions, contracts, defaults, route semantics, and stop behavior.
- Resolve the extra `/api/coordination-runs/:id/events` route.
- Missing module shells for workflow, schemas/protocol, context, repository, runtime gateway, events, and redaction.
- Shared fixed clock/IDs, artifact fixtures, fake repository, scripted runtime, and compile construction test.
- Record the immutable `relay/contracts-v1` commit/tag.

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

## Known blockers and risks

| Item | Impact | Resolution |
|---|---|---|
| Node 18 instead of Node 22+ | Cannot install/verify the project in its supported environment; Playwright CLI also requires Node 20+. | Upgrade/switch Node before baseline verification. |
| Dependencies absent | `tsc` and tests cannot run. | Run `npm ci` after switching Node. |
| Shared ChatGPT context inaccessible in this environment | Possible decisions outside `overview.md` were not audited. | Copy any missing decisions into `ASSUMPTIONS_AND_DECISIONS.md`; overview remains current authority. |
| Code ahead of gates | Merged code can create false confidence about completion. | Retain `implemented_unverified` until required phase evidence passes. |
| Extra `/events` endpoint | API drift from frozen route table. | Remove it or approve/document it via mini-RFC before Checkpoint 0. |
| Current Agent cancellation is keyed by Agent ID | Could cancel unrelated later work after races. | Implement run-scoped cancellation in Phase 3 only after Phase 2 correctness gates. |

## Decision log summary

- Code enum/API spelling is `finalizer`; user-facing label is “Finaliser.”
- `AgentService` requires a new completion-handle seam; `sendMessage()` remains compatible.
- `JsonStore` requires explicit additive migration; there is no existing hook.
- Routes register through optional `createApp(..., coordination)`; real composition in `index.ts` is outstanding.
- Real latency/schema reliability are measured Phase 3 gates, not assumptions.
- Terminal stop is treated as idempotent in the current implementation, pending explicit freeze tests.

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
