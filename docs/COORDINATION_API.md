# Session Coordination API

All routes are JSON. When `APP_AUTH_TOKEN` is configured, send
`Authorization: Bearer <token>`. The server never returns the durable attempt
`leaseToken`.

## Route table

| Method | Path | Success | Purpose |
|---|---|---:|---|
| GET | `/api/coordination-runs` | 200 | List recent runs |
| POST | `/api/coordination-runs` | 201 | Create a session (or legacy verified run) |
| GET | `/api/coordination-runs/:id` | 200 | Full detail or cursor delta |
| POST | `/api/coordination-runs/:id/messages` | 202 | Append/idempotently resume with a user prompt |
| POST | `/api/coordination-runs/:id/awards/:awardId/feedback` | 202 | Rate an immutable award |
| POST | `/api/coordination-runs/:id/start` | 202 | Retained start transition for compatible clients |
| POST | `/api/coordination-runs/:id/stop` | 202 | Cancel active work; Session v2 returns idle |
| POST | `/api/coordination-runs/:id/end` | 202 | End an idle session terminally |

## Create a Session v2 run

```http
POST /api/coordination-runs
Content-Type: application/json

{
  "workflow": "shared_session_v1",
  "name": "Launch risk review",
  "objective": "Choose the safest launch scope.",
  "agents": ["agent-security", "agent-product", "agent-ops"],
  "policy": {
    "maxTurns": 2000,
    "maxParallelTurns": 3,
    "auctionPolicy": {
      "routingMode": "auto",
      "defaultAgentId": "agent-product",
      "directConfidenceThresholdBps": 8000,
      "directOutputTokenBudget": 4000,
      "minimumValidBids": 2,
      "maxBidOutputTokens": 2048,
      "maxBidAttempts": 2,
      "auctionExecutionTokenBudget": 4000,
      "auctionOnDirectFailure": false,
      "fallback": "round_robin",
      "scoringVersion": "confidence_cost_v1"
    }
  }
}
```

Participants must be 2–10 distinct existing Agents. `maxTurns` is 3–100,000;
2,000 is both the measured recommendation and the default. Omitting
`auctionPolicy` reads as the pre-auction execution-wave contract for stored
clients. Auction sessions cannot combine the Phase 13
`sessionWaveMode/sessionWavePurpose` fields with auction policy.

## Send a prompt

```http
POST /api/coordination-runs/:id/messages
Content-Type: application/json

{
  "content": "Compare the highest-risk launch options.",
  "clientMessageId": "6ca39323-1c53-4a70-96d7-7fcb8ca12086",
  "routing": {
    "routingMode": "auction",
    "coordinationPreference": "team",
    "riskLevel": "high"
  }
}
```

`content` is trimmed and limited to 4,000 characters. `clientMessageId` is
optional, bounded to 128 characters, and makes an exact repeated last send a
no-op. Reusing it with different content conflicts. Per-message routing may
request `direct | auction`, select a current participant, and carry bounded
coordination/risk preferences. It cannot increase budgets or concurrency. A
high-risk message cannot request Direct.

The endpoint accepts both `created` and `awaiting_input` sessions and starts
work asynchronously. A prompt while work is active returns 409.

## Detail and cursor polling

First load:

```http
GET /api/coordination-runs/:id
```

Returns the full run, turns, public attempts, artifacts, events, usage totals,
auction usage, and any award/scoring evidence.

Subsequent poll:

```http
GET /api/coordination-runs/:id?sinceSequence=123
```

The cursor is inclusive. The response always includes current `run` and usage
summaries, plus events at or after the cursor and only their linked
turns/attempts/artifacts. `cursor` is the next value to send. The web client
loads once, then polls deltas every 1.5 seconds only while the status is active.

Measured at 10,000 turns, a full response was 30.86 MiB while a one-wave delta
was 37,442 bytes (864× smaller). The route still constructs full detail before
filtering, so delta server time grows with the ledger even though wire bytes do
not.

## Stop and End

- Stop is idempotent for terminal runs. For an active Session v2 round it
  requests cancellation, fences late results, settles the wave, and returns the
  session to `awaiting_input`.
- End is accepted only when a shared session is `created` or
  `awaiting_input`. It records `endedByUser: true`, points at the latest
  committed message when one exists, and returns `completed`.
- Sending after End returns 409 `INVALID_STATE`.

## Award feedback

```json
{"decision":"accepted"}
```

Decision is `accepted | rejected`. One current rating exists per award; the
award and winner never change.

## Statuses

`created | running | stop_requested | awaiting_input | completed | failed |
stopped`.

Active: `running`, `stop_requested`. Idle/live:
`created`, `awaiting_input`. Terminal: `completed`, `failed`, `stopped`.

## Error envelope

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request validation failed",
    "fields": {"policy.maxTurns":["Too big"]}
  }
}
```

Important codes:

- 400: `VALIDATION_FAILED`, `DUPLICATE_AGENT`
- 404: `NOT_FOUND`
- 409: `INVALID_STATE`, `AGENT_NOT_READY`, `AGENT_RESERVED`,
  `ACTIVE_RUN_CONFLICT`
- durable run failures: `INVALID_AGENT_OUTPUT`,
  `MAX_ATTEMPTS_EXCEEDED`, `MAX_TURNS_EXCEEDED`,
  `ATTEMPT_TIMED_OUT`, `AGENT_EXECUTION_FAILED`, `SERVER_RESTARTED`,
  `RUN_ABANDONED`, `STOPPED_BY_USER`, `INTERNAL_ERROR`

The HTTP request that starts asynchronous work can succeed with 202 and the run
can later become `failed`; clients learn that through detail polling.

## Idempotency and concurrency

- Repository mutations compare the expected run version.
- One award key exists per user-message round.
- Attempt commits require the live lease.
- `clientMessageId` fences browser double-submit.
- Competing loops observe the committed winner instead of re-scoring.
