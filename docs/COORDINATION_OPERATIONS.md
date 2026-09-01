# Session Coordination Operations

## Implemented limits

| Limit | Value |
|---|---:|
| Participants | 2–10 |
| Default and recommended session turns | 2,000 |
| UI warning threshold | 1,600 |
| Explicit hard turn ceiling | 100,000 |
| User prompt | 1–4,000 characters |
| Session message | 1–500 characters |
| Parallel work | 1–10; default 4 |
| Context | 40,000 characters |
| Direct output budget | 1–4,000 tokens |
| Bid output budget | 128–4,096 tokens |
| Bid attempts | 1–3 |
| Awarded execution budget | 128–16,000 tokens |

The 100,000 ceiling remains available to explicit callers. It is a type and
safety ceiling, not a performance claim. The UI warns before the measured
2,000-turn recommendation and operators should start a new session once prompt
latency becomes uncomfortable.

## Storage decision

State remains in the version-2 `JsonStore`. The alternative engine from
P15-05 is deferred.

The original scale audit found that turn N stored every prior transcript id,
making the ledger O(n²). Phase 15 changed new session turns to record an
inclusive `inputThroughSequence` and only the round-specific user/award ids.
The context builder retains the exact transcript whitelist and the old id-list
path for stored turns. This was a data-model defect; swapping storage first
would only have moved the quadratic bytes.

`JsonStore.mutate` still structured-clones and rewrites the entire database to
a temporary file before rename. It provides serialized single-process
mutations, not multi-process database semantics. Never run two servers against
one data directory.

## P15-01 measured store cost

Command: `npm run scale:p15-01`. The harness uses fresh system temporary
directories only. For each row it materialises a validated realistic ledger one
wave below the target, then measures a real ten-Agent prompt through the service,
repository, workflow, protocol, and store. Node v24.12.0, darwin arm64,
2026-09-01.

| Turns | DB | mutate p50 | mutate p95 | snapshot | snapshot heap | RSS | getRunDetails | last prompt |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 0.42 MiB | 22.32 ms | 25.27 ms | 1.09 ms | 0.71 MiB | 122.58 MiB | 2.42 ms | 0.11 s |
| 500 | 2.05 MiB | 130.05 ms | 157.04 ms | 5.94 ms | 3.55 MiB | 181.36 MiB | 14.09 ms | 0.63 s |
| 2,000 | 8.21 MiB | 529.00 ms | 833.28 ms | 23.93 ms | 14.37 MiB | 536.92 MiB | 64.58 ms | 2.97 s |
| 10,000 | 41.15 MiB | 2,697.20 ms | 5,655.91 ms | 105.13 ms | 53.93 MiB | 1,705.03 MiB | 226.45 ms | 18.05 s |

The stored bytes are approximately linear after the sequence-bound fix, but
mutation cost and end-to-end latency still rise with the whole document. Ten
thousand turns are persistable in the measured shape but unusable as an
interactive default. Two thousand is the first sampled point above two seconds,
so it is the practical recommendation/default; the warning begins at 80%.

Mutation timings include queue wait among concurrent commits in the final wave,
which is part of the latency a real wave experiences.

## P15-02 measured read path

Command: `npm run scale:p15-02`. Requests use the real Fastify route; byte
counts are browser wire payloads. A wave delta contains 31 events at every size.

| Turns | full | full time | idle delta | wave delta | delta time | full polls/min | delta polls/min | saving |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 0.31 MiB | 9.35 ms | 1,866 B | 37,238 B | 2.80 ms | 12.24 MiB | 1.42 MiB | 8.61× |
| 500 | 1.53 MiB | 13.06 ms | 1,868 B | 37,261 B | 10.10 ms | 61.22 MiB | 1.42 MiB | 43.07× |
| 2,000 | 6.15 MiB | 55.06 ms | 1,870 B | 37,335 B | 46.24 ms | 245.89 MiB | 1.42 MiB | 172.65× |
| 10,000 | 30.86 MiB | 271.06 ms | 1,874 B | 37,442 B | 218.38 ms | 1,234.59 MiB | 1.43 MiB | 864.38× |

The web client was already delta-only after first load; no client change was
needed. Delta bytes stay flat, but server time grows because the route calls
`getRunDetails` before filtering. That is a known scaling limit.

## Restart and reconciliation

- `awaiting_input` sessions survive boot and accept another prompt.
- In-flight verified and legacy work is settled honestly.
- Auction recovery re-derives from committed bids and awards. A settled bid is
  not repeated; a committed winner is not re-scored; a boot-cancelled awarded
  turn is not counted as completed.
- The loop reconciler detects running work without a live owner and either
  resumes a safe next action or fails with `RUN_ABANDONED`.
- Lease and version fences make late completion harmless.

## Logging and redaction

Events use an allowlist. They may contain bounded identifiers, enums, counts,
digests, score components, wave purpose, and usage numbers. They must not contain
prompt content, objectives, raw output, candidate answers, lease tokens,
authorization headers, cookies, provider thread ids, or stack traces.

User-authored prompts are deliberately durable in `user_message` artifacts
and public detail payloads. They do not enter events or server logs. Public
attempts omit `leaseToken`; it exists only in the durable server-side
collection.

## Known failure modes

| Failure | Operational behavior |
|---|---|
| Provider timeout/error/429 | bounded attempt retry, then turn/round failure |
| Malformed bid/message | `attempt.invalid_output`, bounded feedback, retry |
| Too few valid bids | one configured fallback or safe failure |
| Winning execution failure | fail; never silently promote runner-up |
| Stop during wave | cancel all active siblings, fence late output, return idle |
| Process death mid-round | reconcile from durable evidence; no silent re-score |
| Turn ceiling | fail with `MAX_TURNS_EXCEEDED` |
| Very long session | large first read and whole-document mutation latency |

## Runtime-state hygiene and rollback

Runtime state lives under the configured `APP_DATA_DIR` and workspace roots.
Before a release evidence run, use a disposable data root or archive local
state; never commit `data/`, `workspaces/`, `codex-home/`, logs, or scale
report JSON.

No storage migration is required for P15-05: `inputThroughSequence` is
additive. Rollback to the prior binary keeps old records readable; turns written
with the new optional field remain valid JSON and older code ignores unknown
properties, although reverting also restores quadratic growth for newly
scheduled turns.

## Verification

Canonical clean gate:

```bash
docker compose build launchpad
docker compose run --rm --no-deps --user root \
  -v "$PWD:/source:ro" -v /workspace \
  -w /workspace launchpad sh -lc "tar -C /source \
    --exclude='apps/*/node_modules' --exclude='apps/*/dist' \
    -cf - package.json package-lock.json tsconfig.base.json apps \
    | tar --no-same-owner -C /workspace -xf - \
    && npm ci --include=dev && npm run check"
```
