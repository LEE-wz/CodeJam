# Relay Filesystem Access Map

Use this map before every repository access. Its purpose is to keep each task scoped, reduce accidental coupling, and prevent reading or modifying unrelated files and folders.

## Access procedure

1. Read `STATUS.md` and identify the current phase and task ID.
2. Find the matching task area below.
3. Access the **primary paths** first.
4. Access a **conditional path** only when a direct import, test failure, or documented dependency requires it.
5. If a needed path is not mapped, stop and ask for clarification before accessing it. After approval, update this map or record the one-time exception in `STATUS.md`.
6. Never recursively inspect the whole repository when the mapped paths are sufficient.

Reading a direct dependency is allowed only far enough to understand the contract being used. It does not authorize unrelated edits.

## Repository-level files

| Path | Purpose | Access when |
|---|---|---|
| `docs/development/README.md` | Mandatory development procedure | Start and end of every task |
| `docs/development/STATUS.md` | Current phase, checkpoint, evidence, next action | Start and end of every task |
| `docs/development/overview.md` | Product plan and frozen contracts | Contract or phase behavior must be confirmed |
| `docs/development/overview-sessions.md` | Shared-session workflow contract authority | Session phase contract or behavior must be confirmed |
| `docs/development/ASSUMPTIONS_AND_DECISIONS.md` | Resolved questions and deviations | A prior decision or ambiguity is relevant |
| `docs/development/PHASE_2_HANDOFF.md` | Decisions and constraints carried out of Phase 1 | Start of Phase 2, and before any mini-RFC affecting `DatabaseV2` |
| `docs/development/phases/<current-phase>.md` | Current instruction sheet | Every task; do not open later phases without a need |
| `package.json`, `package-lock.json`, `apps/*/package.json` | Scripts and dependency contracts | Verification/dependency work |
| `docker-compose.yml`, `Dockerfile`, `.dockerignore` | Required Compose verification/runtime | Compose testing, build, or runtime work |
| `.env.example` | Supported configuration names | Configuration documentation or composition work |

Do not open `.env`, `.env.production`, credential files, runtime data, or secret-bearing logs for ordinary development. Use `.env.example` to understand supported configuration. If diagnosis genuinely requires secret-bearing state, ask first and avoid displaying values.

## Phase 0 — Contracts and scaffolding

**Primary paths**

- `docs/development/**`
- `apps/server/src/coordination/types.ts`
- `apps/server/src/coordination/contracts.ts`
- `apps/server/src/coordination/testing/**`
- new empty/minimal modules directly named by the Phase 0 guide

**Conditional paths**

- `apps/server/src/types.ts` and `apps/server/src/store.ts` to confirm existing v1 types only
- `apps/server/src/agent-service.ts` to confirm the execution boundary only
- `apps/server/src/app.ts` and `apps/server/src/index.ts` to confirm registration/composition seams only
- existing coordination tests for contract compatibility

Do not inspect web UI, deployment, Terraform, runtime-provider implementations, workspaces, or generated data during contract scaffolding unless a specific contract question requires them and the user confirms access.

## Phase 1 — Workflow, protocol, context, and in-memory service

**Primary paths**

- `apps/server/src/coordination/workflow.ts`
- `apps/server/src/coordination/schemas.ts`
- `apps/server/src/coordination/artifact-protocol.ts`
- `apps/server/src/coordination/context-builder.ts`
- `apps/server/src/coordination/service.ts`
- `apps/server/src/coordination/testing/**`
- matching `*.test.ts` files
- frozen coordination types/contracts as read-only references

**Conditional paths**

- `apps/server/tsconfig.json`, root TypeScript config, and package files when compilation requires them
- `apps/server/src/coordination/errors.ts` for safe error mapping

Do not access the real store, runtime providers, `AgentService`, web app, deployment folders, or user runtime data in this phase.

## Phase 2 — Persistence, events, API, and composition

**Primary paths**

