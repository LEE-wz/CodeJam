# Session Operations

How a Session deployment behaves at runtime: the limits it enforces, what it
does when the process dies, where state lives, what reaches the logs, and the
failure modes that are known and accepted.

Every number here is enforced in code. Where a limit is quoted, it is read from
`SESSION_LIMITS` in `apps/server/src/coordination/types.ts`, mirrored for the
browser in `apps/web/src/coordination-types.ts`. Where a measurement is quoted,
it came from the harnesses in `apps/server/src/scale/`, not from an estimate.

## 1. Limits as implemented

### Session shape

| Limit | Value | Meaning |
|---|---|---|
| `minParticipants` | 2 | A session needs at least two Agents. |
| `maxParticipants` | 10 | Hard cap, validated in the route and the service. |
| `minSessionTurns` | 3 | Smallest `maxTurns` a caller may request. |
| `defaultSessionTurns` | 200 | Applied when the caller does not choose. |
| `recommendedMaxSessionTurns` | 2,000 | **Measured** comfortable ceiling. Not a type bound. |
| `sessionTurnWarningThreshold` | 1,600 | 80% of the recommendation; the UI starts warning here. |
| `maxSaveableSessionTurns` | 50,000 | The largest session the create route will accept. |
| `maxSessionTurns` | 100,000 | Type-level ceiling. Stored runs above the saveable cap still load. |

The three ceilings are deliberately different and the distinction matters:

- **2,000** is advice, derived from measurement. Past it the product still works
  but a prompt starts taking more than two seconds.
- **50,000** is a refusal. A request larger than this was measured to be
  unsaveable, and refusing a request is recoverable where losing a session is
  not.
- **100,000** is the type bound only. It is not offered to new requests.

This is a recorded deviation from the Phase 15 sheet, which asked that the
100,000 ceiling stay available to callers who ask for it explicitly. See the
`P15-04` mini-RFC in `development/ASSUMPTIONS_AND_DECISIONS.md`.

### Message and plan bounds

| Limit | Value |
|---|---|
| `messageMinChars` | 1 |
| `messageMaxChars` | 500 |
| `planInstructionMaxChars` | 500 (per assignment in a `session_plan`) |
| `maxParallelTurns` | 10 (wave supervisor ceiling; default is `min(participants, 4)`) |

### Per-run policy

`CoordinationPolicy` carries `maxTurns`, `maxAttemptsPerTurn`,
`perAttemptTimeoutMs`, `contextMaxChars`, and `outputMaxChars`. `maxRevisions`
applies to the verified-handoff workflow only. `sessionProtocol`,
`sessionParallel`, `maxParallelTurns`, and `sessionPlanning` are shared-session
only and are absent on verified-handoff runs.

A stored session run created before Phase 14 has no `sessionPlanning` field and
is read as `round_robin`.

## 2. Restart and reconciliation

The server is a **single process**. There is no leader election, no work queue,
and no second replica. This is the central operational constraint and it is not
hidden anywhere else in this document.

### What happens on boot

`interruptActiveRuns` settles runs that were mid-flight when the process died:

- Runs in `running` or `stop_requested` are failed with `SERVER_RESTARTED`.
  They are **not** auto-resumed. An external model invocation cannot be safely
  reconstructed, so the system records an honest interruption instead of
  pretending otherwise (ADR-12).
- Runs in `awaiting_input` are **left alive**. A session with no in-flight work
  survives a restart intact and accepts the next prompt. This is the behaviour
  that makes a session feel durable across a deploy.

### The reconciler

Before Phase 11, six exits from the orchestration loop returned without making
a terminal repository call. The run stayed `running` with its active turn set
and its participants reserved, with nothing left to drive it — the "stuck
Agents" defect.

Every such exit is now classified and answered. The classification is the
`P11-01` deliverable and lives in `development/STATUS.md`; the reconciler
implements it. The three classes:

- **already owned** — something else has taken responsibility for the next
  transition. Return.
- **resume** — the loop lost its lease or its turn was superseded. Reconcile the
  turn, then continue from reloaded state.
- **already correct** — a terminal call was made. Settle.

An operator-visible consequence: after any restart, a session's participating
Agents are usable again. A run never strands a reservation.

## 3. Storage

### The engine

State lives in one JSON document written by `JsonStore`
(`apps/server/src/store.ts`). `mutate` deep-clones the entire database, applies
the mutation, serialises the whole document, writes a temp file, and renames.
Every mutation. One committed turn costs roughly four of those.

This was measured, weighed, and **kept** — see the `P15-04` mini-RFC. The
quadratic that made long sessions painful was a data-model defect
(`inputArtifactIds` on every turn), not a storage-engine defect. A repository
swap would have moved those bytes without removing them. The fix pinned each
turn's transcript as a single `inputThroughSequence` bound instead.

`CoordinationRepository` remains the seam. If an engine swap is ever done, the
service, workflow, protocol, and routes do not change, and the existing
repository race suite must pass against the new implementation unmodified.

### Measured cost after the fix

One session, ten participants, 226-character messages. Node v24, darwin arm64.

| Committed turns | DB file | Mutation p50 | One prompt end-to-end |
|---|---|---|---|
| 100 | 0.43 MiB | 1.48 ms | 0.09 s |
| 500 | 2.14 MiB | 6.93 ms | 0.45 s |
| 1,000 | 4.28 MiB | 14.50 ms | 0.94 s |
| 2,000 | 8.56 MiB | 30.33 ms | 2.06 s |

Growth is linear at ~4.28 KB per committed turn. At 2,000 turns the database is
92% smaller than before the fix, a mutation is 13× faster, and one prompt is
11.6× faster.

### The hard wall

