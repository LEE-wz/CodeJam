# PA13-20 Runbook — real ten-participant bid-shaped wave rehearsal

**Task:** the final item of Auction Phase 13. Everything else on the branch is
proven against test doubles; this is the only evidence that the wave works
against a real provider, real Agents, and real concurrency.

**Authority:** [`13-auction-foundation.md`](./13-auction-foundation.md) task
`PA13-20` and its completion gate. Record results in
[`../../STATUS.md`](../../STATUS.md) under "PA13-20 procedure → Results".

**Driver:** `scripts/pa13-20-rehearsal.mjs` (repo root `scripts/`). No
dependencies — Node 22 built-in `fetch`. It reads `PUBLIC_PORT` and
`APP_AUTH_TOKEN` from `.env` and never prints a secret.

**Time:** roughly 30–45 minutes, most of it waiting on real model calls.

**No award is made.** Phase 13 evidence is test-shaped by design; bid scoring and
awards belong to parallel Phase 14.

---

## Step 0 — Prerequisites

| Requirement | Check |
|---|---|
| Docker running | `docker info` |
| On the right branch | `git branch --show-current` → `bidding-agent-implementation` |
| `.env` present with real credentials | `ARK_API_KEY`, `ARK_MODEL`, `APP_AUTH_TOKEN` all non-empty |
| The Compose gate already passed | `./VERIFY_PA13.sh` — this is `PA13-09`–`PA13-19`, not this task |

Do not run this rehearsal against a deployment whose gate has not passed. A live
failure is only interpretable when the unit and race evidence is already green.

---

## Step 1 — Build and start the deployment

```bash
cd /Users/dylnho/Downloads/TechJam/CodeJam
unset LAUNCHPAD_ENV_FILE     # see the note below
docker compose up --build -d
```

**`unset LAUNCHPAD_ENV_FILE` first, always.** `docker-compose.yml` reads
`env_file: ${LAUNCHPAD_ENV_FILE:-.env}`. The verification gate deliberately sets
it to `/dev/null` so the disposable check never loads repository secrets. If that
variable is still set in your shell — it leaks if `VERIFY_PA13.sh` was *sourced*
rather than executed — the server starts with **no `.env`**, and because the
compose `environment:` block still sets `HOST=0.0.0.0`, it fails the
non-loopback auth-token check and crash-loops:

```
Error: APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server
```

`docker compose ps` shows `Restarting (1)` and nothing listens on 3001.

**Expected:** the build reaches `[build 8/9] RUN npm run build` **uncached** (it
must compile the Phase 13 source), then `Container codejam-launchpad-1 Started`.

---

## Step 2 — Wait for the server, then confirm it is healthy

The container reports `Started` before Node has bound the port and before
`coordination.initialize()` has finished its reconciliation sweep. **Do not
paste the remaining steps in as one block** — a single probe races the boot.

```bash
docker compose ps
curl -sS http://127.0.0.1:3001/api/health
```

Use `127.0.0.1`, not `localhost`: on macOS `localhost` can resolve to `::1`
first while Docker publishes on IPv4 only, which looks exactly like a dead
server. Use `-sS`, not `-s`: plain `-s` silences connection errors and prints
nothing at all.

**Expected:** container `Up`; health returns JSON.

**If the container is `Exited`:**

```bash
docker compose logs --tail=80 launchpad
```

---

## Step 3 — Confirm Codex is actually available

`.env` sets `RUNTIME_PROVIDER=local-process`, so Codex runs inside the app
container. If the binary is missing, Agents still create fine and every attempt
fails at execution time — which looks like ten bidders failing for reasons that
have nothing to do with the wave. Check before spending a rehearsal on it.

```bash
TOKEN=$(grep '^APP_AUTH_TOKEN=' .env | cut -d= -f2-)
curl -sS http://127.0.0.1:3001/api/system -H "authorization: Bearer $TOKEN"
```

**Expected:** `"codexAvailable": true` and `"arkConfigured": true`.

**If `codexAvailable` is false:** stop and fix this first. Nothing below is
meaningful without it.

---

## Step 4 — Create ten specialised Agents

```bash
node scripts/pa13-20-rehearsal.mjs agents
```

Creates `PA13 Bidder 01` … `PA13 Bidder 10`, each with a genuinely distinct
`specialization` (security, payments, trust & safety, infrastructure, privacy,
mobile, growth, support ops, legal, accessibility) so the bids have something to
differentiate on. Re-running reuses and re-specialises existing Agents rather
than duplicating them.

**Expected:** ten lines ending `(ready)`, then `10 specialised Agents ready.`

**If any Agent is not ready** the script exits non-zero and names it. Start it
from the UI or `POST /api/agents/:id/start`, then re-run.

---

## Step 5 — Scenario A: the healthy wave

```bash
node scripts/pa13-20-rehearsal.mjs run
```

Creates a session with `sessionWaveMode: "parallel"`,
`sessionWavePurpose: "session_bidding"`, `maxParallelTurns: 4`, all ten as
participants; sends one prompt; polls until settled; prints the evidence block.

Live progress line: `awaiting_input  committed 7  retired 0  in flight 4`.

### Expected outcome

| Evidence | Expected |
|---|---|
| Final status | `awaiting_input` — **not** `failed`, **not** `completed` |
| Turns scheduled | 10, contiguous sequences `[1..10]` |
| All bid-shaped | `YES` |
| Committed | 10 |
| Retired | 0 |
| Observed peak concurrency | **≤ 4**, and `within cap YES` |
| API totals vs recomputed | `agree YES` |
| Attempts counted | 10, including 0 non-succeeded |
| Attempts left running | 0 (clean) |
| `activeTurnIds` | `[]` |
| Events gapless | `YES` |
| `leaseToken` in payload | `absent` |
| Wall clock | single-digit to low tens of seconds per member; the whole wave should beat ten sequential turns |

