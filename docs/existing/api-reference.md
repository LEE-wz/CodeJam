# API reference

All live endpoints use JSON. Except for `/api/health` and `/api/auth`, routes
require `Authorization: Bearer <APP_AUTH_TOKEN>` when the server has a token
configured.

## Public endpoints

### `GET /api/health`

Returns `200`:

```json
{ "ok": true, "service": "volc-agent-launchpad" }
```

Used by the Docker health check and deployment verification.

### `GET /api/auth`

Returns whether protected API requests need the shared token:

```json
{ "required": true }
```

It does not validate a supplied token; the browser validates indirectly by
calling protected bootstrap endpoints.

## System endpoint

### `GET /api/system`

Returns model and runtime readiness. `codexAvailable` performs a live runner
availability check on every request.

```json
{
  "arkConfigured": true,
  "arkBaseUrl": "https://ark.cn-beijing.volces.com/api/v3",
  "arkModel": "ep-example",
  "codexAvailable": true,
  "codexSandboxMode": "workspace-write",
  "runtimeProvider": "container",
  "containerEngine": "docker",
  "runtime": "Codex CLI in docker Runtime"
}
```

The Ark API key is never returned.

## Agent endpoints

| Method and path | Success | Behavior |
| --- | ---: | --- |
| `GET /api/agents` | 200 | `{ agents }`, newest updated first. |
| `POST /api/agents` | 201 | Creates workspace and returns `{ agent }`. |
| `GET /api/agents/:id` | 200 | Returns `{ agent }`. UUID path required. |
| `PATCH /api/agents/:id` | 200 | Updates at least one field; returns `{ agent }`. |
| `DELETE /api/agents/:id` | 200 | Cancels, archives, and returns `{ archivedWorkspace }`. |
| `POST /api/agents/:id/start` | 200 | Sets non-busy Agent ready; returns `{ agent }`. |
| `POST /api/agents/:id/stop` | 200 | Cancels active work and returns stopped `{ agent }`. |

Create request:

```json
{
  "name": "Frontend Builder",
  "description": "Builds React prototypes",
  "instructions": "Keep changes small and run tests."
}
```

Only `name` is required. Unknown object keys are not explicitly rejected by the
baseline Zod object. Patch accepts the same fields as optional but requires at
least one key.

Common errors:

- `400`: invalid UUID/body, empty patch, malformed JSON, or field limit.
- `404`: Agent not found.
- `409`: attempt to update/start a busy Agent.
- `413`: Fastify body limit exceeded.

## Message and Run endpoints

| Method and path | Success | Behavior |
| --- | ---: | --- |
| `GET /api/agents/:id/messages` | 200 | `{ messages }`, oldest first. |
| `GET /api/agents/:id/runs` | 200 | `{ runs }`, newest first. |
| `POST /api/agents/:id/messages` | 202 | Queues work; returns `{ run, message }`. |
| `GET /api/runs/:id` | 200 | Returns `{ run }` for polling. |

Send request:

```json
{ "content": "Add tests for the parser." }
```

The 202 response means the Run was admitted, not completed. Poll its URL until
status is one of `completed`, `failed`, or `cancelled`.

Admission errors:

- `404`: Agent not found.
- `409`: Agent stopped or already busy.
- `503`: Ark key/model not configured.

`AgentRun` lifecycle values are `queued`, `running`, `completed`, `failed`, and
`cancelled`. The completed record may include input, cached-input, and output
token counts. `startedAt` and `completedAt` exist in server responses even
though the current web type omits them.

## Optional coordination endpoints

These routes are implemented by `registerCoordinationRoutes()` but **are not
registered by the current `index.ts` composition root**. They exist only when a
caller explicitly passes a `CoordinationServiceContract` to `createApp()`.

| Method and path | Success | Intended behavior |
| --- | ---: | --- |
| `GET /api/coordination-runs` | 200 | Returns up to 50 runs from the service. |
| `POST /api/coordination-runs` | 201 | Creates a coordination run. |
| `GET /api/coordination-runs/:id` | 200 | Returns run, turns, attempts, artifacts, events. |
| `GET /api/coordination-runs/:id/events` | 200 | Returns only `{ events }`. |
| `POST /api/coordination-runs/:id/start` | 202 | Starts background orchestration. |
| `POST /api/coordination-runs/:id/stop` | 202 | Requests cancellation/settles stopped state. |

Create body:

```json
{
  "name": "Launch review",
  "objective": "Prepare a launch plan",
  "requiredSections": [
    { "key": "users", "title": "Target users" },
    { "key": "risks", "title": "Risks" }
  ],
  "agents": {
    "plannerAgentId": "agent-id-1",
    "criticAgentId": "agent-id-2",
    "finalizerAgentId": "agent-id-3"
  },
  "policy": {
    "maxRevisions": 2,
    "maxTurns": 8,
    "perAttemptTimeoutMs": 120000
  }
}
```

Coordination validation is strict and errors use stable codes and per-field
messages:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request validation failed",
    "fieldErrors": { "objective": ["Too small: expected string to have >=1 characters"] }
  }
}
```

## Error formats

Baseline:

```json
{ "error": "Agent not found" }
```

Baseline Zod validation:

```json
{ "error": "validation message", "details": [] }
```

Coordination:

```json
{ "error": { "code": "NOT_FOUND", "message": "Coordination run not found" } }
```

Unexpected errors are logged and returned as status 500 with their message.
Before production hardening, consider replacing internal messages with a stable
public error and correlation ID.