- `apps/server/src/store.ts`, `apps/server/src/store.test.ts`
- `apps/server/src/types.ts`
- `apps/server/src/coordination/repository.ts`
- `apps/server/src/coordination/events.ts`
- `apps/server/src/coordination/redaction.ts`
- `apps/server/src/coordination/routes.ts`
- `apps/server/src/coordination/service.ts`
- `apps/server/src/app.ts`, `apps/server/src/index.ts`
- matching test fixtures and `*.test.ts` files

**Conditional paths**

- `apps/server/src/agent-service.ts` only for the reservation interface boundary; the Phase 3 refactor is out of scope
- `apps/server/src/config.ts` only when real composition requires configuration

Use temporary test directories for persistence tests. Do not open or mutate real `data/`, `.local/`, `workspaces/`, or `codex-home/` content.

## Phase 3 — AgentService and runtime gateway

**Primary paths**

- `apps/server/src/agent-service.ts` and its tests
- `apps/server/src/types.ts`
- `apps/server/src/coordination/runtime-gateway.ts`
- `apps/server/src/coordination/contracts.ts`
- `apps/server/src/coordination/repository.ts` reservation/correlation interface only
- matching runtime tests and test controls

**Conditional paths**

- `apps/server/src/codex-runner.ts`
- `apps/server/src/container-codex-runner.ts`
- `apps/server/src/runner-factory.ts`
- `apps/server/src/errors.ts`, `config.ts`, and `index.ts`

Only inspect provider/runtime files when a direct `AgentService` or `AgentRunner` contract requires it. Relay must not bypass `AgentService`. Do not inspect Agent-created workspace contents or Codex session data during ordinary implementation.

## Phase 4 — Web UI and evidence experience

**Primary paths**

- `apps/web/src/coordination-types.ts`
- `apps/web/src/coordination-api.ts`
- coordination UI components/tests under `apps/web/src/`
- `apps/web/src/App.tsx`, `api.ts`, `types.ts`, and `styles.css`
- redacted coordination API fixtures

**Conditional paths**

- server coordination types/routes as read-only API references
- `apps/web/package.json`, TypeScript/Vite configuration
- `docs/assets/` only when capturing approved final assets

Do not inspect repository/store internals, runtime providers, deployment files, or real persisted run data for UI implementation. Use redacted fixtures or the documented API.

## Phase 5 — Session contracts

**Primary paths**

- `docs/development/overview-sessions.md`
- `docs/development/**`
- `apps/server/src/coordination/types.ts`
- `apps/server/src/coordination/contracts.ts`
- `apps/server/src/coordination/testing/**`
- new empty/minimal session modules directly named by the Phase 5 guide

**Recorded amendment exception (Phase 5 only):** the loud-placeholder edits in
`context-builder.ts` (four tables), `events.ts` (two labels),
`artifact-protocol.ts` (`EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND`), and
`workflow.ts` (verified-state guard). Placeholders are getters that throw with
the task ID that replaces them; Phase 6 replaces them with real behavior.

**Conditional paths**

- `apps/server/src/types.ts` and `apps/server/src/store.ts` to confirm existing v1/v2 types only
- `apps/server/src/agent-service.ts` to confirm the execution boundary only
- existing coordination tests for contract compatibility

Do not implement session behavior in this phase. Contracts and fixtures only. Do not inspect web UI, deployment, runtime-provider implementations, workspaces, or generated data.

## Phase 6 — Session workflow, protocol, context (in memory)

**Primary paths**

- `apps/server/src/coordination/session-workflow.ts` (exists as the Phase 5 throwing shell; P6-01 replaces it with real routing)
- `apps/server/src/coordination/workflow.ts` (dispatch only)
- `apps/server/src/coordination/schemas.ts`
- `apps/server/src/coordination/artifact-protocol.ts`
- `apps/server/src/coordination/context-builder.ts`
- `apps/server/src/coordination/service.ts`
- `apps/server/src/coordination/testing/**`
- matching `*.test.ts` files
- frozen coordination types/contracts as read-only references

**Conditional paths**

