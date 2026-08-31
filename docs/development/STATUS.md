# Session Development Status

**Last audit:** 2026-08-31 (`P15-01`-`P15-05`: the O(n^2) transcript encoding was
found, measured, and removed; storage is now linear and the hard ceiling moved
from ~4,400 to ~120,000 committed turns)
**Audited checkpoint:** Checkpoint 14 on `phase-14`, merged to `main`
**Implementation branch:** Phase 15 work is on `main` (no task branch; see the
Phase 15 recorded deviation)
**Phase 13 implementation commits:** `6e9d3a2`, `9555f37`, `7981453`
**Phase 7 implementation commit:** `8775c00` (`Complete durable session backend phase`)
**Current phase:** Phase 15 - Scale, Storage, and Release
**Current gate:** the documentation half of Phase 15 is complete. `P15-01`-`P15-11`
are closed (`P15-05` `deferred` with its closure condition now met). The
remaining work is the demo recordings and release verification, which need live
provider capacity.
**Overall state:** Phases 0-8 and 10-14 `complete`; Phase 9 `superseded` by Phase 15;
Phase 15 `in_progress`

The product is renamed from Relay to Session (P10-08). The HTTP surface
`/api/coordination-runs` and the server-side `coordination*` modules keep their
names by recorded decision; this file keeps historical Relay references where
they name a past checkpoint.

## Phase plan

| Phase | Content | Status |
|---|---|---|
| 0 | Baseline and contract freeze | `complete` |
| 1 | In-memory walking skeleton (verified workflow) | `complete` |
| 2 | Durable backend and evidence ledger | `complete` |
| 3 | Real Agent runtime and recovery | `complete` |
| 4 | End-to-end UI and evidence experience | `complete` |
| 5 | Session contracts and freeze | `complete` (sheet: [`phases/05-session-contracts.md`](phases/05-session-contracts.md)) |
| 6 | Session core in memory | `complete` (Checkpoint 6: `82f5c85`; sheet: [`phases/06-session-core.md`](phases/06-session-core.md)) |
| 7 | Durable session backend and API | `complete` (Checkpoint 7 verified; sheet: [`phases/07-session-durable.md`](phases/07-session-durable.md)) |
| 8 | Session UI and real rehearsal | `complete` (Checkpoint 8 verified; sheet: [`phases/08-session-ui.md`](phases/08-session-ui.md)) |
| 9 | Documentation, demo, release candidate (both workflows) | `superseded` by Phase 15 (sheet: [`phases/09-release.md`](phases/09-release.md)) |
| 10 | Session v2 surface, limits, and rename | `complete` (Checkpoint 10 verified; sheet: [`phases/10-session-v2-surface.md`](phases/10-session-v2-surface.md)) |
| 11 | Lifecycle reconciliation and Agent recovery | `complete` (sheet: [`phases/11-lifecycle-reconciliation.md`](phases/11-lifecycle-reconciliation.md)) |
| 12 | Durable multi-prompt sessions | `complete` (Checkpoint 12 verified; sheet: [`phases/12-durable-multi-prompt-sessions.md`](phases/12-durable-multi-prompt-sessions.md)) |
| 13 | Parallel waves | `complete` (Checkpoint 13 verified; sheet: [`phases/13-parallel-waves.md`](phases/13-parallel-waves.md)) |
| 14 | Coordinator planning and countdown removal | `complete` (Checkpoint 14 verified; sheet: [`phases/14-coordinator-planning.md`](phases/14-coordinator-planning.md)) |
| 15 | Scale, storage, and release | `in_progress` (`P15-01`-`P15-11` closed; `P15-12`-`P15-20` need live capacity or the freeze; sheet: [`phases/15-scale-and-release.md`](phases/15-scale-and-release.md)) |

Phases 10-15 implement the Session v2 plan in
[`plans/session-v2-plan.md`](plans/session-v2-plan.md), approved through the
Session v2 mini-RFC in
[`ASSUMPTIONS_AND_DECISIONS.md`](ASSUMPTIONS_AND_DECISIONS.md).

The session extension was adopted from the team's Relay Sessions plan. Its repository-local contract authority is [`overview-sessions.md`](overview-sessions.md). Phase 9 was formerly Phase 5; its task IDs moved from P5-xx to P9-xx.

**Checkpoints 10, 11, and 12 are complete.** `P12-01` through `P12-16` are all
done. The stale-path classification below remains the `P11-01` deliverable and
the contract the reconciler implements.

**Resume here.** `P15-01`-`P15-11` are closed. The measurements found an O(n^2)
transcript encoding, and removing it made storage linear, shrank a 2,000-turn
database by 92%, and moved the hard serialisation ceiling from ~4,400 to
~120,000 committed turns. `JsonStore` is kept by recorded decision.

The documentation set (`P15-06`-`P15-11`) was written against the coordination
model `main` carries, at the user's explicit direction: build main's phase now,
and rewrite the affected sections if the auction track is ever adopted. That is
a deliberate reversal of the earlier "settle the comparison first" note, taken
because most of the doc set is model-independent — `COORDINATION_OPERATIONS.md`
and `DECISIONS.md` entirely, six of seven API routes, and the `session_message`
and `user_message` schemas, which are identical on both tracks.

**Next: `P15-12`, `P15-13`, `P15-16`.** All three need live provider capacity
and are blocked on Ark returning sustained `429`. `P15-14`, `P15-17`, `P15-19`,
and `P15-20` are the freeze itself and are best done last.

One measured item is deliberately left open: an idle delta poll still costs
355ms of server time at 2,000 turns, because the route clones the whole database
before filtering. See `P15-02` finding 2.

### Checkpoint 11 final verification

The disposable Docker Compose gate passed on merged `main` commit `3b11bef`:
**28 server files / 503 tests**, **3 web files / 37 tests**, both typechecks and
both production builds (540 tests total). The user then completed the required
manual Compose-deployment restart check: a session was interrupted mid-attempt,
the server was restarted, the UI showed the run settled, and the participating
Agents were usable afterwards. This closes Checkpoint 11.

Docker Compose is available as `docker compose`. Baseline validation used
`LAUNCHPAD_ENV_FILE=/dev/null` so the disposable verification service did not
load repository-local secrets or runtime state.

## Phase 15 task ledger

| Task | Status | Current implementation/evidence |
|---|---|---|
| P15-01 | `complete` (10,000 row measured-impossible) | Reproducible harness at `apps/server/src/scale/p15-01-store-scale.ts`, run with `npm run scale:p15-01`. It drives one growing session through the **real** service, repository, workflow, artifact protocol, and `JsonStore` in a fresh `mkdtemp` directory, and refuses to run outside the system temp directory so it can never touch runtime data. Only the Agent runtime is a double, and it always commits one valid `session_message` with `done: true`, so a round-robin wave is exactly one message per participant. Measured 100, 500, 1,000 and 2,000 committed turns; 10,000 is unreachable and the reason is measured, not extrapolated. See the table and findings below. |
| P15-02 | `complete` | Harness at `apps/server/src/scale/p15-02-read-path.ts` (`npm run scale:p15-02`), sharing `scale/session-harness.ts` with `P15-01` so both measure the same session the same way. Requests go through the real Fastify route via `app.inject`, so recorded bytes are wire bytes. The client was already delta-only after first load (`SessionWorkspace.tsx` passes `accumulated?.cursor`), so the sheet's "tighten the client to delta-only" condition was already satisfied and no client change was needed. Table and findings below. |
| P15-03 | `complete` | `SESSION_LIMITS.recommendedMaxSessionTurns: 2,000` and `sessionTurnWarningThreshold: 1,600` (re-measured after the `P15-05` fix; the original 500/400 came from the pre-fix numbers) added to the server `types.ts` and mirrored in the web `coordination-types.ts`, each carrying the measured reasoning. `maxSessionTurns` stays 100,000 for callers that ask explicitly, per the sheet; `defaultSessionTurns` stays 200, already below the measured recommendation. The session panel warns at 400 turns and warns harder past 500, and the create form flags a requested ceiling above the recommendation. Three new web tests (47 -> 50). |
| P15-04 | `complete` | Decision recorded as a mini-RFC in [`ASSUMPTIONS_AND_DECISIONS.md`](ASSUMPTIONS_AND_DECISIONS.md) with the `P15-01`/`P15-02` measurements as evidence: **fix the data model, defer the engine swap**. The quadratic was `inputArtifactIds`, not `JsonStore`; a repository swap would have moved those bytes without removing them. |
| P15-05 | `deferred` (data-model half implemented) | The engine swap is closed as `deferred` per the sheet's own provision, with the measured ceiling recorded. The data-model half is implemented: a session turn now pins its transcript as `inputThroughSequence` instead of listing every id, the create route refuses a session larger than the store can persist, and the trust boundary is unchanged and separately tested. Re-measured results below. **Closure condition now met:** the sheet requires the measured ceiling be recorded in `STATUS.md` *and in the operations document*; [`../COORDINATION_OPERATIONS.md`](../COORDINATION_OPERATIONS.md) now carries it. |
| P15-06 | `complete` | Root `README.md` gained a **Sessions** section: what a Session is, the middleware-not-models claim, coordinator planning, parallel waves, evidence, a five-step usage walkthrough, and seven honest limitations carrying the measured 2,000/1,600/50,000 numbers. The README previously did not document Session v2 at all, so this was additive; there were no countdown or verified-handoff-UI claims to remove. Documentation links are split into Session and Platform groups. |
| P15-07 | `complete` | The five-document set is written against the coordination model `main` carries: [`COORDINATION_ARCHITECTURE.md`](../COORDINATION_ARCHITECTURE.md), [`COORDINATION_PROTOCOL.md`](../COORDINATION_PROTOCOL.md), [`COORDINATION_API.md`](../COORDINATION_API.md), [`COORDINATION_OPERATIONS.md`](../COORDINATION_OPERATIONS.md), [`DECISIONS.md`](../DECISIONS.md). Every limit, route, status code, and measurement is read from source rather than restated from memory. |
| P15-08 | `complete` | Phase 13's sheet checkboxes and `P15-01`-`P15-04` were ticked to match this ledger; the stale `P15-03` row claiming 500/400 was corrected to the shipped 2,000/1,600; `09-release.md` is marked superseded in the sheet itself; `FILESYSTEM_MAP.md` lists the new documents. |
| P15-09 | `complete` | Fixed 23 broken links in `plans/session-v2-plan.md` (root-relative paths in a file three levels down): 3 markdown and 20 code links. All `.md` links in the repository now resolve. No local absolute paths and no undefined npm scripts. Two links to `RelayWorkspace.tsx` are deliberately left: the file is a dated historical plan and the rename is its own request 7. `.gitignore` gained `p15-02-read-path.json`, which `npm run scale:p15-02` was leaving untracked. |
| P15-10 | `complete` | [`AGENT_TEMPLATES.md`](../AGENT_TEMPLATES.md): ten collaborative participants, one coordinator-capable Agent with the structural rules that get a plan accepted, and one deliberately unreliable Agent whose first turn emits prose so the failure demo catches genuine misbehaviour. |
| P15-11 | `complete` (unrehearsed) | [`DEMO.md`](../DEMO.md): setup, a six-beat three-minute script with expected states, three failure demos, the latency and `round_robin` fallbacks, reset steps, and stated limitations. The timing range is estimated from component measurements and flagged as such, because `P15-13` has not run. |
| P15-12 | `blocked` | Needs live provider capacity to record four real runs. Ark returned sustained `429` throughout the attempt. |
| P15-13 | `blocked` | Needs `P15-12`, live capacity, and a second person to follow `README.md` and `DEMO.md` from scratch. |
| P15-14 | `not_started` | Best done immediately before the freeze. |
| P15-15 | `complete` (re-run at freeze) | The disposable Docker Compose gate passed on `main`: clean `npm ci`, 30 server files / 577 tests, 3 web files / 50 tests, both typechecks, both production builds, **exit 0** (627 tests). The Phase 2 smoke also passed through Compose: durability, restart over the same database, and redaction. |
| P15-16 | `blocked` | Browser flows need live model capacity. |
| P15-17 | `not_started` | Partly evidenced: the Phase 2 smoke asserts events carry no lease token, public attempts carry no lease token, and events carry no prompt text. A full sweep of logs, database, and payloads remains. |
| P15-18 | `not_started` | Several criteria need the live flows from `P15-16`. |
| P15-19 | `not_started` | Runtime-state hygiene, best done before judging evidence is captured. |
| P15-20 | `not_started` | The freeze itself. |

### P15-01 measured store cost

One session, ten participants, 226-character messages, `sessionPlanning: "round_robin"`.
Node v24.12.0, darwin arm64. Mutation latency is sampled from the final prompt at
each size, so every row is measured **at** that size rather than averaged across
the growth leading to it. Total harness wall clock 1,895s.

| Committed turns | DB file | Mutation p50 | Mutation p95 | Mutation max | `snapshot()` | Snapshot heap | RSS | `getRunDetails` | Last prompt end-to-end |
|---|---|---|---|---|---|---|---|---|---|
| 100 | 0.68 MiB | 2.13 ms | 3.31 ms | 4.59 ms | 0.99 ms | 1.01 MiB | 157.39 MiB | 1.97 ms | 0.14 s |
| 500 | 8.43 MiB | 26.81 ms | 29.83 ms | 37.99 ms | 11.91 ms | 12.59 MiB | 914.03 MiB | 28.01 ms | 1.65 s |
| 1000 | 29.43 MiB | 95.87 ms | 115.14 ms | 139.82 ms | 40.89 ms | 44.32 MiB | 1822.84 MiB | 92.80 ms | 6.01 s |
| 2000 | 109.22 MiB | 394.58 ms | 428.83 ms | 560.26 ms | 167.34 ms | 146.78 MiB | 1827.39 MiB | 361.59 ms | 23.84 s |

### P15-01 findings

1. **Everything is quadratic, and the cause is a single line.** Every scheduled
   turn stores `inputArtifactIds` for the whole transcript so far
   (`session-workflow.ts` lines 257, 306, 336), so turn *n* stores *n* ids and
   the ledger stores O(n^2) of them. At 400 turns, `coordinationTurns` is
   **70.9%** of the file and **93%** of that is `inputArtifactIds` - 88,000 id
   entries. Cost per committed turn rises from **7.2 KB at 100 turns to 57.3 KB
   at 2,000**. This is a data-model property, so no storage engine fixes it on
   its own: a swap under `CoordinationRepository` moves the bytes without
   removing them.
2. **A hard failure exists well below the documented ceiling.** `persist()`
   serialises the entire database into one string
   (`JSON.stringify(data, null, 2)`, `store.ts` line 154). Node's
   `MAX_STRING_LENGTH` is **512 MiB**; exceeding it throws
   `RangeError: Invalid string length`, verified directly rather than assumed.
   Fitting the seven measured sizes (100/200/400/500/800/1,000/2,000) gives
   `MiB = 2.5175e-5*n^2 + 4.2597e-3*n`, which reproduces every measured point to
   within **0.3%**, and reaches 512 MiB at **n ~= 4,426 committed turns**. That
   is **4.4%** of `SESSION_LIMITS.maxSessionTurns` (100,000). Past it a session
   cannot be saved at all - this is data loss, not slowness.
3. **Memory is a second wall, and it arrives first.** `mutate` holds the live
   database plus a full `structuredClone`. RSS reached **1.83 GiB at 1,000
   turns** against Node's ~4 GiB default old-space. The process was already over
   half its heap budget at 1,000 turns, so the practical limit is lower than the
   4,426-turn serialisation limit.
4. **The product is unusable long before any of those limits.** End-to-end
   latency for one user prompt goes **0.14s -> 1.65s -> 6.01s -> 23.84s** across
   100 -> 2,000 turns: **171x slower for 20x the turns**. A 24-second wait for a
   single prompt is past any reasonable interactive threshold, and 2,000 turns is
   only 2% of the documented ceiling. The current default,
   `SESSION_LIMITS.defaultSessionTurns` of **200**, is defensible; the 100,000
   ceiling is not.
5. **Why 10,000 was not measured.** It needs ~2.5 GiB in one JSON string, roughly
   five times Node's limit, so it would throw before completing. Reaching even
   the 4,426-turn failure point costs hours of quadratic mutations - the 2,000
   row alone took 32 minutes. The row is therefore recorded as measured-impossible
   with the mechanism identified, rather than filled in by extrapolation, which
   the phase sheet forbids.

