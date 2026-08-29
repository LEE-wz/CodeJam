# Existing codebase index

This directory documents the implementation that exists in the repository as
of 2026-08-29. It is an implementation index for hackathon development: use it
to understand the supplied baseline before adding middleware or product
features.

The application is **Volc Agent Launchpad**, a single-user proof-of-concept for
creating coding Agents and chatting with them in persistent workspaces. A React
browser client calls a Fastify API. The API persists Agent, message, and Run
metadata in one JSON file and executes Codex either as a local child process or
in a disposable Docker/Podman container. Codex calls a Volcengine Ark endpoint
through the OpenAI-compatible Responses API.

## Start here

| Question | Document |
| --- | --- |
| What runs, and how is it connected? | [Architecture and runtime flows](architecture-and-flows.md) |
| Where is server behavior implemented? | [Backend reference](backend.md) |
| How does the browser behave? | [Frontend reference](frontend.md) |
| Which HTTP endpoints and payloads exist? | [API reference](api-reference.md) |
| Where are state, workspaces, configuration, and deployment defined? | [Runtime, storage, and operations](runtime-storage-and-operations.md) |
| What is the coordination code, and is it live? | [Coordination scaffold](coordination-scaffold.md) |
| Which file should I edit for a feature? | [File and change map](file-map.md) |
| What is tested, and where are extension seams? | [Testing and extension guide](testing-and-extension-guide.md) |

## Current implementation status

The supplied baseline currently provides:

- Agent create, read, update, delete, start, and stop operations.
- One active asynchronous Run per Agent.
- Persistent user/assistant conversation history and a resumable Codex thread.
- A generated, Agent-specific `AGENTS.md` in every workspace.
- Local-process and disposable-container Codex runtime adapters.
- Shared bearer-token protection for demo deployments.
- Development, local POC, Docker Compose, and Volcengine ECS/Terraform paths.
- Unit tests for storage, HTTP authentication/error handling, lifecycle
  concurrency, Codex protocol parsing, and the coordination service scaffold.

The repository also contains a **partially integrated coordination feature**
for Planner → Critic → Finalizer handoffs. Its types, interfaces, HTTP route
registration function, orchestration service, and tests exist. It is not
reachable in the running application because no concrete coordination
repository/workflow/context/protocol/runtime implementations are composed in
`apps/server/src/index.ts`, the optional service is not passed to `createApp`,
and the web application has no coordination client or views.

## Important operating assumptions

- This is a single-node, single-process POC, not a multi-tenant platform.
- `JsonStore` is safe only for one server process and rewrites the whole JSON
  database for each mutation.
- The shared token is access gating, not user identity or authorization.
- In local POC mode, a disposable container is created per turn, while the
  selected Agent workspace and the shared Codex home are bind-mounted.
- In Docker/ECS mode, Codex runs as a child process inside the application
  container; there is no separate per-Agent container boundary.
- The model key is available to the server and the active runtime. Do not use
  production data or credentials.
- Deleting an Agent removes its metadata and conversation but archives, rather
  than deletes, its workspace under `workspaces/.deleted/`.

## Primary entry points

| Entry point | Purpose |
| --- | --- |
| `npm run dev` | Starts the Fastify server in watch mode and the Vite dev server. |
| `npm run poc` | Builds the disposable Runtime image and starts a production build locally. |
| `npm run build` | Builds the web client first, then compiles the server. |
| `npm start` | Runs `apps/server/dist/index.js`; it also serves the built web client in production. |
| `apps/server/src/index.ts` | Server composition root and process entry point. |
| `apps/web/src/main.tsx` | Browser entry point. |
| `scripts/start-local-poc.sh` | Local Docker/Colima/Podman orchestration entry point. |
| `docker-compose.yml` | Application-container deployment entry point. |
| `deploy/volcengine/main.tf` | Full Volcengine infrastructure entry point. |

## Terminology

- **Agent**: stored configuration, lifecycle state, workspace path, and Codex
  thread ID.
- **Run**: one submitted prompt and its asynchronous execution state.
- **Message**: a persisted user prompt or final assistant response tied to a
  Run.
- **workspace**: persistent Agent-owned directory in which Codex reads, writes,
  and executes.
- **Codex home**: configuration and session storage used to resume threads.
- **Runtime provider**: either the local child-process runner or disposable
  container runner.
- **coordination run**: currently dormant extension-domain state for a
  multi-Agent verified-handoff workflow; it is distinct from an `AgentRun`.
