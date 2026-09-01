# Session API

Every HTTP route the coordination surface exposes, with request shapes, status
codes, error codes, and polling semantics.

**Base path:** `/api/coordination-runs`

The path keeps the `coordination-runs` name even though the product is called
Session. That is a recorded decision: renaming the HTTP surface and the
server-side `coordination*` modules would churn roughly 1,100 lines of API tests
for no user-visible gain.

**Auth:** every route requires `Authorization: Bearer <APP_AUTH_TOKEN>`.

**Content type:** send `content-type: application/json` **only when there is a
body**. Fastify rejects a JSON content-type with an empty body, so a `POST` with
no payload must omit the header. A client that always sets it will get a 400 on
`/start`, `/stop`, and `/end`.

## 1. Route table

| Method | Path | Success | Purpose |
|---|---|---|---|
| `GET` | `/api/coordination-runs` | 200 | List all runs |
| `POST` | `/api/coordination-runs` | 201 | Create a run |
| `GET` | `/api/coordination-runs/:id` | 200 | Run detail, full or delta |
| `POST` | `/api/coordination-runs/:id/start` | 202 | Start a created run |
| `POST` | `/api/coordination-runs/:id/messages` | 202 | Send a prompt to a session |
| `POST` | `/api/coordination-runs/:id/stop` | 202 | Stop active work |
| `POST` | `/api/coordination-runs/:id/end` | 202 | End the session |

`202` is used wherever work continues asynchronously: the call returns promptly
and the caller observes progress by polling.

## 2. Create a run

`POST /api/coordination-runs` → `201 { run }`

The body is a union discriminated on `workflow`. A session run:

```json
{
  "workflow": "shared_session_v1",
  "name": "Marketplace design",
  "objective": "Design the trust and safety model for a peer marketplace.",
  "agents": ["a1e...", "b2f...", "c3d..."],
  "policy": {
    "sessionPlanning": "coordinator",
    "maxTurns": 200,
    "maxParallelTurns": 4
  }
}
```

| Field | Rule |
|---|---|
| `workflow` | `"shared_session_v1"` |
| `name` | 1–80 characters |
| `objective` | 1–4,000 characters |
| `agents` | 2–10 distinct Agent ids, all distinct |
| `policy.sessionPlanning` | `"coordinator"` (default) or `"round_robin"` |
| `policy.sessionProtocol` | `"free_chat"` |
| `policy.sessionParallel` | boolean |
| `policy.maxParallelTurns` | 1–10 |
| `policy.maxTurns` | 3 – `maxSaveableSessionTurns` (50,000) |
| `policy.perAttemptTimeoutMs` | 10,000–180,000 |

A request for more than `maxSaveableSessionTurns` is refused. That session was
measured to be unsaveable, and refusing is recoverable where losing a session is
not.

The older verified-handoff workflow uses `workflow: "verified_handoff_v1"` with
`requiredSections` and a `roles` object naming Planner, Critic, and Finaliser.
The server still supports it; the Session UI no longer surfaces it.

## 3. Read a run

`GET /api/coordination-runs/:id` → `200`

Returns `{ run, turns, attempts, artifacts, events }`. **`attempts` never
contains `leaseToken`** — the read model is
`Omit<CoordinationAttempt, "leaseToken">`, so the capability cannot leak to a
client.

### Delta reads

`GET /api/coordination-runs/:id?sinceSequence=<n>`

Returns only what changed at or after event sequence `n`, plus a `cursor` to
pass next time:

```json
{ "run": {...}, "turns": [...], "attempts": [...], "artifacts": [...],
  "events": [...], "cursor": 412 }
```

The delta is assembled from the events in range: turns, attempts, and artifacts
referenced by those events are included, and nothing else. `cursor` is
`max(sinceSequence, lastEventSequence + 1)`, so an idle poll returns an empty
event list and the same cursor.

**Clients should be delta-only after the first load.** At 2,000 turns the delta
saves 103× of bandwidth; full-fetch polling there would cost 3.53 GiB per minute
per viewer. The shipped web client passes the accumulated cursor.

`sinceSequence` must be a non-negative integer. A non-numeric value is a 400.

## 4. Send a prompt

`POST /api/coordination-runs/:id/messages` → `202 { run, accepted: true }`

```json
{ "content": "Now cover the dispute path.", "clientMessageId": "opt-1" }
```