### P15-02 measured read path

Same session shape as `P15-01`. Requests go through the real route with
`app.inject`, so these are wire bytes. "Wave delta" is a poll issued from the
pre-wave cursor while one ten-participant wave is in flight - 32 events in every
row, so the rows are directly comparable. Polling cost per minute assumes the
client's 1.5s cadence (40 polls). Total harness wall clock 1,660s.

| Committed turns | Full read | Full read time | Idle delta | Wave delta | Delta read time | Full-poll cost/min | Delta-poll cost/min | Saving |
|---|---|---|---|---|---|---|---|---|
| 100 | 0.53 MiB | 7.68 ms | 1,617 B | 80,798 B | 3.15 ms | 21.25 MiB | 3.08 MiB | 6.9x |
| 500 | 6.74 MiB | 62.17 ms | 1,619 B | 252,422 B | 30.37 ms | 269.74 MiB | 9.63 MiB | 28.01x |
| 1000 | 23.71 MiB | 154.91 ms | 1,620 B | 466,996 B | 101.98 ms | 948.59 MiB | 17.81 MiB | 53.25x |
| 2000 | 88.35 MiB | 622.77 ms | 1,620 B | 895,996 B | 369.53 ms | 3,533.95 MiB | 34.18 MiB | 103.39x |

### P15-02 findings

1. **The delta model is load-bearing and already correct on the client.** It
   saves **103x** of bandwidth at 2,000 turns. Full-fetch polling would cost
   **3.53 GiB per minute per viewer** there, which is not a product. The client
   has passed a cursor since `P12-13`, so the sheet's conditional client change
   was already in place and nothing was tightened.
2. **The delta saves bytes but not server time.** `GET /:id?sinceSequence=`
   calls the full `getRun` and filters afterwards (`routes.ts` line 134), so an
   idle poll returning **1,620 bytes still costs 355.5 ms** at 2,000 turns. At
   the 1.5s cadence that is **23.7% of a core per idle viewer**, for a payload
   that says nothing changed. Ten idle viewers would saturate more than two
   cores displaying no new information. This is the single cheapest thing to
   fix in `P15-05`: filter before cloning, or index events by sequence.
3. **The quadratic leaks into the delta payload.** The same 32 events cost
   **80 KB at 100 turns and 896 KB at 2,000** - 11x more bytes for identical
   information - because each delta turn carries its whole-transcript
   `inputArtifactIds`. Trimming that field from the read model would shrink both
   the delta and the full read without touching storage.
4. **First open is the worst moment.** A session at 2,000 turns makes a browser
   download **88.35 MiB** before it can render anything, and the server spends
   622.77 ms building it. Even at the recommended 500-turn length it is 6.74 MiB.
   A paginated or artifact-only first read belongs in the `P15-05` scope.

### P15-03 recorded practical ceiling

**Measured recommendation: 2,000 committed turns**, re-measured after the
`P15-05` fix. One prompt takes 0.45s at 500, 0.94s at 1,000 and 2.06s at 2,000,
so 2,000 is where a prompt first crosses two seconds.
`recommendedMaxSessionTurns` is 2,000 and the UI warns from 1,600. The
pre-fix figures that first set this at 500 (1.65s / 6.01s / 23.84s) are kept in
the `P15-01` table above as the before-and-after evidence.

`defaultSessionTurns` stays **200**: it was already below the measured
recommendation, so no default needed widening or narrowing, and changing a
shipped default without cause would be churn.

`maxSessionTurns` stays **100,000** as the type-level ceiling, but the create
route now refuses more than `maxSaveableSessionTurns` (**50,000**, about half
the measured post-fix serialisation limit). This deviates from the sheet's "the
ceiling stays available for callers who ask for it": a request that large was
measured to be unsaveable, and refusing a request is recoverable where losing a
session is not. The deviation is recorded in the `P15-04` mini-RFC.

### P15-05 measured result of the data-model fix

Same harness, same session shape, re-run after replacing per-turn
`inputArtifactIds` with a single `inputThroughSequence` bound.

| Committed turns | DB before | DB after | Mutation p50 before | after | Prompt before | after |
|---|---|---|---|---|---|---|
| 100 | 0.68 MiB | **0.43 MiB** | 2.13 ms | **1.48 ms** | 0.14 s | **0.09 s** |
| 500 | 8.43 MiB | **2.14 MiB** | 26.81 ms | **6.93 ms** | 1.65 s | **0.45 s** |
| 1000 | 29.43 MiB | **4.28 MiB** | 95.87 ms | **14.50 ms** | 6.01 s | **0.94 s** |
| 2000 | 109.22 MiB | **8.56 MiB** | 394.58 ms | **30.33 ms** | 23.84 s | **2.06 s** |

- Growth is now **linear** at ~4.28 KB per committed turn. The four sizes give
  0.43 / 2.14 / 4.28 / 8.56 MiB - exactly proportional - against the previous
  0.68 / 8.43 / 29.43 / 109.22.
- At 2,000 turns the database is **92% smaller**, a mutation is **13x faster**,
  and one prompt is **11.6x faster**. Whole-harness wall clock fell from
  **1,895s to 196s**.
- The serialisation wall moved from **~4,426 turns to ~120,000**, past the
  advertised ceiling. The store now fails on time, not on correctness.
- What is unchanged: `JsonStore` still rewrites the whole document per mutation,
  so a mutation is still O(file size) and building a long session is still
  O(n^2) in time. That is the remaining case for an engine swap, and it is now a
  performance argument rather than a data-loss one.

### P15-05 recorded contract change

`CoordinationTurn.inputThroughSequence` is additive and optional. Turns stored
before this change carry the full id list and no bound; the context builder
keeps the original path for them, so no migration is required and no stored
history is rewritten.

The trust boundary is explicitly preserved rather than assumed. The bound covers
only `session_message` and `user_message` - exactly the set the id list held -
and anything outside the transcript stays named explicitly, so a bound can never
widen a turn onto a plan the workflow did not choose. Four new context-builder
tests cover this, including one that plants an unnamed `session_plan` inside the
bound and asserts its instruction never reaches the prompt.

Two tests that asserted the old encoding were updated to assert the new one; the
behaviour they pin - which transcript a turn may read - is unchanged, and the
equivalence is now asserted directly by comparing a bounded turn's prompt and
digest against the id-listed turn's.

Server tests 571 -> 577, web 47 -> 50.

### Phase 15 recorded deviation

The sheet's entry criteria ask for a `phase-15` task branch from the completed
Checkpoint 14. `P15-01` was done on `main` instead, at the user's explicit
instruction not to create branches. `P15-01` adds no product code - one new
harness under `apps/server/src/scale/`, one npm script, and this record - so the
deviation carries no risk to the shipped engine. Later Phase 15 tasks that do
change product code should get their own branch.

The sheet also asks that no feature work remain open at Phase 15 entry. The
auction track on `bidding-agent-phase-14-award` is unmerged and incomplete
(`PA14-18`, `PA14-27`), and `docs/development/phases/parallel/README.md` treats it
as an alternative that has not been compared against the main track. Phase 15
documents and freezes whichever coordination model `main` carries, so that
comparison should be settled before `P15-06`-`P15-08` are written.

## Phase 12 task ledger

| Task | Status | Current implementation/evidence |
|---|---|---|
| P12-01 | `complete` | Added durable `awaiting_input` and the pure `await_input` workflow decision across server, repository, workflow, web polling, and status rendering. Idle sessions have no active turn or loop. |
| P12-02 | `complete` | Added the strict, trimmed, 1..4,000 character `user_message` artifact with user provenance. Exhaustive artifact maps were widened; Agent output that forges a user message is rejected. |
| P12-03 | `complete` | User and Agent transcript artifacts receive one atomic, per-run `transcriptSequence`. Legacy artifacts without it sort first by timestamp, with direct regression coverage. |
| P12-04 | `complete` | `lastUserArtifactId` and `endedByUser` are additive optional run fields, so old JSON stores load without migration. |
| P12-05 | `complete` | `appendUserMessage` performs admission, idempotency, sequence allocation, artifact/event append, pointer/status/version changes, and first-wave start evidence in one store mutation. Event details never contain message content. |
| P12-06 | `complete` | `resumeRun` drives the existing loop and handles `await_input`. Loop epochs fence late runtime completions and the narrow idle-loop cleanup race, so a resumed wave cannot be stranded or touched by an earlier owner. |
| P12-07 | `complete` | Stop now cancels only the current session wave and returns to `awaiting_input`; End is a separate idle-only terminal action with `endedByUser: true`. The UI labels the control `Stop wave` and explains both consequences. |
| P12-08 | `complete` | Restart leaves idle sessions byte-for-byte resumable; an interrupted active session wave is settled and returned to `awaiting_input`. Verified handoffs retain their Phase 11 terminal restart behavior. |
| P12-09 | `complete` | Authenticated `POST /api/coordination-runs/:id/messages` validates the strict body and returns 202. `clientMessageId` makes a duplicate last send a no-op; conflicts, terminal runs, unknown ids, body limits, and auth are covered. |
| P12-10 | `complete` | Optional inclusive `sinceSequence` detail reads return the full current run, linked deltas, and an explicit next cursor with leases stripped. Full reads retain their prior shape. Live cursor 25 returned events 25..35 and cursor 36. |
| P12-11 | `complete` | Context interleaves `User:` and Agent lines in transcript order, treats the newest user message as the current request, preserves it in full through recency degradation, and retains all leakage and stable-digest guarantees. |
| P12-12 | `complete` | The session workspace is now create-and-chat: distinct user/Agent transcript rows, an idle composer, working indicator, and separate Stop wave/End controls. This explicitly supersedes P8-05's two-step create/start interaction for sessions; verified handoffs remain read-only. |
| P12-13 | `complete` | One 1.5-second cursor chain incrementally merges records, stops on idle/terminal state, restarts on send, and cleans up on switch/unmount without overlapping or accumulating requests. |
| P12-14 | `complete` | Durable three-prompt, duplicate-send, running-conflict, prompt-versus-commit, total-order, gapless-event, and monotonic-version tests are green. |
| P12-15 | `complete` | Lifecycle tests cover idle restart, mid-wave restart, stop then send, late-result fencing, idle End immutability, and running End rejection. |
| P12-16 | `complete` | Web tests cover disabled-while-working, semantic user/Agent distinction, delta append, Stop then send, End disablement, bounded scrolling, labels, keyboard behavior, single-chain cleanup, switch, and unmount. |

### Checkpoint 12 verification evidence

- The exact disposable Docker Compose gate from the phase sheet passed: **28
  server files / 517 tests**, **3 web files / 43 tests**, both workspace
  typechecks, and both production builds (**560 tests total**).
- The Phase 12 API/repository/context durability set ran three consecutive
  times: **124 tests per pass, three passes, zero failures**.
- Live Compose run `4de8b8fd-451a-4133-a0ff-9111928ff5a0`, "Phase 12 live
  verification", used one participant set of three ready Agents for three real
  prompts. All **9 turns / 9 attempts succeeded on attempt 1**. The resulting
  transcript has **12 artifacts** (3 user + 9 Agent), sequences exactly 1..12,
  **2,095 content characters**, and no fork.
- Prompt sizes were **144**, **166**, and **156** characters. Wave latencies,
  measured from `user.message_appended` to `run.awaiting_input`, were **7.183s**,
  **6.231s**, and **5.589s**.
- The server restarted while wave 1 was idle (`01:12:10Z` to `01:12:11Z`). The
  same run reloaded as `awaiting_input`, version 12, with its four transcript
  artifacts and sequences 1..4 unchanged; waves 2 and 3 then continued that run.
- Before End, events were gapless 1..35. The live delta read at cursor 25
  returned linked records for wave 3 and cursor 36. End appended event 36,
  produced `completed`, `endedByUser: true`, version 35, and a later prompt was
  rejected with `409 INVALID_STATE`.
- The production-built web surface was served by the same Compose deployment,
  and its full 43-test UI suite is green. A visual automation pass could not be
  performed: the available in-app browser was isolated from localhost and no
  Chrome/Safari/Firefox app was exposed to desktop control. This is a tooling
  limitation, not missing lifecycle evidence; no visual result is claimed.
- `npm ci` reports the unchanged dependency audit finding: **1 moderate and 5
  high vulnerabilities**. Phase 12 changed no dependency versions; remediation
  remains release-hardening work.

## Phase 14 task ledger

