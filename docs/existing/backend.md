# Backend reference

## Module responsibilities

### `index.ts`: composition root

Constructs all live server dependencies and starts Fastify. This is the file to
edit when adding a new service that must exist at runtime. At present it
constructs only the baseline Agent stack; it does not instantiate or register
the coordination service.

### `config.ts`: environment contract

`loadConfig()` is the single source of truth for environment parsing, defaults,
path resolution, and production auth-token enforcement. In a production server
bound beyond loopback, `APP_AUTH_TOKEN` must contain at least 24 characters and
must not begin with `replace-`.

`isArkConfigured()` rejects missing and obvious placeholder Ark values.
`writeCodexConfig()` overwrites `CODEX_HOME/config.toml` at every server start,
using mode `0600`, and configures a provider named `volcengine_ark` with
`wire_api = "responses"`.

### `app.ts`: HTTP boundary

Creates the Fastify instance and owns cross-cutting HTTP behavior:

- 1 MiB request-body limit;
- Fastify logging with authorization and cookie headers redacted;
- development-only CORS;
- shared bearer-token hook;
- Zod request validation;
- baseline Agent and Run routes;
- optional coordination-route registration;
- production static web serving and SPA fallback;
- normalized errors.

Baseline errors use `{ "error": "message" }`. Zod errors additionally include
`details`. `CoordinationError` uses a different structured shape:
`{ "error": { "code", "message", "fieldErrors?" } }`.

### `agent-service.ts`: baseline application service

Owns Agent lifecycle, message/Run persistence, concurrency admission,
background execution, cancellation, and restart repair. It is the central seam
for features that affect a Run before/after the runtime is invoked.

Key in-memory fields:

- `activeExecutions`: Agent ID → background execution promise.
- `cancellationRequests`: Agent IDs for which stop/delete requested
  cancellation, including the short race before a runner becomes active.

Key methods:

| Method | Behavior |
| --- | --- |
| `initialize` | Initializes dependencies and repairs interrupted state. |
| `listAgents` | Returns Agents sorted newest `updatedAt` first. |
| `getAgent` | Returns one Agent or HTTP 404. |
| `createAgent` | Creates workspace then persists Agent. |
| `updateAgent` | Rejects busy Agent, updates metadata, regenerates `AGENTS.md`. |
| `deleteAgent` | Cancels, archives workspace, removes related metadata. |
| `startAgent` | Changes a non-busy Agent to `ready` and clears errors. |
| `stopAgent` | Cancels and changes Agent to `stopped`. |
| `getMessages` | Returns oldest-first conversation history. |
| `getRuns` | Returns newest-first Run history. |
| `getRun` | Returns one Run by global Run ID. |
| `sendMessage` | Atomically admits a Run and starts background execution. |
| `systemInfo` | Reports safe model/runtime readiness metadata. |

### `store.ts`: JSON persistence

`JsonStore` loads a version-1 database into memory and exposes cloned snapshots.
All mutations are chained through a promise queue. A mutation:

1. clones current in-memory data;
2. applies the callback to the clone;
3. writes `<database>.tmp` with mode `0600`;
4. renames the temporary file over the database;
5. publishes the clone as current in-memory state.

If persistence fails, the failed clone is not published. The queue catches the
failure for chaining purposes so later mutations can still run, while the
original caller receives the error. There is no file lock, cross-process
coordination, schema migration, record indexing, or partial update.

### `workspace.ts`: Agent filesystem lifecycle

Maps an Agent UUID directly to `<workspaceRoot>/<uuid>`. It creates the root and
`.deleted` archive folder during initialization. It owns the platform-generated
workspace files and archives deleted workspaces using a timestamped directory
name. Archive uses `rename`, so it expects source and destination to be on the
same filesystem and fails if the workspace is missing.

### `runner-factory.ts`: runtime selection

Selects `ContainerCodexRunner` only when `RUNTIME_PROVIDER=container`; otherwise
selects `CodexRunner`. New runtime implementations should continue to satisfy
the `AgentRunner` interface in `types.ts` and be selected here or by a revised
factory.

### `codex-runner.ts`: in-process-container/host runner

Spawns the configured `CODEX_BIN` directly with a restricted environment. It
passes the Ark key, Codex home, and a selected allowlist of inherited system
variables. Availability is `codex --version` with a five-second timeout.

Despite the class name, where it runs depends on the server deployment:

- local development: Codex is a host process;
- Docker Compose/ECS: Codex is a process inside the application container.

### `container-codex-runner.ts`: disposable local runtime

Spawns the configured container-engine CLI. Each turn gets a deterministic
container name scoped by runtime instance and Agent ID, plus labels used by the
startup script for cleanup. It mounts only the Agent workspace at `/workspace`
and Codex home at `/codex-home`.

Container controls include `--rm`, `--init`, bridge networking,
`no-new-privileges`, all Linux capabilities dropped, CPU/memory/PID limits, and
an explicit user. Podman additionally receives `--userns keep-id`.

The Ark key is deliberately not put in argv; `--env ARK_API_KEY` asks the
engine to copy it from the runner process environment.

### `types.ts` and `errors.ts`: baseline contracts

`types.ts` defines the persistent version-1 schema and the runtime boundary.
`HttpError` conveys expected HTTP status codes from service methods.
`RunCancelledError` distinguishes cancellation from execution failure.

## Persistent baseline model

```text
Database v1
├── agents: Agent[]
├── messages: Message[]
└── runs: AgentRun[]
```

An `Agent` carries mutable configuration and state, the absolute workspace
path, the resumable Codex thread ID, and timestamps. A `Message` links to both
Agent and Run. An `AgentRun` stores the original prompt, terminal output/error,
optional usage, and lifecycle timestamps.

There are no foreign-key checks in `JsonStore`; consistency is maintained by
`AgentService`. Runs and messages grow indefinitely until the Agent is deleted.

## Validation and limits

| Boundary | Limit |
| --- | --- |
| Agent name | trimmed, 1–80 characters |
| Description | 0–500 characters |
| Instructions | 0–10,000 characters |
| Message | trimmed, 1–50,000 characters |
| HTTP body | 1,048,576 bytes |
| Codex output | default 2,097,152 bytes across stdout and stderr |
| Run duration | default 600,000 ms |
| Retained runner stderr | last 16,384 characters |

## Notable implementation constraints

- Agent status is persisted while active process state is in memory. Only one
  server process may manage the store/runners.
- A Run contains only Codex's final Agent message, not command-level or
  intermediate event history.
- Output byte counting terminates execution once combined stdout/stderr exceeds
  the configured maximum; it does not stream data to the UI.
- `GET /api/runs/:id` is not scoped by Agent beyond possession of the shared
  demo token.
- Agent responses may be rendered as plain text only by the current UI.
- `Agent.workspacePath` is returned to the browser and persists as an absolute
  server path.