- `apps/server/tsconfig.json`, root TypeScript config, and package files when compilation requires them
- `apps/server/src/coordination/errors.ts` for safe error mapping

Do not access the real store, runtime providers, `AgentService`, web app, deployment folders, or user runtime data in this phase.

## Phase 7 — Session persistence, API, and composition

**Primary paths**

- `apps/server/src/coordination/repository.ts`
- `apps/server/src/coordination/routes.ts`
- `apps/server/src/coordination/service.ts`
- `apps/server/src/app.ts`, `apps/server/src/index.ts`
- `apps/server/src/coordination/events.ts` only where a session event detail requires an allowlisted addition
- matching test fixtures and `*.test.ts` files

**Conditional paths**

- `apps/server/src/store.ts`, `apps/server/src/types.ts` only to confirm the existing v2 shape
- `apps/server/src/agent-service.ts` only for the reservation interface boundary; no execution seam changes

Use temporary test directories for persistence tests. Do not open or mutate real `data/`, `.local/`, `workspaces/`, or `codex-home/` content.

## Phase 8 — Session UI and real rehearsal

**Primary paths**

- `apps/web/src/coordination-types.ts`
- `apps/web/src/coordination-api.ts`
- coordination UI components/tests under `apps/web/src/`
- `apps/web/src/App.tsx`, `api.ts`, `types.ts`, and `styles.css`
- redacted coordination API fixtures, including session fixtures

**Conditional paths**

- server coordination types/routes as read-only API references
- `apps/web/package.json`, TypeScript/Vite configuration
- `docs/assets/` only when capturing approved final assets

Do not inspect repository/store internals, runtime providers, deployment files, or real persisted run data for UI implementation. Use redacted fixtures or the documented API.

## Phase 9 — Documentation and release

**Primary paths**

- `README.md`
- `docs/development/**`
- Relay documentation files named by the Phase 9 guide
- `docs/assets/` for finalized approved screenshots
- package/Compose/Docker files needed to verify documented commands

**Conditional paths**

- implementation files referenced by documentation, read only to verify exact current behavior
- deployment files only when deployment validation is explicitly in submission scope

Do not perform broad source reviews during release documentation. If documentation reveals an implementation defect, record it in `STATUS.md` and return to the appropriate phase/task rather than editing unrelated code opportunistically.

## Phase 10 — Session v2 surface, limits, and rename

**Primary paths**

- `docs/development/ASSUMPTIONS_AND_DECISIONS.md`, `overview-sessions.md`, `FILESYSTEM_MAP.md`, `STATUS.md`
- `apps/web/src/` session UI, types, fixtures, styles, and tests
- `apps/server/src/coordination/types.ts` (limits only)
- `apps/server/src/coordination/routes.ts` and `service.ts` (session validation ranges only)
- `apps/server/src/coordination/context-builder.ts` (session transcript window only)
- matching `*.test.ts` files

**Conditional paths**

- `apps/server/src/coordination/session-workflow.ts` only to confirm it reads `SESSION_LIMITS` rather than literals
- `apps/server/src/config.ts` when the session context budget becomes configurable
- server fixtures under `apps/server/src/coordination/testing/` that pin a session limit

No workflow, protocol, or repository behaviour is deleted in this phase. Do not open the countdown engine branches except to confirm they still compile and pass.

## Phase 11 — Lifecycle reconciliation and Agent recovery

**Primary paths**

- `apps/server/src/coordination/service.ts`
- `apps/server/src/coordination/repository.ts`
- `apps/server/src/coordination/events.ts`, `redaction.ts`, `types.ts` (additive error code and event)
- `apps/server/src/agent-service.ts` (reservation reads only)
- `apps/server/src/index.ts` (reconciler composition)
- matching `*.test.ts` files and `coordination/testing/**`

**Conditional paths**

- `apps/web/src/` only for the Agent recovery affordance and the reservation message
- `apps/server/src/config.ts` for the sweep interval

Do not change the execution seam in `AgentService.startExecution`. Reconciliation reads and settles durable state; it never bypasses the repository.