| Task | Status | Current implementation/evidence |
|---|---|---|
| P14-01 | `complete` | `session_plan` added to `CoordinationTurnKind` and `ArtifactType`, with `SessionPlanPayload`/`SessionPlanAssignment`, the strict bounded `sessionPlanPayloadSchema`, and `SESSION_LIMITS.planInstructionMaxChars`. Adding the union member compile-failed four exhaustive `Record<CoordinationTurnKind, ...>` maps (`EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND`, `TURN_KIND_LABELS`, the repository copy, and the verified-handoff `expectedOutput`), exactly as P7-02 discipline intends; `ROLE_VISIBILITY`, `capPayload`, `OUTPUT_SHAPES`, and `OUTPUT_LIMITS` were widened alongside. |
| P14-02 | `complete` | The structural validator runs after the frozen parsing order: participant membership, distinct ids, contiguous positions from 1, count within the roster, bounded non-empty instruction, literal mode. Rejections are `INVALID_AGENT_OUTPUT` and **echo no Agent-supplied value** - a forged agent id is refused without being quoted back. 22 tests in `session-plan-protocol.test.ts`. |
| P14-03 | `complete` | `SharedSessionWorkflowV1` schedules exactly one `session_plan` turn per user message, assigned to `participants[0]` per the recorded D3 decision. Planning state is derived from committed artifacts (a plan whose `transcriptSequence` exceeds the active user message's), never stored, so a retry cannot duplicate it and a restart re-derives it. Plans are allocated a `transcriptSequence` on commit in both the durable and in-memory repositories. |
| P14-04 | `complete` | `sequential` schedules assignments strictly in `position` order, one turn at a time; `parallel` emits one `schedule_wave`, still bounded by `maxParallelTurns`. The round returns `await_input` when every assignment has committed - including a partial plan that assigns fewer participants than the roster. |
| P14-05 | `complete` | `policy.sessionPlanning: "coordinator" \| "round_robin"` defaults to `"coordinator"`, is validated in the route schema and the service, and is exposed as a create-form control. `round_robin` schedules no plan turn; stored pre-Phase-14 sessions carry no field and are read as `round_robin`. |
| P14-06 | `complete` | A `session_turn` under an active plan renders **only its own** assignment instruction and its position in the round; the plan artifact is excluded from the transcript block so it is not read as a chat message. The `session_plan` prompt carries `Role: coordinator`, the roster with names and ids, the transcript, and the plan output contract. No prompt states an expected answer. |
| P14-07 | `complete` | Countdown deleted from the engine: `SessionProtocol` is now the single member `"free_chat"`; `sessionStartValue`, `CoordinationSharedState`, `run.sharedState`, `nextCountdownValue`, the workflow branch, the protocol branch, the context-builder instruction, the route/service validation, and the `SESSION_LIMITS` start-value bounds are gone. **Stored history is untouched**: `normaliseRun` spreads a `structuredClone`, so legacy fields survive a read and are returned through the API. Two fixture tests assert it (see below). |
| P14-08 | `complete` | Web: the planning control is on the create form, the committed plan renders as an attributed "Round plan" evidence card ordered by position (not as a transcript message), and the session-state panel shows the policy. The P10-07 legacy render path for stored countdown runs is retained deliberately. `overview-sessions.md` Sections 1, 2, 6.1 and 6.5 now describe planned ordering; the deleted countdown design is retained as historical Section 6A. The acceptance-demo change is recorded in `ASSUMPTIONS_AND_DECISIONS.md`. |
| P14-09 | `complete` | 22 plan-validation tests: valid sequential/parallel, partial plans, out-of-array-order positions, non-participant id, duplicate ids, position 0, gapped positions, duplicated positions, over-roster count, zero assignments, oversized and empty instruction, unknown mode, prose-wrapped, unknown root and nested fields, bad schema version, plan-for-message-turn, message-for-plan-turn, non-session run. One test drives a real rejection through `RoleScopedContextBuilder` and proves the retry prompt names the rule and carries neither the rejected plan nor the lease. |
| P14-10 | `complete` | 24 workflow tests across pure decisions and the real service: exactly one plan per user message, no duplicate after a rejection, sequential order by `position`, one parallel wave, `await_input` on completion, `round_robin` schedules no plan, legacy runs read as round robin, restart mid-round re-derives the same work, stop settles the whole planned round back to `awaiting_input`, two prompts plan separately, per-participant instruction isolation, coordinator roster prompt, and a live retry that commits exactly one plan. |
| P14-11 | `complete` | Three live ten-Agent rehearsals on the Compose deployment, each running the ordered countdown prompt (sequential plan, transcript 10→1 in order, no numeric validator), the fan-out prompt (parallel wave), and a third prompt (session returned `awaiting_input` every time). A genuine plan rejection with recovery was captured in run `f8ae3635`: attempt 1 emitted a malformed plan (`attempt.invalid_output`), attempt 2 corrected and committed. See the Checkpoint 14 evidence below. |

### Checkpoint 14 verification evidence

- **Canonical Docker Compose gate passed** on `phase-14` (disposable `npm run
  check` with `LAUNCHPAD_ENV_FILE=/dev/null`): **30 server files / 571 tests**,
  **3 web files / 47 tests**, both typechecks, and both production builds. The
  `__proto__` security test passes under the locked `zod` 4.4.3 installed by
  `npm ci`, so the host-runner drift failure from the earlier caveat does not
  reproduce in the canonical environment.
- **Three live ten-Agent rehearsals** (`P14-11`), one session each, coordinator
  planning on, three prompts (ordered countdown, fan-out, third prompt):

| Run | Countdown (10→1) | Fan-out | Third prompt | End state |
|---|---|---|---|---|
| `b1f291a8` | 22.72s | 8.27s | 9.54s | `awaiting_input` |
| `7d750f5c` | 19.10s | 7.79s | 8.31s | `awaiting_input` |
| `c4890719` | 22.88s | 9.37s | 6.81s | `awaiting_input` |

  Countdown range **19.10s–22.88s**. In every rehearsal the coordinator emitted
  `mode=sequential` with ten `position`-ordered assignments, the transcript read
  10, 9, 8, … 1 in exact order with correct attribution, the fan-out emitted
  `mode=parallel` as one wave, and the third prompt left the session live. No
  numeric validator exists in the engine; the ordering came from the plan and the
  transcript alone.
- **Genuine plan rejection with recovery** (run `f8ae3635`, a
  deliberately-tuned coordinator mirroring the P15-10 unreliable-Agent
  technique): attempt 1 produced a malformed plan and was rejected with
  `attempt.invalid_output`; attempt 2 corrected and committed
  (`turn.committed`). This is real middleware rejection and real retry recovery,
  not simulated.
- Net diff: **25 files changed, 1,292 insertions, 814 deletions**, plus two new
  test files.

### Phase 14 environment caveats (resolved)

The earlier caveat is superseded: the Docker daemon is now reachable, so the
canonical disposable-Compose gate and the live rehearsal above were both run in
the proper environment. The host-runner numbers recorded during implementation
were replaced by the canonical gate evidence above; the `zod` 4.5.4 drift is
still noted under "Known blockers and risks" for the Phase 15 release review, but
it no longer blocks Checkpoint 14.

### Phase 14 recorded test changes

No test was deleted to make a change pass. Three categories of change occurred,
each a consequence of a deliberate contract change:

1. **Pinned, not weakened.** `CREATE_FREE_CHAT_REQUEST` and the durable
   wave/multi-prompt suites now pass `sessionPlanning: "round_robin"`
   explicitly. Those tests assert round-robin and parallel-wave mechanics, which
   is exactly what `round_robin` continues to name; P14-05 changed only the
   *default*. The behaviour each test proves is unchanged.
2. **Retargeted, not dropped.** Tests that used countdown payloads as a vehicle
   for *generic* session-message behaviour - fences, prose, empty and oversize
   content, forged provenance, retry-on-invalid, timeout retry, stop fencing -
   were retargeted at free chat so the coverage survives the protocol deletion.
   `EMPTY_CONTENT_OUTPUT`, `OVERSIZE_CONTENT_OUTPUT`, `FORGED_PROVENANCE_OUTPUT`,
   `FENCED_MESSAGE_OUTPUT`, and `PROSE_MESSAGE_OUTPUT` are the retargeted
   fixtures.
3. **Deleted with the protocol.** Only assertions about countdown *semantics*
   were removed: exact-next-integer validation, `done`-rejected-on-countdown,
   shared-state decrement, countdown completion at 1, countdown turn-ceiling,
   and the countdown start-value policy table.

Two new fixture tests replace them and discharge the P14-07 compatibility
requirement: a stored `LEGACY_COUNTDOWN_RUN` still loads and reads back with its
`sharedState`, `sessionProtocol: "countdown"`, and `sessionStartValue` intact,
and a stored live countdown run is refused by the workflow with `INVALID_STATE`
rather than being scheduled.

## Phase 13 task ledger

| Task | Status | Current implementation/evidence |
|---|---|---|
| P13-01 | `complete` | Replaced the live pointer with `activeTurnIds`; reads of legacy records still present `activeTurnId` as a one-element array without rewriting stored history. Verified handoff remains single-turn through the existing wrapper and regression matrix. |
| P13-02 | `complete` | `scheduleTurns` atomically persists a whole wave under one version check, advances sequences by wave size, and emits one scheduling event per sibling. `scheduleTurn` delegates to it. |
| P13-03 | `complete` | Independent sibling commit/retry/cancellation removes only that sibling from the live array. Stop, failure, reconciliation, and restart settle all remaining siblings in one durable mutation. |
| P13-04 | `complete` | `schedule_wave` is a typed workflow decision. With `sessionParallel`, free-chat deterministically selects each distinct participant not yet represented after the active user message; the default remains sequential. |
| P13-05 | `complete` | Session validation accepts concurrent committed histories while rejecting foreign records, duplicate identities, unknown participants, uncommitted artifacts, and non-session artifacts. |
| P13-06 | `complete` | The service schedules waves atomically and supervises bounded workers through all settlement outcomes. A structured or unexpected worker failure is collected only after siblings settle. |
| P13-07 | `complete` | Route and service validate `maxParallelTurns` in 1..10; the default is `min(participantCount, 4)`. The scripted-runtime test observes a six-member wave executing in batches of two. |
| P13-08 | `complete` | An already-running Agent is retried with bounded backoff under the normal attempt cap, without aborting other siblings. |
| P13-09 | `complete` | Durable tests prove atomic scheduling, concurrent commits, stale leases, concurrent retry/commit settlement, stop fencing, restart settlement, and gapless event sequencing. |
| P13-10 | `complete` | Supervisor coverage proves batching, whole-wave stop, busy retry, a timeout/retry-exhaustion alongside a successful sibling, and durable mid-wave restart settlement. |
| P13-11 | `complete` | Workflow tests cover deterministic wave membership, accepted non-round-robin parallel history, corrupt histories, and the unchanged verified workflow matrix. |
| P13-12 | `complete` | The web transcript orders concurrent messages by durable transcript sequence, attributes each message, displays the active wave size, and retains the stop-wave pending/settled interaction. |

### Phase 13 automated verification evidence

- `docker compose build launchpad` completed successfully using the local Node
  22 Compose image.
- The disposable Compose `npm run check` passed after the final change: **28
  server files / 536 tests**, **3 web files / 44 tests**, both workspace
  typechecks, and both production builds.
- The Phase 13 durable-wave and supervisor suites
  (`repository.test.ts` + `session-walking-skeleton.test.ts`) passed **ten
  consecutive Compose runs**, **101 tests per run**, with zero failures. The
  final full gate includes the one additional sibling-failure regression test.
- `npm ci` reports the existing dependency audit finding: **1 moderate and 5
  high vulnerabilities**. Phase 13 did not change dependencies.

### Checkpoint 13 live verification evidence

Two real parallel waves on `main` (`7985ca3`), Compose deployment, configured
provider endpoint, local-process runtime, `sessionParallel` enabled with the
default cap `min(participants, 4)`:

- Six participants (`5e04164e`): 6 turns / 6 attempts, all succeeded on attempt
  1, 4.15s prompt-to-idle, 22 gapless events, transcript 1..7, cap 4 enforced
  (4 attempts started, then 2 as slots freed), every Agent returned ready.
- Ten participants (`492a52c3`): 10 turns / 10 attempts, all succeeded on
  attempt 1, 5.14s prompt-to-idle, 34 gapless events, transcript 1..11, cap 4
  enforced (never more than 4 attempts in flight), every Agent returned ready.
- Peak container memory 151.7 MiB (3.7% of the 4 GiB cap); zero provider
  rate-limit (429) responses in either run.
- Speed-up vs the Phase 10 sequential baseline (~44s for a ten-participant
  round, median 4.43s per turn): 5.14s parallel is roughly 8.5x, recorded with
  the baseline alongside as the sheet requires.

This closes Checkpoint 13; the phase is `complete`.

## Phase 11 stale-path classification (P11-01 deliverable)

Every exit from `runLoop` or `executeTurnWithRetries` that did not make a
terminal repository call, with the response the reconciler owes it. Before Phase
11 all six `abandoned` rows were a bare `return false`: the loop returned and the
run stayed `running` with its `activeTurnId` set and its participants reserved,
with nothing left to drive it. That is the reported "stuck Agents" defect.

| # | Exit | Condition | Class | Response |
|---|---|---|---|---|
| 1 | `runLoop` reload | run missing, or status not `running` | already owned | Return. Whoever made it non-running owns the next transition. |
| 2 | `runLoop` `scheduleTurn` | `not_found` | already owned | Return. A deleted run has nothing to settle and reserves nobody. |
| 3 | `runLoop` `scheduleTurn` | `stale` | resume | Already correct: `continue` re-derives from the reloaded run. |
| 4 | `executeTurnWithRetries` reload | run missing, or status not `running` | already owned | `settled`. Return. |
| 5 | `executeTurnWithRetries` reload | turn no longer `scheduled` | **resume** | `abandoned`. Reconcile, then continue. |
| 6 | `beginAttempt` | `stale` or `not_found` | **resume** | `abandoned`. `stale` covers both "run stopped" and "turn superseded"; the reconciler reloads and tells them apart. |
| 7 | `attachAgentRun` | `stale` | **resume** | `abandoned`. The runtime is cancelled first, then the turn is reconciled. |
| 8 | `commitAcceptedArtifact` | anything but `committed` | **resume** | `abandoned`. The commit lost its lease; turn and attempt are left exactly as the reconciler expects. |
| 9 | `finishAttempt` | `stale`, on any of the four retry paths | **resume** | `abandoned`. The attempt is left running with no owner. |
| 10 | cancelled outcome | run still `running` | already correct | `failRun` is already called; `settled`. |
| 11 | attempt ceiling reached | - | already correct | `failRun` with `MAX_ATTEMPTS_EXCEEDED`; `settled`. |

**Every known stale path is resumable.** `RUN_ABANDONED` is therefore reserved
for the residue the phase sheet anticipates: a run that has been reconciled
`MAX_CONSECUTIVE_RECONCILIATIONS` (3) times without committing a turn is failed
rather than left to spin. A committed turn resets that budget.

## Phase 11 task ledger

| Task | Status | Current implementation/evidence |
|---|---|---|
| P11-01 | `complete` | The classification table above. Six exits reclassified from "silent return" to `abandoned`; five to `settled`/already-correct. |
| P11-02 | `complete` | `RUN_ABANDONED` in `CoordinationErrorCode`; `run.reconciled` in the frozen event set with a `runReconciled` factory. Both carry only allowlisted detail keys (`code`, `reason`), so `ALLOWED_EVENT_DETAIL_KEYS` is unchanged. Mini-RFC recorded in `ASSUMPTIONS_AND_DECISIONS.md`. `events.test.ts` asserts the widened frozen set and message; `redaction.test.ts` plants a lease token in the reason and proves it is replaced. |
| P11-03 | `complete` | `executeTurnWithRetries` returns a three-way `TurnExecutionOutcome` instead of a boolean, so every exit is classified at the call site. `reconcileAbandonedLoop` reloads, returns `false` when the run is gone or owned, resumes on `reconciled`/`noop`, and fails with `RUN_ABANDONED` once the budget is spent. |
| P11-04 | `complete` | `listNonTerminalRuns` reports `running`/`stop_requested` runs with their `activeTurnId` and whether any attempt is durably `running`. `reconcileRun` settles a stranded turn and attempt in one `JsonStore.mutate()` through the existing `settleActiveWork`, appends `run.reconciled`, bumps `version`, and leaves the run `running`. Idempotent (`noop`, no event, no version bump), refuses terminal runs, and keeps the per-run event sequence gapless - all asserted. |
| P11-05 | `complete` | Reservation narrowed to "holds a running attempt in a non-terminal run" across `collectReservedAgentIds`, `findReservingRunId`, and `assertDatabaseAgentNotReserved`. `startRun` admission stays run-level through a separate `collectEnrolledAgentIds`, so the existing verified-handoff reservation tests pass unchanged. Advisory `getReservingRunSummary` added for display. Two-level model recorded in `ASSUMPTIONS_AND_DECISIONS.md`. |
| P11-06 | `complete` | `initialize` reconciles after `interruptActiveRuns` (a no-op on a healthy boot) and starts a bounded sweep; `shutdown` clears it. `reconcileUnownedRuns` skips any run with a live loop, finishes `stop_requested` runs, reconciles the rest, and gives a resumable run a loop again. Interval is `COORDINATION_RECONCILE_INTERVAL_MS` (default 60,000; `0` disables). Every test injects `0` so no test depends on a wall-clock tick. |
| P11-07 | `complete` | An Agent in `error` shows `lastError` and a `Reset to ready` control on its detail, calling the existing `POST /api/agents/:id/start`. One sentence states that resetting returns it to ready and does **not** retry the failed run. No new server route. |
| P11-08 | `complete` | `Agent is reserved by the session "<name>"` replaces `Agent is reserved by coordination` on every refusal path, sourced from the advisory read. The error banner offers `View session` on `AGENT_RESERVED`, which opens the session surface. No lease, prompt, or run internals are exposed beyond the name already in the run index. |
| P11-09 | `complete` | Six regression tests in `coordination/lifecycle-reconciliation.test.ts`, one per stale path: turn superseded, `beginAttempt` stale, `attachAgentRun` race, commit that loses its lease, `finishAttempt` stale, `scheduleTurn` not-found. **All six were run against a simulated pre-fix service and all six failed**, then passed unchanged on the fixed code. Deferred promises and injected repository results only - no sleeps. |
| P11-10 | `complete` | Five invariant tests over the durable repository and a real temporary `JsonStore`. `assertReservationInvariant` recomputes "no Agent is reserved unless some non-terminal run has a running attempt for it" from raw durable state and compares it with `listReservedAgentIds`, at every settlement point of the interleaving matrix: stop during an attempt (with a late result arriving afterwards), outright attempt failure, restart during an attempt, two runs contending for one Agent, and a sweep while a live loop owns the run. The restart test proves `initialize` settles a crashed run and frees its Agents, and that a second `initialize` changes nothing byte-for-byte. |
| P11-11 | `complete` | Six tests in `apps/web/src/App.recovery.test.tsx`: an errored Agent shows its message and resets through `startAgent`; a healthy Agent offers no control; the hint does not claim a retry; a null `lastError` falls back to a plain sentence; the reserved banner names the session, leaks no lease, and links to it; an unrelated failure offers no link. |

### Phase 11 verification evidence

- The final disposable Docker Compose gate on merged `main` passed both
  typechecks, **28 server files / 503 tests**, **3 web files / 37 tests**, and
  both production builds (540 tests total).
- Race and reconciliation suites (`lifecycle-reconciliation.test.ts` +
  `repository.test.ts`, 72 tests) run **ten consecutive times: ten passes, zero
  failures**, as the phase sheet requires before they may be called stable.
- **Pre-fix falsification:** the service was temporarily patched so every
  `abandoned` exit ended the loop and the sweep returned nothing - the pre-Phase-11
  behaviour. All six `P11-09` tests failed under that patch and pass on the
  restored code, so each one genuinely discriminates the fix.
- No test was deleted to make a change pass. Three tests were **updated** because
  the P11-05 decision deliberately changed the contract they asserted; each is
  justified in `ASSUMPTIONS_AND_DECISIONS.md` and now proves the new rule.

## Phase 10 task ledger

| Task | Status | Current implementation/evidence |
|---|---|---|
| P10-01 | `complete` | Session v2 mini-RFC recorded in `ASSUMPTIONS_AND_DECISIONS.md` with the six amendments, each naming its implementing phase, plus the recorded answers to the open questions. `overview-sessions.md` carries 14 `[v2, Phase N]` amendments across Sections 1, 2, 4, 6.5, 7, 8, 11, and 12. |
| P10-02 | `complete` | `FILESYSTEM_MAP.md` has primary/conditional path sections for Phases 10-15. |
| P10-03 | `complete` | `SESSION_LIMITS.maxParticipants` is 10; `routes.ts` reads `SESSION_LIMITS` instead of literals for participants and start value. Boundary tests at 2, 10, and 11 participants prove the service and the route share one source of truth. |
| P10-04 | `complete` | `minSessionTurns` 3, `maxSessionTurns` 100,000, `defaultSessionTurns` 200 replace the free-chat trio. Tests accept 13, 1,000, and 100,000 turns, reject 2, 100,001, and 12.5, and prove the verified workflow still rejects `maxTurns: 13` and accepts 12. |
| P10-05 | `complete` | Session runs get `SESSION_CONTEXT_MAX_CHARS` (40,000). The session prompt ladder now drops whole oldest messages behind `[earlier messages omitted]` before any text truncation, and `truncated` reports either kind so `attempt.started` evidence stays honest. Four context tests cover fit, drop, drop-then-truncate, and a 40-message transcript. |
| P10-06 | `complete` | The web app has no workflow toggle, role selects, required-sections editor, or `maxRevisions`. Verified runs open read-only behind a `Legacy workflow` banner with no start/stop action; all seven verified fixtures render, asserted per fixture. |
| P10-07 | `complete` | No protocol choice in the UI; every created session sends `sessionProtocol: "free_chat"`. Stored countdown sessions still render their transcript, protocol row, and `nextExpectedNumber`/`Complete` state. The countdown engine branches are untouched and still tested; `P14-07` deletes them. |
| P10-08 | `complete` | `RelayWorkspace.tsx` is `SessionWorkspace.tsx`, the 68 `relay-*` CSS rules are `session-*`, and the nav, hero, run index, actions, and copy say Session. `App.tsx`'s `workspaceView` union is `"agents" \| "session"`. No behaviour changed with the rename. |
| P10-09 | `complete` | 29 web tests: every session fixture, every verified fixture read-only, ten-participant create, ceiling disablement, turn-range validation, a 5,000-turn create, consensus, escaping, the three polling-chain proofs, and stop. |
| P10-10 | `complete` | Ten fresh demo Agents completed a real twelve-turn free-chat session in the Compose deployment on the `deepseek-v4-flash-ga-260731` endpoint. Evidence below. |

### Phase 10 verification evidence

- The full disposable Docker Compose gate passed on `phase-10-session-v2-surface`
  with `LAUNCHPAD_ENV_FILE=/dev/null`: **27 server files / 485 tests**, **2 web
  files / 31 tests**, both typechecks, and both production builds (516 tests
  total, up from 501 at Checkpoint 8).
- Server tests rose 474 → 485 and web tests 27 → 31. No test was deleted to make
  a change pass: the six pre-existing failures after the limit raise were each a
  deliberate contract change, and each was re-pointed at the new contract.
- The web dev dependencies are not installed on the host, so all web
  verification ran through Compose, as the runbook requires.

### Checkpoint 10 live rehearsal evidence (P10-10)

Run `74fbd288-89d6-4a4a-bd5d-3443f994e465`, "P10-10 ten-participant rehearsal",
ten fresh Agents, free chat, `maxTurns` 12, 120s attempt timeout, model
`deepseek-v4-flash-ga-260731`, runtime provider `local-process`.

- **Result:** `completed` at the turn ceiling. Start-to-completion **52.865s**
  (`15:49:36.481Z` to `15:50:29.170Z`). 12 turns, 12 attempts, **every turn
  committed on attempt 1**, no retries, no failures.
- **Per-attempt durations:** min **2.373s**, median **4.429s**, max **6.980s**.
  A full ten-participant round costs roughly **44s** sequentially.
- **Routing:** round-robin over all ten participants verified programmatically
  against `participants[index % 10]`, then wrapping correctly to positions 1 and
  2 for turns 11 and 12. Twelve messages from **ten distinct authors**.
- **Free-chat completion:** ended at `maxTurns`, not by unanimity — one `done`
  signal was raised on the final turn. Both paths remain covered by tests.
- **Context:** the run carried `contextMaxChars` **40,000** (P10-05). The
  transcript reached **2,595 characters**, so **transcript windowing did not
  engage**: zero `attempt.started` events carried `truncated: true`. The widened
  budget was proven sufficient for ten participants at this length; the windowing
  and field-cap paths themselves remain covered by unit tests only, not by this
  live run.
- **Prompt size at the widest turn is not recorded, because it is not
  observable.** Prompts are never stored or exposed by the API, by design. The
  honest proxies are the transcript size above and the `truncated` flag, both
  recorded.
- **Redaction:** the detail response contains no `leaseToken`. Event types were
  confined to the frozen set: `run.created`, `run.started`, `turn.scheduled`,
  `attempt.started`, `turn.committed`, `run.completed`.
- **Deployment:** the run was driven through the Compose deployment's HTTP API,
  and the run is served by both endpoints the UI polls. The web app is served
  (`200`, hashed bundle referenced). **A browser rendering and responsiveness
  check was not performed** — no browser tooling was available in the
  implementing environment. Ten-participant form and transcript rendering is
  covered by the web fixture tests; the `1440x900` / `390x844` layout checks from
  `P8-11` have not been repeated against the renamed UI.
- **Latency conclusion for Phase 13:** a sequential ten-participant round is
  ~44s on the fastest endpoint. That is the baseline the `maxParallelTurns`
  default must be justified against.
- **Demo data:** ten `P10 Rehearsal N` Agents, their workspaces, and this run
  remain in local runtime data. `P15-19` covers removing misleading demo data
  before judging evidence is captured.

### Phase 10 recorded deviation

`P10-05` specifies the session context budget as "configurable through
`AppConfig`". It is implemented as the exported constant
`SESSION_CONTEXT_MAX_CHARS` in `coordination/types.ts`, not as a configuration
value: nothing in Phases 10-15 reads it from configuration, and adding a config
key, its parser, and its composition wiring would widen the surface this phase is
allowed to touch. If a deployment ever needs to tune it, `P15-07` is where the
operations document would record it.

## Phase 8 task ledger

| Task | Status | Current implementation/evidence |
|---|---|---|
| P8-01 | `complete` | Web-owned coordination types mirror the workflow union, participant/session turn kinds, session policy/shared state, typed session artifacts, and public attempt response without importing server internals. |
| P8-02 | `complete` | The existing authenticated request path accepts the discriminated create union; list/detail/start/stop continue through the same bearer and structured-error conventions. |
| P8-03 | `complete` | The create form has an explicit verified-handoff/shared-session workflow choice; verified fields and three-role behavior remain available. |
| P8-04 | `complete` | Session form includes countdown/free-chat protocol, ordered 2..6 ready-Agent picker, start value, name/objective, turn ceiling, and timeout. |
| P8-05 | `complete` | Client validation covers count/distinctness/readiness and protocol ranges, focuses the first invalid region, preserves the form on rejection, and keeps create/start separate. |
| P8-06 | `complete` | Chronological transcript shows participant names, content, turn/attempt evidence, countdown shared state, and latest free-chat `done` state. Completed countdowns say `Complete` instead of presenting sentinel `0` as a next action. |
| P8-07 | `complete` | Session turns use participant labels in the existing timeline; retry-safe protocol validation messages render without logs. |
| P8-08 | `complete` | React text rendering escapes artifacts; empty/loading/error/long-content and terminal states are bounded and readable. |
| P8-09 | `complete` | One 1.5-second timeout chain is proved across terminal state, selection change, unmount, start reconciliation, and single-request stop behavior. |
| P8-10 | `complete` | Relay remains integrated through the existing `App.tsx` owner; Agent and Playground ownership was unchanged, and the verified workflow passed live regression. |
| P8-11 | `complete` | Nine session fixtures plus seven verified fixtures cover running/retry/consensus/withdrawal/stopped/failed/interrupted/completed views; interaction tests cover labels, focus, safe text, polling, and stop. Desktop and mobile browser checks cover responsiveness. |
| P8-12 | `complete` | Fresh demo Agents on `deepseek-v4-flash` completed real 10-to-1, unanimous free-chat, and verified-handoff runs in the Compose browser deployment. |
| P8-13 | `complete` | A purpose-built participant genuinely returned `3` when the expected number was `5`; middleware emitted `attempt.invalid_output`, retried the same turn, accepted `5`, and the run completed. |
| P8-14 | `complete` | Timings and the demo-budget conclusion are recorded below; Section 10 fallbacks remain confirmed for Phase 9 even though this provider was comfortably faster than the earlier measurements. |

### Checkpoint 8 browser and timing evidence

- **10-to-1 countdown:** completed all ten messages in exact order and round-robin assignment. Start-to-completion was **11.880s**; committed attempt durations averaged **1.181s**, with a **0.917-1.637s** range. All ten succeeded on attempt 1.
- **Free chat:** three fresh participants reached unanimous latest `done: true` in three turns. Start-to-completion was **5.321s**.
- **Wrong-number recovery:** the first participant genuinely answered `3` while the backend expected `5`. Attempt 1 was rejected with `Expected the next number 5, received 3`; attempt 2 succeeded, and the complete 5-to-1 run took **10.084s**.
- **Verified regression:** Planner, Critic, and Finaliser completed proposal, approval, and finalization in three first-attempt turns and **11.335s**.
- **Stop and layout:** a running free-chat session settled as `STOPPED_BY_USER` **0.462s** after start, cancelling its active attempt. The UI passed 1440×900 and 390×844 checks with no document-level horizontal overflow; semantic labels and error focus were present, and the browser console had no warnings or errors.
- **Latency conclusion:** the real 10-turn path fits the three-minute budget on the measured fastest endpoint. Phase 9 must still retain the Section 10 mitigations: keep the populated 10-to-1 run, narrate a shorter 5-to-1 live run when provider latency rises, and preserve the stored wrong-number evidence. No credentials, lease capabilities, or raw prompts are included in this evidence.

## Phase 7 task ledger

| Task | Status | Current implementation/evidence |
|---|---|---|
| P7-01 | `complete` | Session-message commits derive and atomically store the next countdown value alongside artifact, turn, attempt, pointers, version, and event; free chat leaves shared state absent. |
| P7-02 | `complete` | Durable expected-output handling is a typed exhaustive `CoordinationTurnKind → ArtifactType` map; the verified workflow map is exhaustive too. |
| P7-03 | `complete` | Durable session tests cover retry fencing, stop-versus-commit, concurrent commits, restart interruption, reservation release, and gapless event sequences. |
| P7-04 | `complete` | Routes accept the workflow union, default omitted workflow to verified handoff, and enforce session participant/protocol/policy constraints. |
| P7-05 | `complete` | Service-side session create validation remains the non-HTTP enforcement layer and is exercised by the new API path. |
| P7-06 | `complete` | Fastify injection coverage includes session create/start/detail, validation failures, missing participants, readiness, reservation, auth, oversized bodies, and safe errors. |
| P7-07 | `complete` | `index.ts` registers `SharedSessionWorkflowV1` and dispatches to `SharedSessionArtifactProtocol` while retaining verified-handoff wiring. |
| P7-08 | `complete` | Durable detail tests cover countdown, wrong-number retry, free-chat cap/unanimity, stop/race, restart, ordered events, and session final-artifact evidence. |
| P7-09 | `complete` | Session tests prove ready checks, overlapping-run reservation rejection, and reservation release after terminal/restart settlement. |

### Checkpoint 7 verification

- The focused durable repository and API suites passed after adding the session
  scenarios; the final API-only confirmation passed all 42 tests.
- Required full command: the disposable Compose invocation of `npm ci
  --include=dev && npm run check`, using `docker-compose` and
  `LAUNCHPAD_ENV_FILE=/dev/null` as described above.
- Final result: 27 server files / 474 tests, 2 web files / 12 tests, both
  typechecks, and both production builds passed.
- New Phase 7 tests use the scripted coordination runtime; no new real Agent or
  provider integration was introduced. Existing dependency audit findings remain
  1 moderate and 5 high, deferred to P9-17; dependency versions did not change.

Outstanding decision for the team, not for Phase 6: whether to create a
convenience tag on `2fe14eb`. None was created. The immutable commit reference
is sufficient, and the Phase 0 experience — documentation claiming a
`relay/contracts-v1` tag that never existed — argues for deciding explicitly
rather than assuming.

## Phase 6 task ledger

| Task | Status | Evidence |
|---|---|---|
| P6-01 | `complete` | `SharedSessionWorkflowV1` validates session state and committed transcript provenance, schedules by committed-turn round robin, emits chronological transcript artifact IDs, completes countdown at 1, completes free chat on unanimous latest `done` signals or the turn limit, uses the last message as final artifact, and fails countdown turn exhaustion safely. The verified workflow now explicitly rejects session turns; participant/session event labels no longer throw. Approved mini-RFC adds optional schedule `agentId`, and service turn construction uses it without changing verified decisions. Four new focused workflow tests plus updated contract/placeholder tests pass. Full Compose gate passed: 24 server files / 403 tests, 2 web files / 12 tests, typechecks, and both builds (415 tests total). |
| P6-02 | `complete` | `CoordinationWorkflowDispatchV1.forRun` selects from durable `policy.workflow`; the service loop uses the declared dispatch contract and fails loudly if session routing is unregistered. |
| P6-03 | `complete` | Fifteen pure workflow/dispatch tests cover deterministic 2/3/4-Agent cycles, chronological inputs, countdown completion/ceiling, free-chat unanimity/partial/withdrawn/limit behavior, malformed state, non-session artifacts, and dispatch. |
| P6-04 | `complete` | Strict `sessionMessagePayloadSchema` trims content, enforces 1..500 characters, supports optional boolean `done`, removes explicit undefined, and rejects unknown fields. |
| P6-05 | `complete` | `SharedSessionArtifactProtocol` follows size → trim/fence → one parse → type/version/schema → protocol rule; countdown validates the exact backend-owned number and rejects `done`. Durable workflow dispatch keeps the verified protocol's former session provenance fallback unreachable and removed. |
| P6-06 | `complete` | Twelve session-protocol tests cover countdown/free-chat validity, wrong/non-integer numbers, global and content size bounds, fences, prose, missing/unknown fields, forged provenance, invalid `done`, authoritative provenance, and parser dispatch. |
| P6-07 | `complete` | Session context uses protocol-specific instructions/output contracts, a cumulative named transcript, explicit `session_message` capping, and the existing four-section envelope/retry placement. |
| P6-08 | `complete` | Countdown prompts expose transcript-derived instructions but no expected-number/shared-state field; free-chat prompts expose objective/transcript and no hidden state. |
| P6-09 | `complete` | Six session-context tests cover chronological order, oldest-first truncation, newest preservation, expected-state non-leakage, capability/event/auth/unrelated-run exclusion, and stable digest. |
| P6-10 | `complete` | Session create validates 2..6 distinct existing Agents, names/objectives, protocol-specific ranges, timeout, forbidden verified-only fields, input-order snapshots/defaults, shared-state initialization, and a real session-turn context probe. |
| P6-11 | `complete` | The unchanged orchestration loop drives session schedule/attempt/runtime/validate/lease commit; the in-memory repository adds only the Phase 6 countdown shared-state commit behavior. Retry stays on the same Agent/logical turn; stop and late output cannot progress the run. |
| P6-12 | `complete` | Twenty in-memory session tests cover 10→1, wrong→retry→success, wrong/malformed/timed-out exhaustion, timeout retry, deferred stop/late result, countdown ceiling, free chat at max turns, unanimous `done`, malformed free chat, and create validation/probing. Existing 36-test verified walking skeleton remains green. |

### P6-01 verification

- Focused Compose test: 3 files / 26 tests passed after correcting two test-only fixture mistakes (a missing import and the event-factory argument shape).
- Required full command: `docker compose build launchpad`, followed by the standard disposable `docker compose run ... npm ci --include=dev && npm run check` command from the runbook.
- Final result: passed on the exact implementation tree committed as `a916d5c`; 403 server tests, 12 web tests, both typechecks, and both builds.
- Known dependency audit findings remain 1 moderate and 5 high, deferred to P9-17 as already recorded. No dependency versions changed.

### Checkpoint 6 verification

- Focused Compose gates passed: workflow/dispatch 15 tests; schema/protocol 113 tests; context 58 tests; service/walking skeleton 81 tests. The final full gate also passed the two subsequently added exhaustion cases.
- Two interim focused runs failed only in new test/type scaffolding: exact-optional Zod output and an overly broad verified payload union were tightened; the transcript truncation test's context threshold was corrected to exercise oldest-only truncation. Each focused gate then passed.
- Required full command: `docker compose build launchpad`, followed by the standard disposable `docker compose run ... npm ci --include=dev && npm run check` command from the runbook.
- Final result on the implementation tree committed as `82f5c85`: 27 server files / 454 tests, 2 web files / 12 tests, both typechecks, and both builds (466 tests total).
- No persistence, HTTP, disk fixtures, arbitrary sleeps, or real model were used by the new Phase 6 tests. Dependency findings remain deferred to P9-17.

## Phase 5 task ledger

All changes are additive. No existing type member, route, persisted shape, or
verified-handoff behaviour changed. Existing tests are unchanged at 377 server +
12 web = 389; Phase 5 adds 22 server tests, for 411 total. All verified by the
Checkpoint 5 gate below.

| Task | Status | Evidence |
|---|---|---|
| P5-01 | `complete` | Team approved the session mini-RFC with one amendment (free-chat `done` signal). Every question open in `overview-sessions.md` Section 11 settled and recorded in `ASSUMPTIONS_AND_DECISIONS.md`; Section 11 rewritten to match. Build scope settled: Phase 5 only, Phases 6–8 to teammates, `free_chat` frozen in contract but implemented in Phase 6. |
| P5-02 | `complete` | Nine-phase numbering and the `P5-xx`/`P9-xx` prefixes confirmed unchanged. Exhaustiveness scope amendment approved and recorded in the Phase 5 sheet and `ASSUMPTIONS_AND_DECISIONS.md`. |
| P5-03 | `complete` | `types.ts`: `participant`, `sessioning`, `session_turn`, `session_message`, `CoordinationWorkflowKind`, `SessionProtocol`, `policy.workflow`/`sessionProtocol`/`sessionStartValue`, `SessionMessagePayload` (with the approved optional `done`), `CoordinationSharedState`, `run.sharedState`, `CreateSessionRunRequest`, `CreateRunRequest`, `SESSION_LIMITS`. `DEFAULT_COORDINATION_POLICY` still names `verified_handoff_v1`. Loud placeholders added under the amendment. |
| P5-04 | `complete` | `contracts.ts`: `SharedSessionWorkflow`, `CoordinationWorkflowDispatch`, widened `createRun` input union. `VerifiedHandoffWorkflow` untouched. Zod schemas deliberately **not** written here — P6-04 owns them, and writing them now would collide with that task. |
| P5-05 | `complete` | New `testing/session-fixtures.ts`: four participants, the 10→1 transcript, round-robin author helper, wrong-number and skipped-number outputs, non-integer/empty/oversize/fenced/prose/forged-provenance cases, free-chat messages, unanimous/partial/withdrawn `done` rounds, committed artifacts, expected event sequences. No randomness, network, or secrets. Added as a new module so the frozen Phase 1 fixture pack is untouched. |
| P5-06 | `complete` | Existing `FixedClock`, `DeterministicIdGenerator`, `InMemoryCoordinationRepository` and `ScriptedCoordinationRuntime` confirmed sufficient; no control added. New shell module `session-workflow.ts` (`SharedSessionWorkflowV1`) throws until P6-01. |
| P5-07 | `complete` | `session-contracts.test.ts` (15 tests) and `session-placeholders.test.ts` (7 tests): dual-workflow construction with the real shell, construction without a session workflow, countdown create initialising `phase: "sessioning"` and `sharedState.nextExpectedNumber`, free-chat create with no shared state and `maxTurns` 6, selection order preserved, participant/duplicate/unknown-Agent rejections, verified-handoff create unchanged, `done`-signal fixture shapes, and every placeholder throwing with its task name. |
| P5-08 | `complete` | Frozen session contract commit: **`2fe14eb`** on `phase5-p5-01-session-contracts`, gate-verified 2026-08-30 with a clean working tree. Mirrors P0-11: an immutable commit reference, no convenience tag created. |

### Phase 6 handoff notes (consolidated 2026-08-30)

1. **The free-chat unanimity rule is confirmed.** The whole team confirmed it,
   together with the final-artifact-pointer rule. P6-01 encodes both.
2. **`TASK_INSTRUCTIONS` cannot express two protocols on one turn kind.** It is
   keyed by `CoordinationTurnKind` alone, but `session_turn` carries both
   countdown and free chat. P6-07 must change that map's shape (for example key
   it by workflow or protocol, or make it a lookup function), not just fill in
   the placeholder.