`persist()` serialises the whole database into one string. Node's
`MAX_STRING_LENGTH` is 512 MiB, and exceeding it throws
`RangeError: Invalid string length` — verified directly, not assumed. Past that
point the session **cannot be saved at all**.

Before the data-model fix that wall sat near 4,426 committed turns. It now sits
near 120,000. `maxSaveableSessionTurns` is set at 50,000, roughly half, leaving
headroom for longer messages, more participants, and retry attempts — none of
which the measurement maximised.

### What is still true

`JsonStore` still rewrites the whole document per mutation. A mutation is still
O(file size), and building a long session is still O(n²) in time. That is the
remaining argument for an engine swap, and it is now a performance argument
rather than a data-loss one.

## 4. Read path and polling

The browser polls the run detail endpoint every 1.5 s while a run is active
(ADR-11). After the first load the client is delta-only: it passes
`?sinceSequence=` from the accumulated cursor.

The delta matters enormously. At 2,000 turns it saves **103×** of bandwidth.
Full-fetch polling at that size would cost 3.53 GiB per minute per viewer, which
is not a product.

Two measured costs are **known and open**:

1. **A delta poll is cheap in bytes but not in server time.** The route calls
   the full `getRun` and filters afterwards, so an idle poll returning 1,620
   bytes still costs 355 ms at 2,000 turns — about 24% of a core per idle
   viewer at the 1.5 s cadence. Ten idle viewers would saturate more than two
   cores displaying nothing new. The fix is to filter before cloning, or to
   index events by sequence.
2. **First open is the worst moment.** A 2,000-turn session makes the browser
   download 88 MiB before it can render, and the server spends 623 ms building
   it. A paginated or artifact-only first read would fix it.

Neither is a correctness problem. Both are recorded rather than quietly
carried.

## 5. Logging and redaction

### The rule

`CoordinationEvent.details` is governed by an **allowlist**, not a denylist
(`apps/server/src/coordination/redaction.ts`). Anything not named in
`ALLOWED_EVENT_DETAIL_KEYS` is dropped. A lease token, a prompt, or raw model
output cannot reach an event by being passed under a new key.

Every allowed key names a bounded enum, identifier, count, digest, or short
label — never model input or output. Strings are capped at 200 characters and
arrays at 10 items, and any truncation appends a visible `… [truncated]`
marker so a shortened value never looks complete.

### What is deliberately absent

- Lease tokens. The public attempt read model is
  `Omit<CoordinationAttempt, "leaseToken">`; the capability never leaves the
  server.
- Raw prompts and raw model output. Prompts appear only as `promptDigest`, a
  SHA-256 prefix. Output appears only as `outputDigest` and `sizeChars`.
- Authorization headers, cookies, and API keys.

### What Session v2 added

User-authored prompt content is now durable, stored as a `user_message`
artifact. This is intentional — it is the transcript. It appears in artifacts
and in the run detail payload. It does **not** appear in events: events continue
to carry only bounded metadata.

Verified by the Phase 2 smoke check, which asserts directly that events carry no
lease token, that public attempts carry no lease token, and that events carry no
prompt or objective text.

## 6. Known failure modes

| Mode | Trigger | Behaviour |
|---|---|---|
| `SERVER_RESTARTED` | Process died with a run in flight | Run fails on boot. Not resumed. Agents released. |
| `MAX_ATTEMPTS_EXCEEDED` | A turn exhausted `maxAttemptsPerTurn` | Run fails. Under a parallel wave, only after every sibling settles, so no attempt is orphaned. |
| `MAX_TURNS_EXCEEDED` | Session hit its `maxTurns` ceiling | Run **fails**; it does not complete. |
| `AGENT_NOT_READY` | A participant's Agent is not exactly `ready` at start | Start refused. |
| `AGENT_RESERVED` / `ACTIVE_RUN_CONFLICT` | An Agent is already in an active run | Join or Playground use refused. |
| `ATTEMPT_TIMED_OUT` | Attempt exceeded `perAttemptTimeoutMs` | Attempt fails; retry within the turn's budget. |
| `INVALID_AGENT_OUTPUT` | Model output failed structural validation | Attempt is invalid; bounded retry with feedback. |
| `RUN_ABANDONED` | Loop exited without a terminal call | Reconciler settles it. |
| `STOPPED_BY_USER` | Explicit stop | Whole wave cancelled; late work ignored. |

### Provider rate limiting

Not a code failure mode, but the most common operational one. When the Ark
endpoint returns sustained `429`, Codex exits non-zero and the attempt fails
like any other execution failure. A wave of ten participants is ten concurrent
model calls, so a session saturates a per-account rate limit far faster than
single-Agent Playground use. If waves fail in bursts with
`MAX_ATTEMPTS_EXCEEDED`, check provider capacity before suspecting the engine.

## 7. Operational constraints, stated plainly

- **Single process.** No horizontal scaling. Two servers against one data
  directory will corrupt it.
- **Single user.** No identity, no authorization beyond one shared bearer
  token, no tenancy, no audit trail.
- **No streaming.** Progress is observed by polling.
- **Interrupted runs do not resume.** They fail honestly and are restarted by
  the user.
- **A long session is a large file.** Comfortable to 2,000 turns, refused past
  50,000.

## 8. Related documents

- [Architecture](COORDINATION_ARCHITECTURE.md) — components, trust boundary, lifecycle
- [Protocol](COORDINATION_PROTOCOL.md) — artifact schemas and validation order
- [API](COORDINATION_API.md) — routes, status codes, polling
- [Decisions](DECISIONS.md) — ADR-01–14 and the mini-RFCs
- [Deployment](DEPLOYMENT.md) — provisioning and configuration