| Field | Rule |
|---|---|
| `content` | 1–4,000 characters, trimmed |
| `clientMessageId` | Optional, 1–128 characters — idempotency key |

Valid only when the run is `awaiting_input`. Sending to a terminal session
returns `409 INVALID_STATE` with `"This session has ended"`.

`clientMessageId` lets a client retry a submission safely: the same key does not
create a second `user_message`.

## 5. Start, stop, end

All three take **no body** — omit the content-type header.

- **`POST /:id/start`** → `202`. Valid from `created`. Every participant's Agent
  must be exactly `ready`, or the call fails `AGENT_NOT_READY`. Starting twice
  is `409 INVALID_STATE`.
- **`POST /:id/stop`** → `202`. Cancels active work. Under a parallel wave this
  cancels *every* running attempt and settles every turn. Late results from
  cancelled attempts are ignored, not applied.
- **`POST /:id/end`** → `202`. Ends the session deliberately, moving it to
  `completed`. This is the difference that matters: **stop** halts the current
  work and can leave a session resumable, **end** is the user declaring the
  session finished.

## 6. Status and error codes

### HTTP

| Code | When |
|---|---|
| 200 | Read succeeded |
| 201 | Run created |
| 202 | Accepted; work continues asynchronously |
| 400 | `VALIDATION_FAILED` — malformed body, params, or query |
| 401 | Missing or wrong bearer token |
| 404 | `NOT_FOUND` — no such run |
| 409 | State conflict — see below |
| 500 | `INTERNAL_ERROR` |

Errors are shaped `{ "error": { "code", "message", "details"? } }`. A
`VALIDATION_FAILED` response carries `details` as a field→messages map.

### Domain codes

| Code | Meaning |
|---|---|
| `VALIDATION_FAILED` | Request shape rejected |
| `NOT_FOUND` | Run does not exist |
| `INVALID_STATE` | Operation illegal from the current status |
| `DUPLICATE_AGENT` | The same Agent listed twice |
| `AGENT_NOT_READY` | A participant is not exactly `ready` |
| `AGENT_RESERVED` | Agent already committed to an active run |
| `ACTIVE_RUN_CONFLICT` | Agent would join two active runs |
| `MAX_ATTEMPTS_EXCEEDED` | A turn exhausted its attempt budget |
| `MAX_TURNS_EXCEEDED` | Session hit its ceiling — the run **fails** |
| `MAX_REVISIONS_EXCEEDED` | Verified-handoff only |
| `ATTEMPT_TIMED_OUT` | Attempt exceeded `perAttemptTimeoutMs` |
| `INVALID_AGENT_OUTPUT` | Output failed structural validation |
| `OUTPUT_TOO_LARGE` | Output beyond `outputMaxChars` |
| `RUN_ABANDONED` | Loop exited without a terminal call; reconciler settles it |
| `SERVER_RESTARTED` | Run was in flight when the process died |
| `STOPPED_BY_USER` | Explicit stop |
| `AGENT_EXECUTION_FAILED` | Runtime failed — includes provider errors such as sustained `429` |

## 7. Run statuses

```
created ──start──> running ──┬──> awaiting_input ──messages──> running
                             │           │
                             │           └──end──> completed
                             ├──stop──> stop_requested ──> stopped
                             └──> failed
```

`awaiting_input` is the state that makes a session long-lived: no active turn,
no running loop, but not terminal. It accepts another prompt and **survives a
restart**. Runs in `running` or `stop_requested` when the process dies are
failed with `SERVER_RESTARTED` and are not resumed.

A round ending returns the run to `awaiting_input`. It does not complete it.

## 8. Polling

Poll `GET /:id?sinceSequence=` every 1.5 s while a run is active (ADR-11). There
is no streaming transport.

One measured caveat: a delta poll is cheap in **bytes** but not in **server
time** — the route calls the full `getRun` and filters afterwards, so an idle
poll costs ~355 ms at 2,000 turns. Poll less aggressively on long sessions.

## 9. Related documents

- [Protocol](COORDINATION_PROTOCOL.md) — artifact schemas
- [Architecture](COORDINATION_ARCHITECTURE.md) — lifecycle and trust boundary
- [Operations](COORDINATION_OPERATIONS.md) — limits, redaction, failure modes