3. **Two silent sites are fixed by schedule.** `repository.ts`
   `expectedArtifactTypeForTurn` (bare `default:` returns `"proposal"`) is
   P7-02, which now converts it to an exhaustive typed map so the compiler
   enforces the case. `context-builder.ts` `capPayload` (bare fallthrough that
   a session message would take by coincidence) is P6-07, which now adds the
   explicit `session_message` branch.
4. **No new `CoordinationEventType` for `done` (settled).** Unanimity is
   observable from committed artifacts; the evidence timeline shows the signal
   via the artifact payload. No event-type change.
5. **`createSessionRun` is the minimal P5-07 path.** Participant count,
   distinctness and Agent existence only. P6-10 now extends it with the full
   policy-range validation and the create-time context probe.

| Phase 4 gate condition | Evidence |
|---|---|
| Client contracts and create flow | Web-owned response types and list/create/detail/start/stop calls reuse existing bearer and structured-error behavior; the form validates role uniqueness, readiness, section keys, limits, and policy ranges while preserving input |
| Evidence experience | Run metadata, role mappings, events grouped by turn, nested attempts, retries/revisions, and escaped proposal/review/final artifacts render for all seven fixture scenarios |
| Polling and stop | One 1.5-second request chain cleans up on terminal state, selection change, and unmount; stop has pending/disabled state; a browser-discovered post-start polling defect has a regression test |
| Accessibility and responsive layout | Associated labels, error focus, meaningful terminal/status text, keyboard operation, and narrow layout passed; 390-pixel audit found no horizontal overflow or unlabeled inputs |
| Real browser evidence | Disposable Compose completed one real three-role run and one real stop flow; completion reached 15 events and the stop flow displayed cancellation and stale-result evidence |
| Full regression gate | Docker Compose `npm run check` passed: 21 server files / 377 tests, 2 web files / 12 tests, and both builds (389 tests total) |