**The concurrency number is the headline.** `observed peak` above 4 means the
semaphore is not holding and is a real defect — capture the report and stop.

`observed peak` well *below* 4 (say 1 or 2) usually means the members finished
faster than they overlapped, not that the cap failed. Check the wall clock: if
the wave took roughly as long as ten sequential turns, concurrency genuinely is
not happening and that is worth investigating.

---

## Step 6 — Scenario B: forced contention and partial failure

```bash
node scripts/pa13-20-rehearsal.mjs run --busy
```

Occupies the **first** participant with a long Playground message, then runs the
same wave. First, not last, because the bounded runner starts members in order —
holding the first one guarantees the wave meets contention immediately.

After the wave settles the script sends a **second prompt** to the same session,
which is the actual proof that a retired bidder does not strand it.

### Expected outcome

| Evidence | Expected |
|---|---|
| Final status | `awaiting_input` |
| Committed | 9 |
| Retired | 1 (the held Agent) |
| `turn.failed` events | 1 |
| Contention (`AGENT_RESERVED`) | 2 — the held Agent's whole retry budget, and no more |
| Failures listed | the held Agent ×2, code `AGENT_RESERVED`, message about the Agent already running |
| Follow-up prompt accepted | `YES` |
| Retired bidder re-scheduled in round 2 | `YES` — unavailability is per round, not a permanent ejection |
| Attempts left running | 0 |

**If contention count is 0**, the Playground run finished before the wave reached
that Agent. Re-run — the essay prompt is long, but a fast model can still beat
it. Do not record a scenario B with zero contention as evidence.

**If the run ends `failed`**, that is a genuine defect: one bad bidder must not
fail a bidding wave (`PA13-12`). Capture the report.

---

## Step 7 — Scenario C: restart mid-wave (manual)

```bash
node scripts/pa13-20-rehearsal.mjs run --restart 2>&1 | tee /tmp/pa13-C.txt
```

The script restarts the deployment itself, the moment an attempt is genuinely in
flight, then waits for the server to return and re-reads the run. Do **not** try
to do this by hand in a second terminal: the wave lasts about 20-27 seconds, and
the first attempt at this scenario missed the window entirely and silently
recorded a third healthy wave instead.

It requires `docker` on `PATH` and must be run from the repository root.

### Expected outcome

On boot, `interruptActiveRuns()` settles the interrupted wave, then the
reconciliation sweep runs.

| Evidence | Expected |
|---|---|
| Final status | `awaiting_input`, **no** `errorCode` |
| Interrupted wave members | `failed` (settled), attempts `cancelled` with `SERVER_RESTARTED` |
| Attempts left running | 0 |
| `activeTurnIds` | `[]` |
| Events | include `run.interrupted` then `run.awaiting_input` |
| Every participant usable | the script sends a follow-up prompt and reports `accepted: YES` |

The script prints a dedicated `RESTART EVIDENCE` block with each of these, then
sends another prompt to prove every participant was released.

If it prints `the wave settled before any attempt was in flight — re-run`, the
restart never triggered and the scenario proved nothing. Run it again.

**An attempt still `running` after restart is the failure that matters here** —
it means a participant is reserved forever. Capture it.

---

## Step 8 — Record the results

Paste all three reports into `docs/development/STATUS.md`, under
"PA13-20 procedure → Results", filling the Scenario A/B/C table. Then:

1. Set `PA13-20` to `complete` in the Auction Phase 13 task ledger.
2. Tick `- [x] **PA13-20**` in [`13-auction-foundation.md`](./13-auction-foundation.md).
3. Add a verification-log row with the date, the commit, and the headline
   numbers (wall clock, peak concurrency, token totals, committed/retired).
4. Walk the completion gate on the phase sheet and confirm each bullet is
   answered by one of the three scenarios.

Record what actually happened. **A contradiction is a finding, not a failed
rehearsal** — an unexpected number is more valuable than a tidy one, and Phase 14
must not begin on top of a wave race that was papered over.

---

## Step 9 — Clean up

```bash
node scripts/pa13-20-rehearsal.mjs cleanup   # removes the ten PA13 Bidder Agents
docker compose down
```

Leave the coordination runs in place — they are the evidence.

---

## Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `Restarting (1)`, log says `APP_AUTH_TOKEN must contain at least 24 characters` | `LAUNCHPAD_ENV_FILE=/dev/null` leaked into the shell, so no `.env` was loaded | `unset LAUNCHPAD_ENV_FILE && docker compose up -d` |
| `Restarting (1)`, log says `APP_AUTH_TOKEN` too short with `.env` loaded | The real token is under 24 characters | Set a token of 24+ characters in `.env` |
| `Cannot reach 127.0.0.1:3001` after 90s | Container exited | `docker compose logs --tail=80 launchpad` |
| `curl` prints nothing | `-s` swallowed the error | Use `-sS` |
| Health fails but container is `Up` | Boot race, or IPv6 | Wait; use `127.0.0.1` not `localhost` |
| Every attempt fails immediately | `codexAvailable: false` | Fix Step 3 before rehearsing |
| Ten attempts time out | 10 concurrent Codex processes under `mem_limit: 4g`, `cpus: 2` | `MAX_PARALLEL=2 node scripts/pa13-20-rehearsal.mjs run`; record the cap you used |
| `rate limits engaged: YES` | Provider throttling | Not a failure — this is one of the things `PA13-20` asks you to record |
| `409 AGENT_RESERVED` creating a session | An Agent is still held by an earlier run | Wait for it to settle, or stop that run |

A lower `maxParallelTurns` is still valid evidence for this task, as long as the
report says which cap produced the numbers.