## Phase 12 — Durable multi-prompt sessions

**Primary paths**

- `apps/server/src/coordination/types.ts`, `contracts.ts`, `schemas.ts`
- `apps/server/src/coordination/repository.ts`, `service.ts`, `routes.ts`, `session-workflow.ts`, `context-builder.ts`, `artifact-protocol.ts`, `events.ts`, `redaction.ts`
- `apps/web/src/` session chat surface, API client, types, fixtures, and tests
- matching `*.test.ts` files and `coordination/testing/**`

**Conditional paths**

- `apps/server/src/store.ts` and `apps/server/src/types.ts` only to confirm the v2 shape absorbs the additive fields
- `apps/server/src/app.ts` for route registration

Use temporary directories for persistence tests. Do not open or mutate real `data/`, `workspaces/`, or `codex-home/` content.

## Phase 13 — Parallel waves

**Primary paths**

- `apps/server/src/coordination/types.ts`, `contracts.ts`
- `apps/server/src/coordination/repository.ts` (batch schedule and per-turn settlement)
- `apps/server/src/coordination/service.ts` (wave supervisor)
- `apps/server/src/coordination/session-workflow.ts` (concurrent-history validation)
- `apps/server/src/coordination/routes.ts` (concurrency policy)
- matching `*.test.ts` files and `coordination/testing/**`

**Conditional paths**

- `apps/server/src/coordination/runtime-gateway.ts` and `apps/server/src/agent-service.ts` only for the busy-Agent contention path and, on the auction track, the `PA13-09` execution thread policy at the same boundary (recorded in `ASSUMPTIONS_AND_DECISIONS.md`)
- `apps/web/src/` only for wave-aware transcript and status rendering

Do not modify `workflow.ts`. Verified handoff must keep scheduling exactly one turn at a time, proven by its unmodified regression matrix.

## Phase 14 — Coordinator planning and countdown removal

**Primary paths**

- `apps/server/src/coordination/schemas.ts`, `artifact-protocol.ts`, `session-workflow.ts`, `context-builder.ts`, `types.ts`, `routes.ts`, `service.ts`
- `apps/server/src/coordination/repository.ts` only for the countdown deletion
- `apps/web/src/` for the planning policy control and countdown remnants
- matching `*.test.ts` files, `coordination/testing/**`, and `apps/web/src/testing/**`

**Conditional paths**

- `docs/development/overview-sessions.md` and `ASSUMPTIONS_AND_DECISIONS.md` for the amendment record
- `apps/server/src/coordination/workflow.ts` only for the mechanical
  `session_bid: undefined` exhaustiveness entry; verified-handoff decisions
  remain unchanged

Countdown deletion applies to the engine only. Stored history keeps its fields, and a fixture test proves a pre-existing countdown run still loads and renders.

## Phase 15 — Scale, storage, and release

**Primary paths**

- `README.md`, `docs/development/**`, and the Session v2 documentation set named by the Phase 15 guide
- a temporary scale-measurement harness and its output
- `apps/server/src/store.ts` and `apps/server/src/coordination/repository.ts` only if the storage swap is approved
- package/Compose/Docker files needed to verify documented commands

**Conditional paths**

- implementation files referenced by documentation, read only to verify exact current behaviour
- deployment files only when deployment validation is in submission scope

Run the scale harness against temporary directories only. Never measure against real `data/` content, and never publish an unmeasured scale claim.

## Always excluded unless explicitly authorized

- `.git/**` internals (ordinary Git commands are allowed)
- `node_modules/**`, `dist/**`, coverage output, caches, and generated build artifacts
- `.env`, `.env.production`, private keys, tokens, credentials, and secret-bearing logs
- `data/**`, `.data/**`, `.local/**`, `workspaces/**`, and `codex-home/**`
- Terraform state and deployment secrets
- unrelated XML/assets, archived workspaces, or another developer's temporary files

If a test or runtime command generates these paths, do not read their contents unless the current test explicitly requires a safe temporary fixture.