`P5-01` (team approval of the session mini-RFC) is the next task ID, on the
Phase 5 sheet. Phase 9 release tasks (`P9-01` onwards) cover documentation,
demo, dependency/security, and clean-release checks for both workflows. The
optional `relay/contracts-v1` convenience tag remains a release-time decision;
immutable commit `ea469b2` already satisfies P0-11.

For all resumed work: create a new task branch first, consult `FILESYSTEM_MAP.md`, clarify uncertainties before acting, run every test through Docker Compose, and require a passing Docker Compose `npm run check` before marking implementation complete.

## Defects found in Phase 2

| Defect | How it was found | Resolution |
|---|---|---|
| Production 404s bypassed the frozen `ApiErrorResponse` envelope | Booting the real composition root (P2-17) returned `{"statusCode":404,"code":"NOT_FOUND","error":"Not Found",...}` where the injection tests returned `{"error":{"code":"NOT_FOUND",...}}`. Fastify's not-found context captures whichever error handler is installed when `setNotFoundHandler` runs, and `app.ts` registered the not-found handler **before** `setErrorHandler`. Only `NODE_ENV=production` registers a not-found handler, so no test-mode check could ever have caught it. | `setErrorHandler` now runs before the production static/not-found block, with a comment recording why the order matters. A regression test builds the app in production mode and asserts the frozen envelope; it provides a minimal web bundle when the real one has not been built yet and removes only what it created. |
| Unexpected `500` leaked arbitrary exception messages to responses and logs | Phase 2 review injected a credential-bearing connection string; the test checked only for stack/path leakage and therefore passed while the message remained exposed. | The handler logs only error classification and returns a fixed `INTERNAL_ERROR` message. Tests assert credential material is absent; runtime redaction also covers credential-bearing connection URLs. |

## Outstanding decisions

| Item | Status | Deadline |
|---|---|---|
| Dependency audit findings | Open: `npm ci` reports 1 moderate and 5 high findings. | P9-17 security/release review; do not apply breaking upgrades mid-phase. |
| Misleading countdown run in local data | The "Test Relay" run (objective "Count down from 10 to 0") contains a final artifact claiming a countdown was executed when nothing was. | `P9-19`: delete from local demo data before judging evidence. |
| Optional contract tag is absent | The accepted contract is immutably recorded as `ea469b2`, but neither the local nor remote repository has `relay/contracts-v1`. | Decide before release whether to create/push the convenience tag; no tag was created during cleanup. |

## Checkpoint history

Checkpoint 14 is complete and merged to `main` from `phase-14`. Coordinator
planning replaced the hard-coded countdown; the ordered 10-to-1 demo now emerges
from an Agent-authored plan plus sequential scheduling, with no numeric validator
in the engine. The canonical Docker Compose gate passed 30 server / 571 tests and
3 web / 47 tests, three live ten-Agent rehearsals ran the ordered, fan-out, and
follow-up prompts, and a genuine plan rejection with recovery was captured.

Checkpoint 8 is complete and merged to `main` from `phase-8`. The public web contract, shared-session
create form, transcript, shared/consensus state, participant-labelled evidence,
polling cleanup, and stop path are implemented. Real browser countdown,
free-chat, wrong-number recovery, verified regression, responsive, and console
checks passed. The final Docker Compose gate passed 501 tests and both builds.

Checkpoint 7 is complete and merged to `main` at `9e82e50`; Checkpoint 6 is
frozen at `82f5c85`. Their detailed evidence remains in the ledgers above.

At Checkpoint 5, the additive session contract compiled, the session
fixtures and the shell workflow are in place, and `CoordinationService`
constructs with both workflows registered and initialises a session run's
durable shape. At that checkpoint no session behaviour existed: routing,
countdown validation, transcript context and the free-chat completion rule were
all deferred to Phase 6, and nine loud placeholders threw with the task ID that
would replace each. Every existing verified-handoff test passed unchanged.
Frozen at commit `2fe14eb`; no
convenience tag was created.

Checkpoint 4 is complete. The existing application owns a single Relay
workspace that consumes only the public API read model, never renders lease
capabilities or raw HTML, and presents run, turn, attempt, event, decision, and
artifact evidence. Controlled tests cover every required fixture state and
polling/stop behavior. Real browser flows passed in disposable Compose storage
at laptop and narrow viewport sizes; repository runtime data was not mounted or
touched.

Checkpoint 3 is complete. The production composition root calls real Agents
through `AgentService`, while the service retains ownership of ordinary Agent
state, messages, workspaces, threads, cancellation, and correlations. All real
smoke data used disposable Compose storage; repository `data/`, `workspaces/`,
and `codex-home/` were not mounted or touched.

Checkpoint 2 remains complete with its API/security follow-up applied and
verified by the Phase 3 full gate.

Checkpoint 1 is complete. The real workflow, artifact protocol, and role-scoped
context builder drive the real `CoordinationService` against an in-memory
repository and a scripted runtime, with no disk, HTTP server, timer, or model
call in any automated test. The full Docker Compose `npm run check` passed on the
Phase 1 tip: server and web typechecks, 14 server test files with 237 tests, web
build, and server build.

Checkpoint 0 remains as recorded: immutable commit `ea469b2` froze the
overview-aligned types and interfaces. Documentation previously claimed an
additional `relay/contracts-v1` tag, but the tag is absent locally and remotely.

## Phase 1 handoff to Phase 2

Four behaviours are specified in the frozen contract but cannot be produced by
Phase 1 code. They are deferred deliberately, not overlooked, and each needs an
owner in Phase 2:

| Item | Current state | Where it belongs |
|---|---|---|
| `attempt.stale_ignored` | No code path can produce this status. A late or duplicate result is correctly refused by the lease, but leaves no evidence row. | P2-05/P2-09, with events |
| `truncated` context flag | `PromptEnvelope.truncated` is computed correctly and then dropped by the service. `CoordinationAttempt` has no field for it, so overview Section 11.6's "record `truncated: true` in attempt metadata/event details" is unmet. | P2-05 event details, or a mini-RFC adding the attempt field |
| `attempt.outputDigest` | Declared in the frozen type and never written by any code path. | P2-09/P2-11, alongside commit |
| `includedArtifactIds` | Returned by the context builder and dropped by the service; `turn.inputArtifactIds` carries most of the same evidence. | P2-09, or drop it from the envelope by mini-RFC |

The shared Phase 1 fixtures, fakes, deterministic controls, in-memory
repository, and scripted runtime are frozen for Phase 2 repository and API
tests, as the phase sheet's handoff requires. Extend them additively; changing
existing fixture behaviour requires a recorded decision because Phase 2 tests
will depend on it.

## Phase 0 task ledger

| Tasks | Status | Evidence |
|---|---|---|
| P0-01–P0-03 | `complete` | Compose reports Node `22.23.2`, npm `10.9.8`; clean lockfile install and full check pass. |
| P0-04–P0-05 | `complete` | User-performed authenticated checks passed for the full temporary-Agent lifecycle, one Playground turn, three fresh Agents, one ordinary turn each, readiness, persistence, and isolation. |
| P0-06–P0-10 | `complete` | Scope/ADRs reviewed; contracts corrected; extra endpoint removed; terminal stop semantics frozen with tests. |
| P0-11 | `complete` | Immutable commit reference `ea469b2`; the optional convenience tag `relay/contracts-v1` is not present. |
| P0-12–P0-17 | `complete` | Module shells, deterministic kit, shared fixtures/fakes, scripted runtime, and construction test pass. |

## Phase 1 task ledger

| Tasks | Status | Evidence |
|---|---|---|
| P1-01–P1-04 | `complete` | Pure workflow selectors, full routing table, ceilings, invalid-state guards; 26 pure tests. |
| P1-05 | `complete` | Strict bounded proposal/review/final schemas; 20 boundary tests. |
| P1-06 | `complete` | Frozen Section 11.4 parsing order as fail-fast steps; Compose check passed with 12 files / 87 tests. |
| P1-07 | `complete` | Section coverage and uniqueness, reject/approve issue consistency, backend provenance. |
| P1-08 | `complete` | 23-row valid/adversarial matrix plus forged-provenance and injected-instruction cases; 72 protocol tests total. |
| P1-09–P1-12 | `complete` | Contract envelope and four role templates, Section 5.2 visibility whitelist, canonical serialisation, reproducible truncation ladder with safe failure, bounded retry feedback, leakage and superseded-history tests; 45 context tests. |
| P1-13 | `complete` | Scripted runtime with queued outcomes, captured calls, deferred manually-resolvable completions, and start waiters; 9 kit tests. |
| P1-14 | `complete` | Create validation: slug normalisation before duplicate rejection, frozen key/title limits, create-time context-cap probe using the real builder, one local loop per run; 12 service tests. |
| P1-15–P1-17 | `complete` | Shared in-memory repository with lease/active-attempt/status enforcement, and the walking-skeleton matrix over the real components; 36 tests. |

All Phase 1 evidence is the single Docker Compose `npm run check` recorded below;
no task was promoted on a host-only or focused run.

## Phase 2 task ledger

