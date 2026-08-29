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

## Phase 5 — Documentation and release

**Primary paths**

- `README.md`
- `docs/development/**`
- Relay documentation files named by the Phase 5 guide
- `docs/assets/` for finalized approved screenshots
- package/Compose/Docker files needed to verify documented commands

**Conditional paths**

- implementation files referenced by documentation, read only to verify exact current behavior
- deployment files only when deployment validation is explicitly in submission scope

Do not perform broad source reviews during release documentation. If documentation reveals an implementation defect, record it in `STATUS.md` and return to the appropriate phase/task rather than editing unrelated code opportunistically.

## Always excluded unless explicitly authorized

- `.git/**` internals (ordinary Git commands are allowed)
- `node_modules/**`, `dist/**`, coverage output, caches, and generated build artifacts
- `.env`, `.env.production`, private keys, tokens, credentials, and secret-bearing logs
- `data/**`, `.data/**`, `.local/**`, `workspaces/**`, and `codex-home/**`
- Terraform state and deployment secrets
- unrelated XML/assets, archived workspaces, or another developer's temporary files

If a test or runtime command generates these paths, do not read their contents unless the current test explicitly requires a safe temporary fixture.