| Tasks | Status | Evidence |
|---|---|---|
| P2-01–P2-04 | `complete` | Overview Section 17 mini-sprint 3A implemented as one unit, because `DatabaseV2` cannot compile without the store that loads it. `DatabaseV1`/`DatabaseV2`/`AnyDatabase` and optional `AgentRunCorrelation` fields added; `parseDatabaseDocument` parses v1 explicitly and migrates additively by spread, so unknown top-level and per-record fields survive; new databases are created at v2; future/malformed/unparseable documents are rejected before any write. 11 store tests. Compose `npm run check` passed: 14 files / 247 tests. |
| P2-05–P2-07 | `complete` | Overview Section 19 mini-sprint 5A. Pure factories for all 17 frozen event types return an identity-free `CoordinationEventDraft`, because Section 10.3 requires the per-run sequence to be allocated inside the repository's own `mutate()`. Details are redacted **inside** the factory, so a caller cannot append an unredacted event by forgetting a step. `truncated` rides on `attempt.started` and `attempt.stale_ignored` exists as an event, per the confirmed handoff decisions. The redactor is a key allowlist plus secret-pattern stripping that runs before truncation. 38 tests. Compose `npm run check` passed: 16 files / 285 tests. |
| P2-08–P2-14 | `complete` | `DurableCoordinationRepository`. Every command runs in exactly one `JsonStore.mutate()`; there is no read-check-write across store calls. Reads are deterministic (newest-first cap 50 with insertion-order tie-break; detail sorted by turn sequence then attempt number, never array position) and return deep copies. `startRun` checks created status, distinctness, Agent existence/readiness, derived coordination reservations, and in-flight ordinary Agent Runs together. Commit checks run status, both active pointers, attempt status, and the opaque lease as one condition. A losing caller writes nothing but an `attempt.stale_ignored` event. 51 tests, including concurrent same-run starts, concurrent overlapping-participant starts, disjoint starts, wrong/superseded lease, timeout-then-successful-retry, stop-versus-commit, duplicate completion, terminal overwrite prevention, per-run event numbering, and a leakage check. |
| P2-20, P2-21 | `complete` | `interruptActiveRuns()` settles run, turn, and attempt and appends `run.interrupted` then `run.failed` with `SERVER_RESTARTED`, which is what releases the derived reservations; it is idempotent and leaves created/terminal runs alone. `listReservedAgentIds()`/`isAgentReserved()` expose the Section 10.4 derived reservation for `AgentService`; tests prove release after stopped and interrupted. Wiring into `AgentService` and `index.ts` remains P2-17. |
| P2-15, P2-16 | `complete` | The frozen route surface already carried strict schemas, UUID params, and policy ranges; P2-15 verified them rather than reimplementing. P2-16 adds 26 Fastify-injection tests over the **real** durable stack: auth required on all five routes, create/list/detail/start/stop statuses, `DUPLICATE_AGENT` on repeated Agents, duplicate section keys, four policy-range rejections, unknown-field rejection, `404` for a missing Agent and an unknown run, `400` for a non-UUID param, `409` for `AGENT_NOT_READY` and `AGENT_RESERVED`, `413` for an oversized body proven not to reach the service, and a safe `500` that leaks no stack or source path. |
| P2-17 | `complete` | `index.ts` constructs the real `VerifiedHandoffWorkflowV1`, `VerifiedHandoffArtifactProtocol`, `RoleScopedContextBuilder`, and `DurableCoordinationRepository` over the real `JsonStore`, with a UUID id generator, a system clock, an `AgentService`-backed Agent directory, and the scripted runtime as the deliberate Phase 2 placeholder. Coordination initialises after `AgentService`. Verified by booting the built server in a disposable container: `/api/health` `200`, authenticated `/api/coordination-runs` `200 {"runs":[]}`, unknown run `404` in the frozen envelope, removed `/events` route `404`, and a freshly created database written at `"version": 2` with all five coordination collections. |
| P2-18 | `complete` | `CoordinationLogContext` admits only identifiers, enum values, counts, digests, and the truncation flag, so a prompt, raw output, or lease token cannot be logged even by mistake. Logs are emitted at run start, turn schedule, attempt start, commit settlement, and stop, and asserted to contain no prompt or objective text. |
| P2-19 | `complete` (verify-only) | Confirmed as the handoff predicted, in two places: `routes.test.ts` asserts `404`, and the live boot probe returned `404` for `/events`. |
| P2-22 | `complete` | The detail response is exercised as an evidence timeline over the real stack for six fixtures — normal, reject/revise/approve, invalid-then-retry, failed, stopped, and restart-interrupted — asserting ordered turns, per-turn attempt ordering, artifact order, the exact event-type sequence, gapless per-run event numbering, and `outputDigest` on every committed attempt. |

## Phase 3 task ledger

| Tasks | Status | Evidence |
|---|---|---|
| P3-01–P3-07 | `complete` | `AgentService.startExecution()` returns the persisted Agent Run/message IDs and a completion promise; `sendMessage()` remains its compatibility wrapper. Runs store source plus coordination run/turn/attempt correlations. Cancellation is keyed and guarded by Agent Run ID, and reservations reject Playground send/edit/delete/start/stop while allowing only the matching internal coordination run. Eight regression tests cover compatibility, concurrent admission, failure recovery, correlation visibility, scoped cancellation, conflict, and terminal release. |
| P3-08–P3-13 | `complete` | `AgentServiceCoordinationRuntime` maps real execution into the frozen runtime contract, persists the Agent Run ID before awaiting completion, owns an attempt→Agent-run map, applies the unchanged attempt timeout, requests correlated cancellation, waits a bounded 2-second settlement grace, fails safely when settlement is unconfirmed, redacts safe messages including connection-URL credentials, and cleans timers/maps in `finally`. Six fake-control tests cover success, failure, timeout win, late success, user cancellation, unconfirmed settlement, targeted cancellation, and cleanup. |
| P3-14, P3-15 | `complete` | Disposable Compose one-Agent probe invoked the configured real provider through the real gateway. It succeeded in 4.789 seconds; its correlated Agent Run and user/assistant messages were visible, and its thread ID persisted. No identifiers, prompts, output, credentials, or lease values were recorded. |
| P3-16, P3-17 | `complete` | Three fresh real Planner → Critic → Finaliser runs completed with valid proposal/review/final artifacts and one attempt per role. During every active run, a competing Critic Playground send returned structured `409 AGENT_RESERVED`; automated coverage proves the same reservation releases after terminal settlement. |
| P3-18 | `complete` | Three successful disposable-Compose rehearsals used the configured local-process runtime profile. Redacted run fingerprints: `9b487919`, `6191748d`, `f753a107`. Total times: 87.549s, 108.157s, 56.905s (range 56.905–108.157s). Per-turn times: 26.273/14.760/46.428s; 59.585/24.617/23.461s; 22.809/12.919/20.860s (range 12.919–59.585s). Every attempt completed below the unchanged 120s timeout, so the default is feasible. |

## Phase 4 task ledger

| Tasks | Status | Evidence |
|---|---|---|
| P4-01–P4-05 | `complete` | Web-owned public coordination types and API functions; validated create form with exactly three distinct ready Agents, unique section keys, bounded policy controls, preserved input, structured field errors, and explicit create then start. |
| P4-06–P4-09 | `complete` | Detail renders status/phase/revision, roles, limits, actionable terminal summaries, ordered per-turn evidence, nested attempts, retries/revisions, and escaped artifacts across safe empty/loading/error/long-content states. |
| P4-10–P4-12 | `complete` | A single 1.5-second polling chain cleans up correctly; stop reconciles terminal state without duplicate requests; seven redacted fixture scenarios and error envelopes have automated coverage. |
| P4-13–P4-16 | `complete` | Minimal `App.tsx` integration preserves Agent/Playground ownership; labels, error focus, keyboard and responsive checks pass; disposable real-browser completion and stop flows passed. |

## Implemented inventory

| Area | Evidence | Status | Notes |
|---|---|---|---|
| Domain model/default policy | `apps/server/src/coordination/types.ts` | `complete` | Frozen against overview Sections 7–8 at immutable contract commit `ea469b2`. |
| Component contracts | `apps/server/src/coordination/contracts.ts` | `complete` | Frozen overview boundaries include repository/runtime/workflow/context/protocol/redaction/execution control. |
| Coordination error envelope | `coordination/errors.ts`, `app.ts` | `complete` | `CoordinationError` receives structured API envelope. |
| Service create/list/detail | `coordination/service.ts` | `complete` | P1-14 adds slug normalisation of required sections, frozen title/key limits, and a create-time context-cap probe that builds a real probe prompt. |
| Background orchestration | `coordination/service.ts` | `complete` | Scheduling, retries, runtime attachment, validation, commits, completion/failure, and local loop cleanup exist. |
| Stop handling | `coordination/service.ts` | `complete` | Durable request, active-attempt cancellation, and finish-stop flow exist; terminal HTTP semantics are frozen, while race evidence remains Phase 1/2 work. |
| HTTP routes | `coordination/routes.ts`, `app.ts` | `complete` | Frozen list/create/detail/start/stop surface; accidental events route removed and tested as absent. |
| Phase 0 testing kit | `coordination/testing/**`, `construction.test.ts` | `complete` | Deterministic controls, full fixture pack, fakes, scripted runtime, and construction proof pass. |
| Pure workflow selectors/routing | `coordination/workflow.ts`, `coordination/workflow.test.ts` | `complete` | P1-01–P1-04 pass: deterministic selectors, all routing transitions, revision/turn ceilings, invalid-state guards, and exhaustive pure decision tables. |
| Strict artifact schemas | `coordination/schemas.ts`, `coordination/schemas.test.ts` | `complete` | P1-05 strict bounded proposal/review/final Zod schemas pass exact string/array boundaries, trimming, slug, discriminator, optional-field normalization, and unknown-field tests. |
| Artifact parser/protocol | `coordination/artifact-protocol.ts`, `artifact-protocol.test.ts` | `complete` | P1-06–P1-08: frozen Section 11.4 order enforced as fail-fast steps (size, trim, one outer fence, one JSON parse, expected type, schema version, bounded schema, cross-field rules, backend provenance), plus the coverage/consistency rules and a 72-test valid/adversarial matrix including forged provenance and injected instructions. |
| Role-scoped context builder | `coordination/context-builder.ts`, `context-builder.test.ts` | `complete` | P1-09–P1-12: Section 11.5 envelope, four role templates, the Section 5.2 visibility whitelist, canonical key-sorted serialisation, a reproducible truncation ladder with safe failure, bounded retry feedback, and leakage tests covering identifiers, bookkeeping, and superseded history. |
| Shared Phase 1 fakes | `coordination/testing/memory-repository.ts`, `testing/fakes.ts` | `complete` | P1-13/P1-15: scripted runtime gains deferred, manually resolvable completions plus start waiters for race tests; the in-memory repository enforces lease, active-attempt, and status checks and returns deep copies so callers must reload. |
| Walking-skeleton evidence | `coordination/walking-skeleton.test.ts` | `complete` | P1-15–P1-17: the real workflow, protocol, and context builder drive normal, reject/revise/approve, invalid→retry→success, invalid twice, timeout→retry, failure twice, start-failure, revision-limit, turn-limit, duplicate-start, stop-during-deferred, and late-result cases with no disk, HTTP, timers, or model. |
| Service/API tests | `coordination/service.test.ts`, `coordination/routes.test.ts` | `complete` | Create-validation coverage added in P1-14; walking-skeleton coverage now uses real components rather than test-local stubs. |
| Relay web workspace | `apps/web/src/RelayWorkspace.tsx`, `coordination-api.ts`, `coordination-types.ts` | `complete` | Create/start, list/detail, polling/stop, grouped evidence and escaped artifacts are integrated through `App.tsx`; Vitest/RTL tests cover all fixture states and request lifecycle behavior. |

## Outstanding by phase

### Phase 0

- Complete. No Phase 0 tasks remain.

### Phase 1

- Complete. No Phase 1 tasks remain.

### Phase 2

- Complete. No Phase 2 implementation or decision tasks remain.

### Phase 3

- Complete. No Phase 3 tasks remain.

### Phase 4

- Complete. No Phase 4 tasks remain. Checkpoint 4 passed through automated
  fixture/request-lifecycle tests, the full Compose gate, and real browser
  completion and stop flows.

### Phase 5

- Complete. No Phase 5 tasks remain. P5-01–P5-08 landed on `phase5-p5-01-session-contracts`, one commit per task ID, and were promoted on the single Checkpoint 5 gate recorded in the verification log. Frozen contract commit `2fe14eb`.

### Phase 6

- Complete. Checkpoint 6 is frozen at `82f5c85`; the pure session workflow, protocols, transcript context, and in-memory walking skeleton are implemented and verified. See [`phases/06-session-core.md`](phases/06-session-core.md).

### Phase 7

- Complete. Checkpoint 7 is merged to `main` at `9e82e50`; durable session commits, the API create union, composition wiring, and race/restart evidence are verified. See [`phases/07-session-durable.md`](phases/07-session-durable.md).

### Phase 8

- Complete and merged to `main` from `phase-8`. The session form, transcript/evidence view, polling and stop behavior, live 10-to-1/free-chat/wrong-number rehearsals, verified regression, responsive browser checks, and final 501-test Compose gate all passed. See [`phases/08-session-ui.md`](phases/08-session-ui.md).

### Phase 9

- Superseded by Phase 15. The retained historical sheet is
  [`phases/09-release.md`](phases/09-release.md); its release work is not the
  current next action.

### Phase 10

- Complete and merged to `main`. The Session v2 surface, widened limits,
  free-chat-only creation, product rename, and ten-participant rehearsal passed
  Checkpoint 10. See [`phases/10-session-v2-surface.md`](phases/10-session-v2-surface.md).

### Phase 11

- Complete and merged to `main` at `3b11bef`. Reconciliation, attempt-scoped
  reservations, Agent recovery, restart settlement, the 540-test Compose gate,
  and the user's manual restart check passed. See
  [`phases/11-lifecycle-reconciliation.md`](phases/11-lifecycle-reconciliation.md).

### Phase 12

- Complete on `phase-12`. Durable user messages, resumable waves, Stop versus
  End, restart-safe idle sessions, delta polling, the chat UI, 560-test Compose
  gate, repeated race suites, and the three-prompt live checkpoint passed. See
  [`phases/12-durable-multi-prompt-sessions.md`](phases/12-durable-multi-prompt-sessions.md).

### Phase 13

- Complete on `main` at `7985ca3`. Checkpoint 13 closed by the full Compose gate
  (28 server / 536 tests, 3 web / 44 tests, both typechecks and builds) plus the
  live six- and ten-participant waves recorded above. See
  [`phases/13-parallel-waves.md`](phases/13-parallel-waves.md).

### Phase 14

- Complete on `phase-14`, merged to `main`. Checkpoint 14 closed by the canonical
  Compose gate (30 server / 571 tests, 3 web / 47 tests, both typechecks and
  builds), three live ten-Agent rehearsals, and one genuine plan rejection with
  recovery. See [`phases/14-coordinator-planning.md`](phases/14-coordinator-planning.md).

### Phase 15

- `P15-01` complete: the store is measured, and the measurement is decisive.
  Quadratic growth from per-turn `inputArtifactIds` gives a hard
  `RangeError` ceiling near 4,400 committed turns and unusable prompt latency
  (23.8s) by 2,000. The 10,000-turn row is measured-impossible.
- `P15-02` complete: the delta model saves 103x of bandwidth but no server time,
  and the delta payload itself inherits the quadratic through `inputArtifactIds`.
- `P15-03` complete: measured recommendation is 500 turns, enforced as guidance
  and surfaced in the UI. The 100,000 ceiling is retained per the sheet but is
  documented as unreachable.
- `P15-04` complete: recorded mini-RFC — fix the data model, defer the engine
  swap. `P15-05` closed, engine swap `deferred`, data-model half implemented.
- Open and measured, not yet fixed: the delta route clones the whole database
  before filtering, so an idle poll costs 355ms of server time at 2,000 turns
  (`P15-02` finding 2). It needs a delta-aware repository read.
- `P15-06`-`P15-20` remain. Documentation should follow the auction-track
  decision; the demo and release tasks need live Agents and a human operator.
- `P15-06`-`P15-08` (documentation) should not start until the auction-track
  comparison is settled, since they freeze whichever model `main` carries.

## Verification log

| Date | Commit | Check | Result |
|---|---|---|---|
| 2026-08-31 | `main` | **`P15-05` data-model fix re-measurement** — `npm run scale:p15-01`, sizes 100/500/1,000/2,000 | **Completed (196s, was 1,895s):** DB 0.43/2.14/4.28/8.56 MiB (was 0.68/8.43/29.43/109.22) — linear at ~4.28 KB/turn; mutation p50 30.33 ms at 2,000 (was 394.58); one prompt 2.06 s at 2,000 (was 23.84 s). Serialisation wall moved from ~4,426 to ~120,000 turns. |
| 2026-08-31 | `main` | **Phase 15 gate after `P15-03`/`P15-05`** — `npm run check` | **Passed (exit 0):** 30 server files / 577 tests, 3 web files / 50 tests, both typechecks, both production builds. |
| 2026-08-31 | `main` | **`P15-02` read-path measurement** — `npm run scale:p15-02`, sizes 100/500/1,000/2,000 | **Completed (1,660s):** full read 0.53 → 88.35 MiB (7.68 → 622.77 ms); idle delta flat at ~1.6 KB but 2.54 → 355.5 ms; wave delta 80.8 KB → 896.0 KB for an identical 32 events. Delta saves 103× of bandwidth at 2,000 turns but no server time — the route clones the whole database before filtering. Client was already delta-only; no client change needed. |
| 2026-08-31 | `main` | **`P15-03` guidance + UI warning** — `npm run check` | **Passed (exit 0):** 30 server files / 571 tests, 3 web files / 50 tests (+3 for the new session-length warning), both typechecks, both production builds. |
| 2026-08-31 | `main` | **`P15-01` store scale measurement** — `npm run scale:p15-01`, sizes 100/500/1,000/2,000 | **Completed (1,895s):** DB 0.68 → 109.22 MiB; mutation p50 2.13 → 394.58 ms; `getRunDetails` 1.97 → 361.59 ms; one prompt 0.14s → 23.84s. Growth is quadratic (`inputArtifactIds`). Fit over seven sizes reproduces every point to 0.3% and hits Node's 512 MiB string limit at ~4,426 turns — 4.4% of the documented 100,000 ceiling. 10,000 unreachable, recorded as measured-impossible. |
| 2026-08-31 | `phase-14` | **Checkpoint 14 gate** — disposable Docker Compose `npm run check` | **Passed (exit 0):** 30 server files / 571 tests, 3 web files / 47 tests, both typechecks, and both production builds. The `__proto__` test passes under the locked `zod` 4.4.3. |
| 2026-08-31 | `phase-14` | **Checkpoint 14 live rehearsal** — three ten-Agent coordinator-planned sessions | **Passed:** `b1f291a8` (countdown 22.72s / fan-out 8.27s / third 9.54s), `7d750f5c` (19.10 / 7.79 / 8.31s), `c4890719` (22.88 / 9.37 / 6.81s). Ordered 10→1 via sequential plan with no numeric validator; fan-out parallel; session live after the third prompt. Genuine rejection + recovery in `f8ae3635` (attempt 1 `invalid_output`, attempt 2 committed). |
| 2026-08-31 | `7985ca3` | **Checkpoint 13 live gate** — six- and ten-participant parallel waves | **Passed:** six participants `5e04164e` (6/6 attempts first-try, 4.15s, cap 4: 4 then 2, 22 events); ten participants `492a52c3` (10/10 first-try, 5.14s, cap 4: never more than 4 in flight, 34 events). Peak container memory 151.7 MiB (3.7% of 4 GiB); zero 429 responses. ~8.5x over the Phase 10 ~44s sequential baseline. All Agents returned ready. |
| 2026-08-31 01:11-01:13 UTC | `phase-12` working tree | Checkpoint 12 live Compose rehearsal | **Passed:** one three-Agent run accepted three real prompts, survived an idle server restart, continued the same transcript, produced 12 ordered artifacts and 35 pre-End gapless events, then ended explicitly and rejected a later send. Prompt sizes 144/166/156 characters; wave latencies 7.183/6.231/5.589s. Visual automation was unavailable and is not claimed. |
| 2026-08-31 01:08 UTC | `phase-12` working tree | **Checkpoint 12 gate** — final scoped Docker Compose `npm run check` | **Passed (exit 0):** 28 server files / 517 tests, 3 web files / 43 tests, both typechecks, and both production builds (560 tests total). The focused 124-test durability set then passed three consecutive runs. |
| 2026-08-31 | `3b11bef` | Checkpoint 11 final gate and manual restart check | **Passed:** 28 server files / 503 tests, 3 web files / 37 tests, both typechecks/builds (540 total), followed by the user's successful mid-attempt restart and Agent recovery check. |
| 2026-08-30 13:16 UTC | `e93ffb5` | Pre-merge Checkpoint 8 Docker Compose rerun | **Passed (exit 0):** the exact pushed Phase 8 commit again passed 27 server files / 474 tests, 2 web files / 27 tests, both typechecks, and both builds (501 tests total). `main` and `origin/main` were identical before the non-fast-forward merge. |
| 2026-08-30 12:13 UTC | `phase-8` working tree | **Checkpoint 8 gate** — final scoped Docker Compose build and `npm run check` | **Passed (exit 0):** 27 server test files / 474 tests, 2 web test files / 27 tests, both typechecks, and both production builds (501 tests total). The build used the repository Dockerfile and the check used the required clean, read-only source copy. `npm ci` still reports 1 moderate and 5 high audit findings deferred to the Phase 9 security task. **This is the completion gate for P8-01-P8-14.** |
| 2026-08-30 12:05-12:10 UTC | `phase-8` working tree | Checkpoint 8 real Compose browser rehearsal | **Passed:** real 10-to-1 countdown (11.880s), unanimous three-turn free chat (5.321s), honest wrong-number rejection/retry/recovery (10.084s), verified handoff regression (11.335s), and a shared-session stop/cancellation flow. Desktop and mobile layout passed with no page overflow; console warnings/errors were empty. |
| 2026-08-30 | `phase-8` working tree | Phase 8 focused Compose web iterations | Initial focused runs exposed only new test/scaffolding defects: a discriminated-union fixture typing error, one transcript selector mismatch, and a fake-timer test using an async finder. Each was corrected without weakening product assertions. Final focused result: web typecheck plus 2 files / 27 tests passed. |
| 2026-08-30 08:32 UTC | `2fe14eb` | **Checkpoint 5 gate** — final scoped Docker Compose `npm run check` | **Passed (exit 0):** server and web typechecks, 23 server test files with 399 tests, 2 web test files with 12 tests, web build, and server build. 411 tests total; the 389-test baseline is intact and Phase 5 adds 22. Run in the Compose container (`/workspace`) against a clean working tree, so the tarred source is exactly commit `2fe14eb`. Web bundle hashes matched the pre-check byte for byte. `npm ci` continues to report 1 moderate and 5 high audit findings held for P9-16. **This is the sole completion evidence for P5-01–P5-08.** |
| 2026-08-30 | `phase5-p5-01-session-contracts` | Earlier state: gate not runnable | No container engine was reachable from the environment the work was done in — `docker`, `podman`, `nerdctl`, `colima` and `lima` all absent, no daemon. Phase 5 was held at `implemented_unverified` rather than promoted on a host run. **Superseded by the passing gate recorded above.** |
| 2026-08-30 | `phase5-p5-01-session-contracts` | Non-authoritative pre-check | Full `npm run check` passed (exit 0) from a clean `npm ci --include=dev` over the same source snapshot the Compose command copies, **run outside the checkout** on Node 22.22.2 / npm 10.9.7: server and web typechecks, 23 server test files with 399 tests, 2 web test files with 12 tests, web build, and server build. The 389-test baseline is intact (377 server + 12 web); Phase 5 adds 22 server tests. `npm ci` continues to report 1 moderate and 5 high audit findings held for P9-16. **Recorded only to predict the Compose result. This is not completion evidence and satisfies no gate.** Its prediction was exact: the Compose gate returned the same 399/12 counts and the same web bundle hashes. |
| 2026-08-30 | `phase5-p5-01-session-contracts` | Placeholder-pattern correction | The amendment's proposed form, `session_turn: (() => { throw ... })()`, evaluates at **module load**, so it throws on import: the server would not boot and all 389 tests would fail, including the test meant to prove the placeholder throws. Verified by running it. Placeholders use getters instead, which satisfy the same `Record` type (tsc exit 0), keep module load clean, and throw only when the session entry is read. |
| 2026-08-30 | `phase5-p5-01-session-contracts` | Frozen-contract assertion vs. the placeholder | `artifact-protocol.test.ts` asserted `EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND` through `toEqual`, which enumerates properties and therefore triggered the new getter. Rewritten to assert each verified-handoff mapping individually plus the exact key set, so no coverage was lost and the assertion was not weakened. |
| 2026-08-30 | `session-phase-sheets` (uncommitted) | Session phase sheets and nine-phase renumbering | Documentation-only change: added `overview-sessions.md`, phases 05–08 instruction sheets, renamed `05-release.md` to `09-release.md` with P9-xx task IDs, and updated the runbook, FILESYSTEM_MAP, and this file. No code changed, so no Compose gate was run or required; the Phase 4 gate evidence below remains the authoritative code status. |
| 2026-08-30 05:18 UTC | `phase-4` working tree | Phase 4 final Docker Compose `npm run check` | **Passed (exit code 0):** server/web typechecks, 21 server test files with 377 tests, 2 web test files with 12 tests, web build, and server build. `npm ci` continues to report 1 moderate and 5 high findings deferred to P9-16. |
| 2026-08-30 05:05–05:16 UTC | `phase-4` working tree | Phase 4 real browser completion, stop, accessibility, and responsive evidence | **Passed:** a disposable Compose deployment completed a real Planner → Critic → Finaliser run while the UI advanced automatically to 15 events and all three artifacts. A second run stopped as `STOPPED_BY_USER` with request/cancel/stopped/stale evidence. Layout passed at 1440×900 and 390×844; the narrow audit found no horizontal overflow or unlabeled inputs. The initial live flow exposed a post-start polling reset defect; an explicit polling epoch fixed it and a regression test now proves detail polling resumes after start. |
| 2026-08-30 04:51 UTC | `pre-phase4-cleanup` working tree | Phase 4 preflight Docker Compose image build and full `npm run check` | **Passed (exit code 0):** server/web typechecks, 21 server test files with 377 tests, web build, and server build. The new three-test fixture suite covers all seven required UI scenarios, gapless evidence, consistent run IDs, and forbidden capability/secret strings. `npm ci` continues to report 1 moderate and 5 high findings deferred to P9-16. |
| 2026-08-30 03:36 UTC | `phase3-p3-01-real-runtime` working tree | Initial P3-01–P3-13 focused Compose suites | **Failed:** 84/85 tests passed; the scoped-cancellation test attempted to resolve the second deferred runner before it had started. The deterministic test waited for runner admission before resolving it; no product assertion was weakened. |
| 2026-08-30 03:38 UTC | `phase3-p3-01-real-runtime` working tree | P3-01–P3-13 focused Compose typecheck and tests | **Passed:** server typecheck plus 15 tests — eight AgentService regressions, six runtime gateway race/cleanup tests, and one complete three-role real-boundary integration test. |
| 2026-08-30 03:39 UTC | `phase3-p3-01-real-runtime` working tree | Phase 3 full Docker Compose `npm run check` | **Passed (exit code 0):** server/web typechecks, 20 server test files with 373 tests, web build, and server build. `npm ci` continues to report 1 moderate and 5 high findings deferred to P9-16. |
| 2026-08-30 03:40–03:46 UTC | `phase3-p3-01-real-runtime` working tree | P3-14–P3-18 real-provider disposable Compose smoke | **Passed:** one direct gateway execution (4.789s), then three fresh Planner → Critic → Finaliser workflows (56.905–108.157s total; 12.919–59.585s per turn), each with three first-attempt commits. Agent records/messages/threads/correlations remained visible, active Playground conflicts returned `409 AGENT_RESERVED`, detail leases were absent, and no real repository runtime directories were mounted. |
| 2026-08-29 | `3d24d1b` | `npm run check` | **Blocked before typecheck:** `tsc: not found`; dependencies are not installed. Environment reports Node `18.19.1`, below repository requirement Node 22+. No test/build result may be inferred. |
| 2026-08-29 | `3d24d1b` | Static repository audit | Coordination files/routes/tests are present; `index.ts` does not construct/pass a coordination service; `JsonStore` is v1-only; `AgentService` exposes no completion handle. |
| 2026-08-29 | `docs/development-workflow-rules` | Workflow-rule documentation | Branch rule, filesystem access map, Docker Compose-only verification, mandatory final `npm run check`, and clarify-before-assuming rules added and verified. |
| 2026-08-29 | `docs/development-workflow-rules` | Initial documented Compose check | **Failed:** production image user could not remove a root-owned host Vite cache (`EACCES` under `apps/server/node_modules/.vite`). Verification command updated to isolate dependencies/build outputs in named volumes. |
| 2026-08-29 | `docs/development-workflow-rules` | Named-volume Compose check | **Failed:** separate workspace `node_modules` mounts prevented npm workspace scripts from finding `tsc`. Verification command updated to copy a clean, read-only source snapshot into one disposable workspace volume. |
| 2026-08-29 | `docs/development-workflow-rules` | Clean-copy Compose check | **Failed:** tar could not preserve host UID/GID metadata in the anonymous volume and the source snapshot was broader than the filesystem map permits. Command narrowed to npm/TypeScript contracts plus `apps/` and uses `--no-same-owner`. |
| 2026-08-29 | `docs/development-workflow-rules` | Scoped-copy Compose check | **Failed:** Compose sets `NODE_ENV=production`, so plain `npm ci` omitted TypeScript/Vitest development dependencies. Command updated to `npm ci --include=dev`. |
| 2026-08-29 | `docs/development-workflow-rules` | Final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 7 server test files with 17 tests, web build, and server build. |
| 2026-08-29 | `ea469b2` | Focused Compose typecheck and contract tests | **Passed:** server/web typechecks plus construction and route contract tests. |
| 2026-08-29 | `ea469b2` | Final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 9 server test files with 23 tests, web build, and server build. `npm ci` reported 1 moderate and 5 high audit findings for later security review. |
| 2026-08-29 | `ea469b2` | Live application availability | **Partial:** `/api/health` is healthy and `/api/auth` confirms authentication is required. Manual authenticated lifecycle/model turns were not attempted without authorized credentials. |
| 2026-08-29 10:04:04 UTC | `d806e8f` | P0-04 manual existing-application regression | **Passed:** health, Agent list/create/edit/stop/start, one ordinary Playground run, return to ready, message persistence after refresh, deletion, and post-delete refresh. Optional stopped-Agent message rejection was not checked. |
| 2026-08-29 10:04:04 UTC | `d806e8f` | P0-05 manual three-Agent baseline | **Passed:** three genuinely fresh Agents began ready with empty histories; Planner, Critic, and Finaliser each completed one ordinary turn; all returned ready; final isolation and readiness passed. |
| 2026-08-29 10:27:04 UTC | `bd691de` | P1-01 focused Docker Compose test | **Passed:** `workflow.test.ts`, 4 tests covering deterministic sequence selection and invalid candidate exclusion. |
| 2026-08-29 10:27:04 UTC | `bd691de` | Final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 10 server test files with 27 tests, web build, and server build. `npm ci` continues to report 1 moderate and 5 high audit findings for later security review. |
| 2026-08-29 10:32:20 UTC | `eb6756a` | P1-02 focused Docker Compose test | **Passed:** `workflow.test.ts`, 10 tests covering selectors and all normal routing transitions, including revised-proposal precedence. |
| 2026-08-29 10:32:20 UTC | `eb6756a` | Final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 10 server test files with 33 tests, web build, and server build. |
| 2026-08-29 10:34:53 UTC | `phase1-p1-03-workflow-guards` | Initial P1-03 focused Docker Compose test | **Failed:** 17/18 passed; the revised-proposal fixture reset `nextTurnSequence` below its committed turns and correctly received `INVALID_STATE`. The fixture was corrected without weakening the guard. |
| 2026-08-29 10:35:17 UTC | `6f03c3e` | P1-03 focused Docker Compose test | **Passed:** `workflow.test.ts`, 18 tests covering selectors, normal routing, ceilings, and malformed durable states. |
| 2026-08-29 10:36:10 UTC | `6f03c3e` | Final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 10 server test files with 41 tests, web build, and server build. |
| 2026-08-29 10:38:50 UTC | `b0c1292` | P1-04 focused Docker Compose test | **Passed:** `workflow.test.ts`, 26 pure tests: 4 selector tests, 9 routing/limit table rows, and 13 invalid-state table rows. |
| 2026-08-29 10:39:39 UTC | `b0c1292` | Final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 10 server test files with 49 tests, web build, and server build. |
| 2026-08-29 11:10 UTC | `phase1-p1-05-artifact-schemas` | Initial P1-05 full Docker Compose `npm run check` | **Failed at server typecheck:** Zod's optional `sectionKey` output included explicit `undefined`, conflicting with the frozen exact-optional `ReviewIssue` type. Schema output was normalized to omit undefined rather than weakening the type. |
| 2026-08-29 11:12:02 UTC | `162da1d` | P1-05 focused Docker Compose test | **Passed:** `schemas.test.ts`, 20 tests covering valid fixtures, every string/array boundary, whitespace, strictness, slugs, discriminators, and optional normalization. |
| 2026-08-29 11:12:47 UTC | `162da1d` | Final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 11 server test files with 69 tests, web build, and server build. |
| 2026-08-29 | `ea15e37` | P1-06 final scoped Docker Compose `npm run check` | **Passed** (user-run): 12 server test files with 87 tests, both builds. P1-06 is `complete` on this evidence. |
| 2026-08-29 17:40 UTC | `f3caed5` | P1-07–P1-17 Docker Compose `npm run check` | **Not run.** No container engine is reachable from the environment the work was done in: the shell holding the checkout has no Docker, Podman, or Colima, and the alternative host is blocked from pulling `node:22-bookworm-slim` (403). Per the runbook these tasks therefore stay `implemented_unverified`; the check must be run on a host with Docker before any promotion. **Superseded by the passing gate recorded below.** |
| 2026-08-29 17:43:51 UTC | `f3caed5` | **Checkpoint 1 gate** — final scoped Docker Compose `npm run check` | **Passed:** server and web typechecks, 14 server test files with 237 tests, web build, and server build. Image built from `node:22-bookworm-slim`; `npm ci` continues to report 1 moderate and 5 high audit findings held for release review. This is the sole completion evidence for P1-07–P1-17. |
| 2026-08-30 02:15 UTC | `phase2-p2-05-events-redaction` | P2-05–P2-07 focused Docker Compose typecheck and tests | **Passed:** server typecheck plus 38 tests — 25 redaction tests (bearer/authorization/cookie/set-cookie/JWT/provider-key/lease-token patterns, redaction ordered before truncation, visible truncation, allowlist rejection of prompts and lease tokens under five spellings, bounded arrays, dropped objects, stable key order) and 13 event tests (all 17 frozen types covered, stable messages, actor attribution, `truncated` detail, Finaliser label with `finalizer` enum). |
| 2026-08-30 02:17 UTC | `phase2-p2-05-events-redaction` | P2-05–P2-07 final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 16 server test files with 285 tests, web build, and server build. Sole completion evidence for P2-05–P2-07. |
| 2026-08-30 02:22 UTC | `phase2-p2-08-durable-repository` | P2-08–P2-14/P2-20/P2-21 focused Docker Compose typecheck and `repository.test.ts` | **Passed:** server typecheck plus 51 repository tests. |
| 2026-08-30 02:24 UTC | `phase2-p2-08-durable-repository` | Race suite repeated ten times through Docker Compose | **Passed 10/10, no flakes.** Required by the phase sheet before the lease/race gate can be considered met. Races are driven by `Promise.all` over the store's serialised mutation queue and by explicit state sequencing — no sleeps anywhere in the suite. |
| 2026-08-30 02:25 UTC | `phase2-p2-08-durable-repository` | P2-08–P2-14/P2-20/P2-21 final scoped Docker Compose `npm run check` | **Passed (exit code 0):** server/web typechecks, 17 server test files with 336 tests, web build, and server build. `npm ci` continues to report 1 moderate and 5 high audit findings held for release review (P9-16). Sole completion evidence for these tasks. |
| 2026-08-30 02:29 UTC | `phase2-p2-15-api-composition` | P2-15/P2-16/P2-22 focused Docker Compose typecheck and `api.test.ts` | **Passed:** 25 tests over the real durable stack. Two initial failures were test defects, not product defects: the service correctly returns the frozen `DUPLICATE_AGENT` code where the test expected `VALIDATION_FAILED`, and a temp-directory cleanup raced a still-running background loop. Both were corrected without weakening an assertion. |
| 2026-08-30 02:31 UTC | `phase2-p2-15-api-composition` | Race and API suites repeated eight times through Docker Compose | **Passed 8/8, no flakes.** |
| 2026-08-30 02:32 UTC | `phase2-p2-15-api-composition` | **P2-17 live composition-root boot** in a disposable container | **Passed:** the built server started, `/api/health` returned `200`, authenticated `/api/coordination-runs` returned `200 {"runs":[]}`, an unknown run returned `404` in the frozen envelope, the removed `/events` route returned `404`, and the new database was written at `"version": 2` with all five coordination collections. Run against container-local temporary data directories; real `data/`, `workspaces/`, and `codex-home/` were never mounted or touched. |
| 2026-08-30 02:32 UTC | `phase2-p2-15-api-composition` | Production error-envelope reproduction | **Failed, then fixed.** Production returned Fastify's default 404 serialization instead of the frozen `ApiErrorResponse`. Root cause and fix recorded under **Defects found in Phase 2**. Re-verified: both `test` and `production` now return `{"error":{"code":"NOT_FOUND","message":"Coordination run not found"}}`. |
| 2026-08-30 02:34 UTC | `phase2-p2-15-api-composition` | **Checkpoint 2 gate** — final scoped Docker Compose `npm run check` | **Passed (exit code 0):** server/web typechecks, 18 server test files with 362 tests, web build, and server build. Sole completion evidence for P2-15–P2-19 and P2-22, and the Checkpoint 2 gate. |
| 2026-08-30 02:06 UTC | `d81635a` | Phase 2 baseline Docker Compose `npm run check` on branch `phase2-p2-01-database-v2` | **Passed** before any edit: server/web typechecks, 14 server test files with 237 tests, web build, and server build. Establishes the green baseline the Phase 2 work starts from. |
| 2026-08-30 02:09 UTC | `phase2-p2-01-database-v2` | P2-01–P2-04 focused Docker Compose typecheck and `store.test.ts` | **Passed:** server typecheck plus 11 store tests covering empty v2 startup, realistic v1 migration with field/timestamp preservation, unknown-field preservation, v2 round-trip with coordination collections and Agent Run correlation, and non-overwriting rejection of future, malformed, and unparseable documents. |
| 2026-08-30 02:10 UTC | `phase2-p2-01-database-v2` | P2-01–P2-04 final scoped Docker Compose `npm run check` | **Passed:** server/web typechecks, 14 server test files with 247 tests, web build, and server build. Sole completion evidence for P2-01–P2-04. |
| 2026-08-29 17:40 UTC | `f3caed5` | Non-authoritative pre-check | 14 server test files, 237 tests, both builds pass under Node 22.23.2 / npm 10.9.8 from a clean `npm ci --include=dev` over the same source snapshot the Compose command copies, run outside the checkout. Recorded only to predict the Compose result. **This is not completion evidence and does not satisfy any gate.** |

## Manual Phase 0 verification report

### P0-04 — Existing application regression

| Check | Result |
|---|---|
| Health endpoint | Passed |
| Agent list | Passed |
| Create temporary Agent | Passed |
| Edit temporary Agent | Passed |
| Stop temporary Agent | Passed |
| Stopped-Agent message rejection | Not checked; optional and not required by P0-04 |
| Start temporary Agent | Passed |
| Execute one ordinary Playground run | Passed |
| Agent returned to ready | Passed |
| Messages persisted after refresh | Passed |
| Delete temporary Agent | Passed |
| Refresh after deletion | Passed |
| Overall P0-04 | **Passed** |

### P0-05 — Three fresh Agents

| Check | Result |
|---|---|
| Create three genuinely fresh Agents | Passed |
| All began ready with empty histories | Passed |
| Verify three-Agent baseline | Passed |
| Planner ordinary turn | Passed |
| Critic ordinary turn | Passed |
| Finaliser ordinary turn | Passed |
| All returned to ready | Passed |
| Final isolation and readiness | Passed |
| Overall P0-05 | **Passed** |

## Known blockers and risks

| Item | Impact | Resolution |
|---|---|---|
| Shared ChatGPT context inaccessible in this environment | Possible decisions outside `overview.md` were not audited. | Copy any missing decisions into `ASSUMPTIONS_AND_DECISIONS.md`; overview remains current authority. |
| Code ahead of gates | Merged code can create false confidence about completion. | Retain `implemented_unverified` until required phase evidence passes. |
| `zod` 4.5.4 breaks a passing security test | The `__proto__` regression test in `artifact-protocol.test.ts` fails on any tree resolving `zod` above 4.4.3, because `.strict()` now rejects a JSON-parsed `__proto__` own property as an unrecognised key. The *product* behaviour is arguably fine - the payload is refused rather than accepted - but the test asserts acceptance. Found 2026-08-31 during Phase 14; pre-existing on `main`. | **Resolved 2026-08-31.** `apps/server/package.json` now pins `"zod": "4.4.3"` exactly (was `^4.1.13`, which resolved to 4.5.4 on a lockfile refresh). The security test keeps asserting current accept-and-strip behaviour. Full suite green after the pin: 571 server / 47 web. Revisit in `P15-07` if the rejection semantics are preferred; changing it is a contract change to what the test guarantees. |
| Dependency audit reports 6 findings | Later security/release review must assess 1 moderate and 5 high findings without blindly applying breaking upgrades. | Review in the appropriate dependency/security task before release. |
| ~~Detail response exposes lease tokens~~ | Resolved by a public attempt read model that omits the internal capability. | Closed 2026-08-30; API and live smoke assert absence. |
| ~~Current Agent cancellation is keyed by Agent ID~~ | Resolved by `cancelRun(agentRunId)` plus an active-run ownership guard; the provider's Agent-keyed primitive is invoked only while that exact run still owns the Agent. | Closed 2026-08-30; stale-run regression passes. |
| ~~Docker unreachable from the environment used for P1-07–P1-17~~ | Resolved. The gate was run on a host with Docker and passed; the tasks were promoted on that evidence. | Closed 2026-08-29. Any future assistant-run work must route the gate to a host with a container engine rather than substituting a host runner. |
| ~~Phase 1 implementation decisions not yet confirmed~~ | Resolved. All nine were confirmed unchanged on 2026-08-30 before P2-01, together with the four Phase 2 handoff decisions. | Closed 2026-08-30. |
| `stale_ignored` attempt status has no producer | By the confirmed §2.1 decision, evidence lives in the `attempt.stale_ignored` event, so the `CoordinationAttemptStatus` member stays unwritten. | Accepted. Phase 4 successfully renders the event-stream evidence in the stopped flow; revisit only if the contract changes. |
| Optional `relay/contracts-v1` tag is absent | Older status text incorrectly implied the convenience tag existed. The immutable commit remains sufficient for the contract gate. | Recorded during Phase 4 preflight. Create/push a tag only after an explicit decision. |

## Decision log summary

- Code enum/API spelling is `finalizer`; user-facing label is “Finaliser.”
- `AgentService.startExecution()` owns the completion-handle seam; `sendMessage()` remains its compatible wrapper.
- `JsonStore` requires explicit additive migration; there is no existing hook.
- Routes register through optional `createApp(..., coordination)`; `index.ts` composes the real repository and AgentService-backed runtime.
- Three real rehearsals measured 12.919–59.585 seconds per turn; the 120-second default attempt timeout remains unchanged.
- Verified-handoff Stop remains terminal and idempotent `202`; Phase 12 session
  Stop cancels only the current wave and returns to `awaiting_input`, while End
  is the explicit terminal action.
- The detail route is the only event retrieval contract; the accidental `/events` endpoint was removed.
- Frozen contract commit is the immutable reference `ea469b2`; the optional `relay/contracts-v1` convenience tag is absent.
- Approved P1-01 mini-RFC adds committed turns to `WorkflowView`; selectors order by `turn.sequence`, never artifact array position or timestamps.
- Approved P1-05 mini-RFC freezes numeric artifact field/array limits while retaining the separate raw-output cap for P1-06.
- Nine Phase 1 implementation decisions are recorded in `ASSUMPTIONS_AND_DECISIONS.md`; they change no frozen type, route, or persisted shape, and were confirmed unchanged on 2026-08-30.
- Four Phase 2 handoff decisions settled on 2026-08-30: `sizeChars` stays the raw-output length; `truncated` is an `attempt.started` event detail only; `outputDigest` is populated at commit; `attempt.stale_ignored` is emitted as an event without extending the `finishAttempt` status union. None is a mini-RFC.
- `DatabaseV2` migration is additive by spread, so unknown fields in an existing v1 file are preserved rather than dropped.
- `app.ts` must register `setErrorHandler` before the production static/not-found block; the reverse order silently breaks the frozen error envelope in production only.
- The approved additive mini-RFC adds `BeginAttemptInput.truncated?` and `CommitAcceptedArtifactInput.outputDigest?`, the only route by which the confirmed §1.2 and §1.3 decisions can reach the repository.
- Approved Phase 2 follow-up mini-RFCs remove redundant `PromptEnvelope.includedArtifactIds` and exclude `leaseToken` only from the public attempt read model, leaving durable lease enforcement unchanged.
- Phase 4 uses fixture-driven automated component tests for all required UI states, with browser verification for the real normal and stop flows; both gates passed and details are recorded in `ASSUMPTIONS_AND_DECISIONS.md`.
- Active detail polling uses a monotonic epoch to restart after the explicit start transition, avoiding dependence on React batching when the selected run ID is unchanged.
- The implementation plan now has nine phases. Phases 5–8 build the shared-session workflow (session contracts, session core, session durable, session UI); the former Phase 5 release phase becomes Phase 9 with its task IDs renumbered from P5-xx to P9-xx. Phase 9 releases both workflows.
- The frozen session contract is the immutable commit `2fe14eb`, verified by the Checkpoint 5 Compose gate. No convenience tag was created; whether to add one is an open team decision, deliberately not assumed after the Phase 0 `relay/contracts-v1` discrepancy.
- Phase 5 was granted an exhaustiveness scope amendment: it may add loud throwing placeholders to `Readonly<Record<...>>` tables outside its filesystem map, for that purpose only. Placeholders are getters, not IIFEs — an IIFE in an object literal evaluates at module load and would throw on import.
- The Phase 5 exhaustiveness audit identified `repository.ts` `expectedArtifactTypeForTurn` and `context-builder.ts` `capPayload`; P7-02 and Phase 6 replaced both silent paths with explicit session handling and exhaustive coverage.
- Free-chat runs complete on unanimous latest `done` signals, at `maxTurns`, or on user stop. The signal is advisory and evaluated by backend code, so no Agent ends a run. The team confirmed this rule before P6-01 and Phase 8 demonstrated it live.
- The session extension is governed by `overview-sessions.md` (repository-local authority, adapted from the team's extension plan); `overview.md` remains the authority for the verified workflow and the shared engine semantics.
- Session contract code (additive types, contracts, fixtures) lands in Phase 5; session behavior (workflow, protocol, context, service create branch, walking skeleton) lands in Phase 6, mirroring the original Phase 0 and Phase 1 split.
- The session prompt never states the expected number; Agents derive it from the transcript and the countdown validator is the sole authority. Wrong numbers retry the same Agent and a second failure ends the run with `MAX_ATTEMPTS_EXCEEDED`.
- The session extension includes a second protocol, `free_chat`, on the same `shared_session_v1` workflow: bounded non-empty messages, completion on a unanimous `done` round, at `maxTurns` (default 6), or on user stop, no start value and no next-expected state. The middleware guarantees mechanics and never judges message substance.
- 2026-08-30 consolidation pass: the free-chat completion signal (unanimous `done`) and the final-artifact-pointer rule (last committed session message) were confirmed by the whole team. No new `CoordinationEventType` for `done`; it rides on committed artifacts. The Phase 6–9 sheets, `FILESYSTEM_MAP.md`, and the README source-of-truth order were synced so the docs match the frozen contract.
- Checkpoint 8 keeps the existing Relay visual language and one `App.tsx` owner, adds only the session-specific form/evidence surfaces, and proves that the same public API and polling chain support both workflows. Live timings invalidate the earlier worst-case latency assumption for the measured endpoint but do not remove Phase 9 fallbacks.

See [`ASSUMPTIONS_AND_DECISIONS.md`](./ASSUMPTIONS_AND_DECISIONS.md) for full rationale.

## How to update this file

After each work session:

1. change the audit date/commit;
2. record the task branch and base commit;
3. move task IDs only when their required evidence exists;
4. append Docker Compose verification results, including the final `npm run check` and failures;
5. update **Resume here** to the next one to three executable actions;
6. record clarified questions, deviations/mini-RFCs, and new risks;
7. never record secrets, raw prompts/output, or lease tokens.
