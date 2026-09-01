# Session Development Status

**Last audit:** 2026-09-01 (Phase 15 scale, storage, documentation, demo, clean
release, browser, and security gates complete)
**Audited checkpoint:** Checkpoint 15 complete in submission commit
`1e3318fb23ce11615cce854b9a188029e01a80a8`
**Implementation branch:** `bidding-agent-implementation` (auction-track root
`aa17407`)
**Phase 7 implementation commit:** `8775c00` (`Complete durable session backend phase`)
**Current phase:** Phase 15 - Scale, Storage, and Release (`complete`)
**Current gate:** Checkpoint 15 **complete**; feature work is frozen
**Overall state:** Phases 0-8 and 10 `complete`; Phase 9 `superseded` by Phase 15;
Phases 11-12 and auction Phases 13-14 `complete`; Phase 15 `complete`

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
| 13 | Auction foundation and purpose-aware parallel waves | `complete` on `bidding-agent-implementation` — all of `PA13-01`-`PA13-20`; Auction Checkpoint 13 met (sheet: [`phases/parallel/13-auction-foundation.md`](phases/parallel/13-auction-foundation.md)) |
| 14 | Adaptive auction coordination | `complete` on `bidding-agent-implementation` — `PA14-01`-`PA14-27` all complete; Auction Checkpoint 14 closed at `dbc359c` (auction sheet: [`phases/parallel/14-adaptive-auction-coordination.md`](phases/parallel/14-adaptive-auction-coordination.md)); main-track sheet unchanged |
| 15 | Scale, storage, and release | `complete` at `1e3318fb23ce11615cce854b9a188029e01a80a8` (sheet: [`phases/15-scale-and-release.md`](phases/15-scale-and-release.md)) |

Phases 10-15 implement the Session v2 plan in
[`plans/session-v2-plan.md`](plans/session-v2-plan.md), approved through the
Session v2 mini-RFC in
[`ASSUMPTIONS_AND_DECISIONS.md`](ASSUMPTIONS_AND_DECISIONS.md).

The session extension was adopted from the team's Relay Sessions plan. Its repository-local contract authority is [`overview-sessions.md`](overview-sessions.md). Phase 9 was formerly Phase 5; its task IDs moved from P5-xx to P9-xx.

**Checkpoints 10, 11, and 12 are complete.** `P12-01` through `P12-16` are all
done. The stale-path classification below remains the `P11-01` deliverable and
the contract the reconciler implements.

**Resume here.** Checkpoint 15 is closed and feature work on this release
candidate is frozen. There are no outstanding Phase 15 tasks. Any storage
engine replacement, first-read pagination, or multi-process work starts from a
new approved phase rather than changing this release candidate.

The restart-reconciliation defect that blocked `PA14-27` is fixed. Boot recovery
(`interruptActiveRuns`) now keeps an auction round with pending work `running`
with no active turn instead of parking it in `awaiting_input` where nothing
re-derives it, and re-marks an interrupted award-execution turn `cancelled`
rather than `failed`; the workflow discharges an assignment only on a committed
turn. Both changes are gated on `auctionPolicy !== undefined`, so legacy
sessions, direct rounds, and verified handoffs are unchanged. The remediation
plan is
[`plans/pa14-27-restart-reconciliation-fix.md`](plans/pa14-27-restart-reconciliation-fix.md);
the regression lives in `auction-restart-recovery.test.ts`.

The mandatory disposable Docker Compose gate passes on the release candidate:
**38 server files / 697 tests**, **5 web files / 68 tests**, both workspace
typechecks, and both production builds (**765 tests total**). `npm ci` reports
the unchanged 1 moderate and 5 high dependency-audit findings. A separate
`docker compose build launchpad` also passes.

## Phase 15 task ledger

| Task | Status | Current implementation/evidence |
|---|---|---|
| P15-01 | `complete` | `npm run scale:p15-01` uses a fresh temporary `JsonStore`, establishes a real validated auction-wave shape, materialises only unmeasured setup history, and measures real final mutations, snapshot memory, detail reads, and prompt construction at 100/500/2,000/10,000 turns. Results are below and in `COORDINATION_OPERATIONS.md`. |
| P15-02 | `complete` | `npm run scale:p15-02` measures the real Fastify full/delta routes and 1.5-second polling bytes. The browser already performs one full load then delta-only active polling; no client change was needed. |
| P15-03 | `complete` | Default/recommended `maxTurns` is 2,000, the UI warns at 1,600 and whenever creation exceeds the recommendation, and the explicit 100,000 hard ceiling remains available without a performance claim. |
| P15-04 | `complete` | Mini-RFC keeps `JsonStore` for this single-process release after first removing the quadratic transcript-ID representation. |
| P15-05 | `deferred (complete)` | No storage swap. The measured practical recommendation is 2,000 turns; the deferral and later swap triggers are recorded in `COORDINATION_OPERATIONS.md` and `DECISIONS.md`. |
| P15-06 | `complete` | Root README now describes the shipped adaptive-auction Session product, setup, lifecycle, evidence, failure/recovery, verification, measured limits, and honest constraints. |
| P15-07 | `complete` | Shipped architecture, protocol, API, operations, and decision references exist at the root of `docs/` and match the auction implementation. |
| P15-08 | `complete` | This ledger, `overview-sessions.md`, `FILESYSTEM_MAP.md`, and superseded Phase 9 sheet describe the final Phase 15 layout and contract. |
| P15-09 | `complete` | Repository-local Markdown audit found 53 files, zero broken local links and zero absolute local paths; documented command names and anchors were checked from the release tree. |
| P15-10 | `complete` | `AGENT_TEMPLATES.md` supplies ten collaborative participants, including a coordinator-capable Agent and deliberately unreliable Agent. |
| P15-11 | `complete` | `DEMO.md` separates the honest three-minute recorded narration from the long-form live rehearsal, names every state, fallback, reset, security, and latency beat. |
| P15-12 | `complete` | Approved real run `40f52425` supplies ordered, parallel, multi-prompt restart, genuine invalid-bid recovery, contention, Stop, and resume evidence. Its portable content-free report is `docs/recordings/PA14-27.md`; the prepared release state retains the one labelled fallback run only. |
| P15-13 | `complete` | Three automated browser playback rehearsals covered ordered, parallel, awaiting, ended, stopped, and failed states in 1.225–1.369 seconds each. The provider-backed source run records 4.3–325.2 seconds per round. An independent reader reproduced the documentation audit after the clean-checkout/demo corrections. Exact implementation commit: `1e3318fb23ce11615cce854b9a188029e01a80a8`. |
| P15-14 | `complete` | Full status/diff review preserved unrelated history and excludes `.env`, `data/`, workspaces, logs, generated graph output, and ignored scale reports. |
| P15-15 | `complete` | Disposable clean-source Docker Compose gate: 697 server + 68 web tests, both typechecks, both production builds, 765 tests total. Release image build passes. |
| P15-16 | `complete` | In-app browser verified current awaiting-input, completed/End, stopped, failed, idle-restart, ordered-award, and parallel-award states against the release image; console errors/warnings were empty. |
| P15-17 | `complete` | Logs, full archived database, API details, and visible Session DOM passed content-free scans: public attempts expose no leases; events use allowed bounded keys; no auth/cookie/stack/raw prompt values were found; user prompts occur only in `user_message` artifacts/transcript. |
| P15-18 | `complete` | The legacy 12 product criteria and all 9 shipped Session criteria are covered by the clean gate, browser flows, durable restart/lease/race tests, CRUD regressions, and the request ledger below. |
| P15-19 | `complete` | Local release state was reduced from 28 coordination runs/633 Agent runs/1,255 messages to the one labelled content-free fallback Session and its ten reset participants; the recoverable full archive is outside the repository. |
| P15-20 | `complete` | Submission implementation commit `1e3318fb23ce11615cce854b9a188029e01a80a8`; release feature work frozen. This exact hash is recorded by the immediate ledger-only follow-up commit. |

### P15-01 measured store cost

Measured on Node v24.12.0 / darwin arm64; no point is extrapolated:

| Turns | DB | mutation p50 | mutation p95 | mutation max | snapshot | heap | RSS | detail | final prompt |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 0.42 MiB | 22.32 ms | 25.27 ms | 26.91 ms | 1.09 ms | 0.71 MiB | 122.58 MiB | 2.42 ms | 0.11 s |
| 500 | 2.05 MiB | 130.05 ms | 157.04 ms | 159.08 ms | 5.94 ms | 3.55 MiB | 181.36 MiB | 14.09 ms | 0.63 s |
| 2,000 | 8.21 MiB | 529.00 ms | 833.28 ms | 868.37 ms | 23.93 ms | 14.37 MiB | 536.92 MiB | 64.58 ms | 2.97 s |
| 10,000 | 41.15 MiB | 2,697.20 ms | 5,655.91 ms | 6,034.24 ms | 105.13 ms | 53.93 MiB | 1,705.03 MiB | 226.45 ms | 18.05 s |

### P15-02 measured polling cost

| Turns | full payload / read | idle delta / read | active-wave delta / read | full vs active-delta bytes |
|---:|---:|---:|---:|---:|
| 100 | 0.31 MiB / 9.35 ms | 1,866 B / 2.57 ms | 37,238 B / 2.80 ms | 8.61× per minute |
| 500 | 1.53 MiB / 13.06 ms | 1,868 B / 11.24 ms | 37,261 B / 10.10 ms | 43.07× per minute |
| 2,000 | 6.15 MiB / 55.06 ms | 1,870 B / 45.10 ms | 37,335 B / 46.24 ms | 172.65× per minute |
| 10,000 | 30.86 MiB / 271.06 ms | 1,874 B / 213.70 ms | 37,442 B / 218.38 ms | 864.38× per minute |

### Session v2 request acceptance ledger

| Request | Acceptance evidence |
|---|---|
| 1. Recover Agents after completion | End, Stop, failure, restart, and reconciliation tests plus browser flows leave no reservation without running work; cleaned demo participants are `ready`. |
| 2. Remove verified handoff UI | Session is the only coordination workspace; the legacy server workflow remains readable and regressed. |
| 3. Remove countdown | Countdown creation/execution is deleted while the stored-history compatibility test and web read rendering remain green. |
| 4. Support up to 10 Agents | Contract/UI bounds are 2–10; real ten-bid auction, scale harness, and release tests pass. |
| 5. Raise turn ceiling | Explicit max is 100,000; measured default/recommendation is 2,000 with warning at 1,600 and additive compact transcript bounds. |
| 6. Long-lived multi-prompt Sessions | `awaiting_input`, user messages, Stop/resume, explicit End, one durable transcript, and idle restart are exercised in tests and the real recording. |
| 7. Relay → Session | User-facing product, workspace, README, and docs use Session; retained coordination API/module names are an explicit compatibility decision. |
| 8. Parallel Agents | Purpose-aware bounded waves, atomic sibling scheduling/settlement, concurrency races, and a real three-Agent fan-out pass. |
| 9. Context-aware assignment | Adaptive private bids embed mechanically validated plans; deterministic scoring commits one award and executes single/sequential/parallel assignments with scoped context. |

### Release security inspection

- API run `40f52425`: 82 turns, 94 attempts, 84 artifacts, 306 events,
  zero public lease tokens, zero forbidden event keys, nine user messages.
- Full archived database: all 652 durable attempts retained internal leases;
  public projection exposed zero. User prompts occurred only in `user_message`
  artifacts; no non-user artifact carried a prompt field.
- Release container logs: 60 inspected lines; no authorization, bearer, cookie,
  lease-token, raw-system-prompt, or stack-trace match.
- Visible Session DOM: no authorization, cookie, lease, raw prompt contract, or
  stack text; intended user transcript content remained visible.

## Auction Phase 14 task ledger

| Task | Status | Current implementation/evidence |
|---|---|---|
| PA14-01 | `complete` | User-approved adaptive-auction addendum in `ASSUMPTIONS_AND_DECISIONS.md`, including routing/migration, prompt hardening, exact scoring arithmetic, fallback evidence, feedback, usage categories, and the long-lived roster decision. |
| PA14-02 | `complete` | Added durable `SessionAuctionPolicy`, backend defaults and hard bounds, strict nested route validation, direct-service validation, free-chat-only admission, participant-backed defaults, and mutual exclusion with the Phase 13 wave seam. Absence remains the legacy-session marker. |
| PA14-03 | `complete` | The deterministic selector implements explicit selection, sticky ownership, specialization matching, default and roster fallbacks, and stable ties. The service now supplies one schedule-time ready-Agent snapshot to Direct/Auto selection, bid-wave eligibility, scoring, and fallback; integration tests prove a busy primary is skipped and a plan assigning a busy participant is ineligible. |
| PA14-04 | `complete` | Explicit Direct schedules exactly one ordinary execution. Retry exhaustion fails without expansion by default; when `auctionOnDirectFailure` is true, the failed turn is retired, one bounded auction runs, and awarded execution is distinguished from the pre-award failure by its award input. The full recovery path is covered end to end. |
| PA14-05 | `complete` | Added strict `session_bid` turn, artifact, payload, exhaustive maps, bounded Zod schema, JSON-only parser, backend provenance, assignment/budget cross-field checks, field-specific retry feedback, own-specialisation prompt block, two minified examples, and losing-bid context exclusion. Exact field/array boundaries are covered. |
| PA14-06 | `complete` | Explicit Auction atomically schedules one fresh-thread bid turn for every participant. The shared wave builder excludes Agents with a prior bid for the PA14-07 Auto escalation path; retries stay on the same turn under `maxBidAttempts`. Walking-skeleton evidence proves one turn per Agent, private non-transcript bid commits, and bounded same-opportunity retries. |
| PA14-07 | `complete` | Auto schedules one fresh-thread primary bid. A direct recommendation is published only after recommendation, candidate, confidence, output-budget, single-plan, and durable-policy gates pass; the version-checked projection records `sourceBidArtifactId`, Agent provenance, and one transcript sequence. Recommendation/confidence misses reuse the primary bid and atomically schedule only remaining participants; exhausted primary attempts retire without failing the round. |
| PA14-08 | `complete` | `confidence_cost_v1` remains deterministic and integer-only. Auto-direct now calls the scorer without applying the competitive minimum, and reliability history uses provider-reported output usage from every attempt in the whole awarded plan rather than artifact character estimates. Cold start, calibration, reliability, score, and projected token components are regression-tested. |
| PA14-09 | `complete` | Added the turn-less, Agent-less `session_award` artifact and the single version-checked `awardSessionBid` repository command. The `(runId, userArtifactId)` key makes a competing loop and a restarted loop both observe the committed award instead of re-scoring. Award creation validates round membership, bid provenance, participant membership, and the basis-point range. |
| PA14-10 | `complete` | An accepted Auto candidate commits its award and its `session_message` projection in one mutation, at one version, with `sourceBidArtifactId` and Agent provenance and the next transcript sequence. A candidate that no longer passes its gates writes neither record. |
| PA14-11 | `complete` | An awarded execution turn carries the award artifact on its inputs and runs on a durable `threadPolicy: "fresh"`. The context builder renders one `[AWARDED PLAN AND YOUR ASSIGNMENT]` section from the award and the winning bid it names, so only the winner's plan can reach an execution prompt. |
| PA14-12 | `complete` | `single` schedules one turn; `sequential` schedules strictly by position so each later Agent sees the earlier committed messages of the same round; `parallel` schedules one bounded wave through the Phase 13 supervisor. All three derive the next assignment from committed turns, so a restart repeats no work. |
| PA14-13 | `complete` | Fewer than `minimumValidBids` valid bids applies the configured bounded fallback exactly once, recorded as a `fallback_execution` award plus an `auction.fallback_applied` event; `fail` fails the run and makes no award. A fallback Agent still receives an ordinary execution turn. Winning-execution failure and timeout fail the round and never promote a runner-up. |
| PA14-14 | `complete` | The message API accepts a strict `routing` object (`routingMode`, `selectedAgentId`, `coordinationPreference`, `riskLevel`). Every budget, concurrency, attempt, and participant field is rejected as an unknown key; `riskLevel: "high"` is normalized to an auction and may not request direct; a non-participant Agent is a `409` conflict. |
| PA14-15 | `complete` | Every read carries `auctionUsage` with `actualBidding`, `actualExecution`, and `projectedExecution`. The two actual totals always reconstruct `usageTotals`; the projection is summed only from committed awards. Lease, prompt, thread, and raw-output stripping is unchanged. |
| PA14-16 | `complete` | The create form offers Auto/Direct/Auction and an optional default Agent; the composer offers a per-round override, Agent selection, and a high-risk marker; the working state names bid evaluation separately from awarded execution; an award card shows score components, projected versus actual tokens, and an expandable evidence-only bid panel. The transcript still shows only user messages and published responses. |
| PA14-17 | `complete` | `POST /api/coordination-runs/:id/awards/:awardId/feedback` records one `accepted \| rejected` rating as an audit event containing only IDs and the enum. The award artifact and the run status are byte-identical afterwards, and the UI labels confidence as self-reported. |
| PA14-18 | `complete` | Both replacement demonstrations are green in tests and were reproduced live in run `40f52425`: the awarded sequential round committed an ordered three-Agent transcript (325.2 s) and the awarded parallel round committed a three-Agent fan-out (291.3 s). The countdown engine is deleted — protocol member, start value, `CoordinationSharedState`/`run.sharedState`, `SESSION_LIMITS` bounds, the workflow and artifact-protocol branches, the context-builder instruction, `nextCountdownValue` and the shared-state decrement in both repositories, and the route/service validation. Stored history is untouched: `buildRunDetails` returns a `structuredClone` of the stored document, so a pre-deletion run still reads back with `sessionProtocol: "countdown"`, `sessionStartValue` and `sharedState` (`countdown-removal.test.ts`), and the unchanged web read types still render it (`SessionWorkspace.test.tsx`). One create-surface change: an unnamed `sessionProtocol` now means free chat. |
| PA14-19 | `complete` | A free-chat session with no `auctionPolicy` still answers with the ordinary wave and produces no bid or award — absence remains the legacy marker. Countdown and verified-handoff fixtures pass unchanged. `splitAuctionUsage` is covered for sessions with no auction evidence and for attempts with absent or null usage. |
| PA14-20 | `complete` | Routing tests cover explicit Direct/Auction, Auto escalation, per-message/high-risk routing, selected and sticky Agents, schedule-time availability, enabled Direct-failure escalation, the disabled non-escalation control, and resolution after every bounded opportunity settles. |
| PA14-21 | `complete` | Bid validation covers forged provenance, wrong artifact type, fenced and malformed JSON, unknown fields, foreign and duplicate assignment Agents, non-contiguous positions, single-plan ownership, missing direct candidates, and each execution budget. |
| PA14-22 | `complete` | The scorer suite adds unsupported-scoring-version rejection and proof that input array order cannot change the ranking, on top of the `PA14-08` cold-start, calibration, rounding, boundary, and stable-tie coverage. |
| PA14-23 | `complete` | Competing ordinary and direct-publication awards commit exactly one award (and one candidate projection where applicable); feedback can race a detail read without exposing partial state; stale/restarted award derivation duplicates no bid, award, publication, or execution. Earlier stop/restart and duplicate-message race coverage remains green. |
| PA14-24 | `complete` | Failure tests cover partial/all invalid bidders, schedule-time busy exclusion, unavailable assignments, the minimum boundary, all fallbacks, Direct escalation, winner retry exhaustion and timeout, with no silent runner-up promotion. |
| PA14-25 | `complete` | Bid and awarded-execution attempts remain separate and reconcile with run totals. Auto-direct now records a real nonzero scoring projection while actual execution remains zero, and reliability calibration consumes durable provider usage across retry/failure attempts. No token count is converted into a cost claim. |
| PA14-26 | `complete` | Web tests cover the routing policy display, award attribution, projected-versus-actual tokens, bid-evidence expansion, transcript exclusion of losing bids, the bidding-versus-executing working state, fallback honesty, per-message routing submission, the high-risk force, and feedback recording with `aria-pressed` state. |
| PA14-27 | `complete` | Run `40f52425-ea3d-4a9c-917e-b05e08c27128` passed every round: Auto Direct (4.3 s), explicit Auction (35.3 s, 10 bids), Auto escalation (145.1 s), awarded sequential (325.2 s), awarded parallel fan-out (291.3 s), partial bidder failure (42.7 s), stop and resume (1.5 s / 3.4 s), and the exact post-bid/pre-award restart (39.6 s). The restart round preserved all ten settled bids, committed exactly one award naming a settled bid (`cd809e35`, `execute_plan`), executed it, and left no running attempt. 94 calls; 4,714,116 input / 4,449,536 cached input / 233,747 output tokens. |

### PA14-27 acceptance evidence

The driver records every call id, attempt state, elapsed time, and
provider-reported token usage without printing credentials, prompts, raw
output, provider threads, or leases. Re-reading the latest durable evidence is
deterministic:

```sh
node scripts/pa14-27-rehearsal.mjs report 40f52425-ea3d-4a9c-917e-b05e08c27128
```

All nine rounds passed and the run ended `PA14-27 PASS`. The exact-boundary
restart round is the one that previously failed: the server was paused with ten
settled bids and no award and then killed, and recovery now derives the award,
executes it, publishes the response, and settles to `awaiting_input` without
duplicating a bid, an award, or a message.

Two earlier runs are retained as history rather than acceptance.
`f09e195b-c6f5-4e29-aabd-b2271a9b9686` passed three rounds and then hit
sustained headerless provider 429s. `1e5434a4-100d-4d97-b3ea-e187a2588ad6`
passed seven rounds with capacity restored, then stranded its recovered award
as a zero-attempt `failed` turn and returned the session to `awaiting_input`.
That defect is the subject of
[`plans/pa14-27-restart-reconciliation-fix.md`](plans/pa14-27-restart-reconciliation-fix.md)
and is now fixed and regressed.

### Auction Checkpoint 14 closing evidence

- The mandatory disposable Docker Compose gate passed on the closed checkpoint:
  **38 server files / 694 tests**, **5 web files / 66 tests**, both workspace
  typechecks, and both production builds (**760 tests total**).
- `auction-restart-recovery.test.ts` adds **11 tests** across both restart
  boundaries, the derivation rule, idempotency, and the gates that must not move
  (legacy free-chat recovery, direct-round recovery, a genuinely failed awarded
  execution). They failed on the pre-fix code — 5 failed / 5 passed on the first
  red run, with the mid-bid-wave case separately verified red — and pass now.
- The focused restart set (`auction-restart-recovery`, `auction-execution`,
  `auction-award`, `auction-routing-decisions`, `lifecycle-reconciliation`)
  passed **77 tests for ten consecutive host runs**, zero flakes. The Compose
  gate above remains the authoritative verification.
- `countdown-removal.test.ts` adds **7 tests** splitting the deletion in two:
  four assert no engine path accepts a countdown session, three assert a stored
  countdown run still reads, renders, and lists.
- `npm ci` continues to report the unchanged **1 moderate and 5 high
  vulnerabilities**; no dependency changed.
- One host-only discrepancy is recorded rather than chased: the
  `artifact-protocol.test.ts` `__proto__` case fails on the development host and
  passes in Compose, because the installed zod resolves to a newer patch than
  the lockfile pins. The Compose gate is the authority and it is green.

### Phase 14 verification evidence (`PA14-09`-`PA14-26`)

- The post-implementation corrective branch passed the standard disposable
  Docker Compose gate: **36 server files / 688 tests**, **5 web files / 66
  tests**, both workspace typechecks, and both production builds (**754 tests
  total**).
- The focused `auction-routing-decisions`, `auction-award`, and
  `auction-execution` suites passed **55 tests per pass for ten consecutive
  Compose passes**, zero failures. The ten new regression tests cover enabled
  and disabled Direct-failure escalation, production availability in Auto and
  Auction, unavailable assignment rejection, Auto-direct scoring, whole-plan
  provider-usage reliability, competing direct publication, feedback/read
  concurrency, and direct-fast-path accounting.
- `npm ci` continues to report the unchanged **1 moderate and 5 high
  vulnerabilities**; no dependency changed in this correction.

- The repository-wide host `npm run check` passed both workspace typechecks,
  **36 server files / 678 tests**, **5 web files / 66 tests**, and both
  production builds (**744 tests total**).
- New suites: `auction-award.test.ts` (16 tests: award atomicity, competing and
  replayed awards, publication gates, fallback selection, feedback immutability,
  usage separation), `auction-routing-decisions.test.ts` (15 tests: routing
  table, awarded single/sequential/parallel execution, restart derivation,
  duplicate-award rejection), and `auction-execution.test.ts` (14 tests:
  end-to-end awarded team execution, failure and fallback paths, restart
  boundaries, stored-history compatibility).
- `SessionAuction.test.tsx` adds **9 web tests** for the routing surface,
  award summary, bid-evidence panel, per-message routing, and feedback.
- The first local run of the web suite failed to resolve the workspace's
  lockfile-declared Testing Library packages, exactly as the `PA14-08` audit
  recorded. A clean `npm ci` restored the locked tree; no manifest or lockfile
  changed. `npm ci` reports the unchanged **1 moderate and 5 high
  vulnerabilities**.
- The original `PA14-09`-`PA14-26` environment could not reach a Docker daemon,
  so that historical run was host-only. The passing corrective Compose gate
  above supersedes that blocker for the current implementation.

### Phase 14 verification evidence (`PA14-01`-`PA14-08`)

- The repository-wide `npm run check` passed both workspace typechecks, **33
  server files / 628 tests**, **4 web files / 57 tests**, and both production
  builds (**685 tests total**).
- Focused Auto workflow/walking-skeleton coverage passed **51 tests**. It proves
  the one-call accepted path, fresh primary thread, source-bid transcript
  projection, recommendation and exact confidence-threshold escalation, reuse
  of the primary bid, and exclusion from the remaining-participant wave.
- The scorer suite adds **9 deterministic tests** covering UTF-8 rounding,
  sequential reserve, cold start, latest-20 calibration, the exact 125%
  underestimation boundary, eligibility failures, an exact component snapshot,
  roster-stable ties, and the minimum-valid-bid boundary.
- The first repository check found the current local install lacked the web
  workspace's lockfile-declared Testing Library packages. A clean `npm ci`
  restored the locked dependency tree; no manifest or lockfile changed. The
  clean check above then passed. `npm ci` reported the unchanged **1 moderate
  and 5 high vulnerabilities**.

- `docker compose build launchpad` passed with both production builds.
- The mandatory disposable Compose `npm run check` passed both workspace
  typechecks, **32 server files / 616 tests**, **4 web files / 57 tests**, and
  both production builds (**673 tests total**).
- The first full check exposed one stale exhaustiveness assertion in
  `artifact-protocol.test.ts`; it was widened for `session_bid`, and the full
  check was rerun from the start to the clean result above.
- Focused Compose evidence passed **79 tests** across the session workflow,
  artifact protocol, context builder, and walking skeleton, plus **58 tests**
  across schema boundaries and the walking skeleton. The deterministic selector
  suite adds **6 tests**.
- `npm ci` continues to report the unchanged dependency audit finding: **1
  moderate and 5 high vulnerabilities**. No dependency version changed here.

**Verification status.** `PA13-09`-`PA13-19` were promoted to `complete` on the
user-run Docker Compose gate (see the verification log). The assistant could not
run the gate itself: no container registry was reachable from the environment
the work was done in (`registry-1.docker.io`, `mirror.gcr.io`, `public.ecr.aws`,
and `ghcr.io` each returned `403 Forbidden`), so `docker compose build launchpad`
could not resolve `node:22-bookworm-slim`, and the user's own machine has no
container engine installed.

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

- Auction alternative in progress on `bidding-agent-implementation`.
  `PA13-01` records the branch mini-RFC. `PA13-02` replaces the singular active-
  turn pointer with the required `activeTurnIds` array across durable and web
  types, repository and reconciliation paths, service/workflow validation, and
  fixtures. Legacy v2 rows normalize `activeTurnId` to a one-element array on
  read without an eager rewrite; an unrelated later mutation retains the old
  field. Single-turn scheduling refuses a second member, preserving verified-
  handoff's zero-or-one invariant. The one-line verified workflow guard change
  is the recorded mechanical compatibility exception; its decisions are
  unchanged. `PA13-03` adds backend-owned execution/bidding wave purpose;
  legacy and verified turns normalize to `session_execution`, while explicit
  `session_bidding` survives reads and later persistence. `PA13-04` adds atomic
  batch scheduling with contiguous sequences, one version check, deterministic
  events, and the verified-compatible `scheduleTurn` wrapper. `PA13-05` proves
  independent sibling commits and whole-wave settlement with deterministic
  cancellation evidence. `PA13-06` adds bounded optional Agent specialisation,
  normalized focus tags, managed-instruction rendering, API validation, web
  create/settings controls, and legacy loading. `PA13-07` snapshots that
  structure into session participants; later Agent edits do not alter the
  durable session routing metadata. `PA13-08` carries provider-neutral token
  usage through Agent completion and runtime outcomes into the same atomic
  mutation that settles each durable attempt. Full and delta detail reads expose
  lease-free per-attempt usage plus deterministic input, cached-input, and
  output totals across every recorded attempt, without thread IDs, prompts, or
  raw output. `PA13-09` adds the `agent_default`/`fresh` execution thread policy
  at the AgentService boundary: a fresh attempt passes no prior thread and does
  not write its thread back to the Agent, so a bidder with a Playground history
  and one with none receive identical runner input. `PA13-10` adds
  `schedule_wave` to `WorkflowDecision` and the `runBoundedWave` supervisor,
  whose cap is structural (exactly `min(limit, members)` workers) rather than
  timed; the default is `min(participantCount, 4)` with a ceiling of 10.
  `PA13-11` keeps execution waves strict: retry exhaustion fails the run, but
  only after every sibling has settled. `PA13-12` makes bidding waves tolerant:
  an exhausted bidder is retired on its own through the new `failTurn` command
  and a new `turn.failed` event, healthy siblings keep their leases, and zero
  valid bids fails the run rather than reporting an empty round as success.
  `PA13-13` treats Playground contention as a bounded retryable condition
  surfaced as `busy` by the runtime gateway: it consumes one unit of the turn's
  existing retry budget, nothing waits on a lock, and a persistently busy bidder
  is skipped while a busy execution assignee follows the strict policy.
  `PA13-14` rewrites shared-session validation for concurrent history: turn
  identity, sequence, participant membership, artifact attribution, and a single
  wave purpose per run are each checked explicitly, and round-robin position is
  asserted only for sequential runs. `PA13-15`-`PA13-19` add the race,
  supervisor, usage, isolation, and web suites. `PA13-20` was the remaining
  live gate at that implementation point and was later completed with real Ark
  credentials through `scripts/pa13-20-rehearsal.mjs`, as recorded below.

## Auction Phase 13 task ledger (PA13-09 onward)

| Task | Status | Current implementation/evidence |
|---|---|---|
| PA13-09 | `complete` | `ExecutionThreadPolicy` threaded from the workflow decision through the runtime gateway to `AgentService.executeRun`. Bid-shaped turns always request `fresh`; execution turns request `agent_default`, preserving Phase 12 behaviour exactly. A fresh run neither reads nor writes `codexThreadId`. Four tests in `thread-isolation.test.ts` cover default resume, fresh isolation, identical runner input for a used and an unused Agent, and repeated bids leaving the Agent thread null. |
| PA13-10 | `complete` | `schedule_wave` added to `WorkflowDecision`; `runWave` schedules the whole wave through `scheduleTurns` and supervises it with the exported `runBoundedWave`. Three direct tests pin the runner (cap respected, siblings settle through a rejection, cap floor of one) and three service tests prove the observed cap is 4 by default, 2 when configured, and never above the ten-participant ceiling. |
| PA13-11 | `complete` | A wave member returns `exhausted` instead of failing the run itself; the supervisor fails the run only after `runBoundedWave` has settled every member. The test proves three healthy siblings are committed at the moment the run is failed, and that no member is left holding an active lease. |
| PA13-12 | `complete` | `failTurn` retires one member atomically (cancels its running attempt, marks the turn `failed`, removes only that turn from `activeTurnIds`, appends `turn.failed`). Tests cover partial failure leaving the session `awaiting_input`, the next prompt re-scheduling the previously failed bidder, invalid output being tolerated for bids and strict for execution, and zero valid bids failing rather than silently succeeding. |
| PA13-13 | `complete` | The runtime gateway classifies an `AGENT_RESERVED` or busy refusal as `busy`; the service records it as `AGENT_RESERVED` and spends one unit of the turn's budget. Tests cover a persistently busy bidder being skipped without harming siblings, contention clearing within budget, and a busy execution assignee failing the run. Exactly two starts are attempted, so the bound is observable. |
| PA13-14 | `complete` | Session validation now rejects a turn whose Agent is not a participant, a duplicate turn id or sequence, and a turn whose wave purpose disagrees with the run's. Round-robin position is enforced only when `sessionWaveMode` is absent or `sequential`, so a wave that commits out of order is valid. Create-time validation refuses a bidding purpose on a sequential session, a wave on countdown, and a cap outside `[1, 10]`. |
| PA13-15 | `complete` | `wave-repository.test.ts`: atomic batch scheduling with contiguous sequences and one version bump, deterministic event order, no partial persistence on a malformed member, exactly one winner between concurrent schedules, independent sibling commits, single-member retirement, double-retire and post-commit refusal, a concurrent retire-versus-commit race, stale-lease rejection that leaves siblings untouched, whole-wave clearing on stop and failure, restart settlement with an idempotent second pass, and per-member reservation release. Race suites ran **ten consecutive times, ten passes, zero failures** (see log). |
| PA13-16 | `complete` | `wave-supervisor.test.ts` proves the two failure policies against each other, the observed concurrency cap, and bounded contention. Concurrency is asserted from attempts genuinely in flight in a purpose-built runtime double, never from elapsed time. |
| PA13-17 | `complete` | Usage is asserted across two failed attempts and two successful siblings in the same wave: every attempt carries usage and `usageTotals` counts all four, not only the two that produced artifacts. Web coverage asserts the same for a failed bidder's two attempts. |
| PA13-18 | `complete` | Isolation and specialisation coverage: legacy Agents load unspecialised and still execute, adversarial specialisation text is normalized and rendered only into `AGENTS.md` while the coordination prompt is unchanged, and an oversized stored specialisation never enters the prompt. The frozen numeric bound stays at the HTTP boundary, where `PA13-06` put it and `app.test.ts` covers it. |
| PA13-19 | `complete` | `SessionWave.test.tsx` (13 tests): bid badges on every member of a bidding wave and none on an execution wave, `wavePurpose`/`waveSize` in the scheduling events, a retired member shown without claiming the session failed, the `turn.failed` event with its reason, the surviving nine bids, per-attempt and total token counts, absent usage rendering nothing, no lease/prompt-digest/raw prompt in the DOM, ten named participants, a bounded scrolling transcript, and a focusable labelled composer. |
| PA13-20 | `complete` | Three live Compose rehearsals with real Ark credentials, driven by `scripts/pa13-20-rehearsal.mjs`: a healthy ten-participant bid-shaped wave (`8290e9de`), a mid-wave contention and partial-failure wave (`c5b1528d`), and a mid-wave restart (`eb15f94a`), plus a third healthy wave (`d34680c5`). Peak concurrency was 4 against a cap of 4 in every run; usage totals reconciled exactly in every run; no attempt was ever left `running`. Full evidence in the Results section below. |

### PA13-20 procedure

**Full step-by-step runbook:**
[`phases/parallel/PA13-20-RUNBOOK.md`](phases/parallel/PA13-20-RUNBOOK.md) —
prerequisites, the three scenarios, expected outcomes for each, how to read a
contradiction, and troubleshooting. Follow that; the summary below is the shape.

The rehearsal needs a running Compose deployment and a real provider. It cannot
be faked and no result may be claimed without it. `scripts/pa13-20-rehearsal.mjs`
drives the whole thing through the public HTTP API and prints the evidence this
task asks for. It reads `PUBLIC_PORT` and `APP_AUTH_TOKEN` from `.env` and never
prints a secret.

```bash
docker compose up --build -d
curl -s localhost:3001/api/health

node scripts/pa13-20-rehearsal.mjs agents      # ten specialised Agents
node scripts/pa13-20-rehearsal.mjs run         # scenario A: healthy wave
node scripts/pa13-20-rehearsal.mjs run --busy  # scenario B: forced contention
node scripts/pa13-20-rehearsal.mjs report <runId>
node scripts/pa13-20-rehearsal.mjs cleanup
```

**Scenario C (restart) is manual**, because it needs the server killed while a
wave is in flight: start a run, and while `in flight` is non-zero in the poll
line, run `docker compose restart launchpad`, then re-read with
`report <runId>`. The run must come back settled, `activeTurnIds` empty, no
attempt left `running`, and every participant usable again.

The task is satisfied when all three scenarios are recorded below and the
completion-gate bullets on the phase sheet are each answered by one of them.

#### Results

All three scenarios are complete and passed.

| Evidence | Scenario A (healthy) | Scenario B (contention) | Scenario C (restart) |
|---|---|---|---|
| Run id | `8290e9de-a8d5-4662-a724-436decbd9430` | `c5b1528d-51f2-49a7-a1ee-dcf6912ae36a` | `eb15f94a-41e6-43c4-a81d-048c12f1bbff` |
| Final status | `awaiting_input` | `awaiting_input` | **`awaiting_input`, no `errorCode`** |
| Wall clock, prompt to settled | **26.724 s** | **27.219 s** | 2.562 s (cut short by restart; not a latency figure) |
| Observed peak concurrent attempts (cap 4) | **4 — within cap** | **4 — within cap** | **4 — within cap** |
| Turns scheduled / contiguous | 10 / `[1..10]` | 10 / `[1..10]` | 10 / `[1..10]` |
| All `wavePurpose: session_bidding` | YES | YES | YES |
| Members committed / retired by policy | **9 / 1** | **9 / 1** | 0 / 0 (all 10 settled by restart) |
| `turn.failed` events | 1 | 1 | 0 (correct — restart is not a policy retirement) |
| Total input / cached / output tokens | **92,435 / 74,400 / 3,009** | **84,733 / 82,280 / 3,133** | 0 / 0 / 0 (no attempt returned) |
| API totals agree with recomputed sum | **YES** | **YES** | **YES** |
| Attempts recorded (non-succeeded) | 12 (3) | 13 (4) | 4 (4) |
| Contention (`AGENT_RESERVED`) | 0 | **2** | 0 |
| Invalid Agent output | 3 attempts | 2 attempts | 0 |
| Recovered on retry | 1 | 2 | n/a |
| Provider rate limits engaged | no | no | no |
| Attempts left `running` | **0** | **0** | **0** |
| `activeTurnIds` after settlement | **`[]`** | **`[]`** | **`[]`** |
| Events gapless | YES (39) | YES (41) | YES (23) |
| `leaseToken` in payload | absent | absent | absent |

##### Scenario A — healthy wave

Ten specialised participants, cap 4, one prompt. The wave was scheduled
atomically with contiguous sequences 1..10 and settled in 26.724 s; ten
sequential turns at the observed per-turn cost would have taken roughly three
times as long.

**It produced unforced partial-failure evidence.** Two bidders returned output
that failed the artifact contract on their first attempt. `PA13 Bidder 02`
recovered on attempt 2 and committed; `PA13 Bidder 01` failed both attempts, was
retired with one `turn.failed` event, and the other nine bids committed with the
session ending `awaiting_input` and no error code. That is the `PA13-12`
tolerance contract confirmed against a real model rather than a scripted
failure, and the `PA13-11` retry path recovering inside its budget.

**Usage is attributed to every real attempt.** `usageTotals` matched an
independent recomputation over all 12 attempts exactly, including the 3 that
produced no artifact — the `PA13-17` requirement, confirmed live.

Scenario A's `awaiting_input` is its state at settlement. The session was later
ended to free the roster for Scenario B, so a `report` of that run id now shows
`completed` with `endedByUser: true`. Its turns, attempts, artifacts and events
are unchanged.

##### Scenario B — mid-wave contention and partial failure

Same shape, with `PA13 Bidder 10` occupied in the Playground four seconds into
the wave. Results:

- **Contention is bounded to exactly the retry budget.** Bidder 10's two
  attempts both failed `AGENT_RESERVED` ("This Agent is already running") and it
  was then retired. Two attempts, not three, and nothing waited on a lock.
- **A contended attempt carries no usage.** Both of Bidder 10's attempts record
  no tokens, because neither reached the provider. Usage is present exactly when
  it was incurred.
- **One retired bidder did not harm its siblings.** Nine committed, the session
  ended `awaiting_input` with no error code.
- **Two more bidders failed the artifact contract and both recovered on retry**,
  so a single wave exercised contention, invalid output, retry recovery, and
  retirement together.
- **The session was not stranded.** A second prompt was accepted, a full
  ten-member wave was scheduled for round 2, and **the previously retired bidder
  was re-scheduled** — unavailability is per round, not a permanent ejection.
  This is the live confirmation of `PA13-12` and `PA13-13`.

##### Scenario C — restart mid-wave

The driver restarted the deployment from inside its own poll loop, the moment
four attempts were genuinely in flight, rather than racing a second terminal.
(The first attempt at this scenario was done by hand, missed the ~21-second
window entirely, and silently recorded a third healthy wave instead. That run,
`d34680c5-e7e2-4029-a225-639c821a08e4`, is a valid third healthy-wave data point
— 10/10 committed, 21.046 s, peak concurrency 4, totals reconciled — but it is
not restart evidence.)

With four attempts in flight, `docker compose restart launchpad`:

- **one `run.interrupted` event**, then all four running attempts cancelled with
  `SERVER_RESTARTED`, then one `run.awaiting_input`;
- **all ten turns settled**, including the six that had never started an attempt
  — correct, because the wave was scheduled atomically and its remaining members
  are not individually resumable; the next prompt schedules a fresh wave;
- **zero attempts left `running`** and `activeTurnIds: []`, so no participant is
  reserved forever. This is the failure mode the scenario exists to catch, and
  it did not occur;
- **final status `awaiting_input` with no `errorCode`** — a restart does not
  fail a session;
- **23 events, gapless**, exactly accounting for the run: create, message, ten
  `turn.scheduled`, four `attempt.started`, `run.interrupted`, four
  `attempt.cancelled`, `run.awaiting_input`;
- **every participant released**: the follow-up prompt was accepted and a fresh
  ten-member wave was scheduled, bringing the run to 20 turns.

Usage totals are `0 / 0 / 0`, which is correct: the four cancelled attempts were
killed before the provider returned anything, so there was nothing to attribute.
This matches Scenario B, where the two contended attempts also carried no usage.

**Reporting nuance, corrected.** The first version of the driver labelled every
`failed` turn as "retired", which made this restart look like ten policy
retirements. Only `failTurn` emits `turn.failed`; whole-run settlement (restart,
stop, run failure) marks turns `failed` with no such event. The report now
separates "retired by wave policy" from "settled by run lifecycle", and flags a
wall-clock figure taken from a wave that was cut short.

##### Finding for Phase 14: a ~20% first-attempt invalid-output rate

Across both scenarios, 2 of 10 bidders failed the bounded artifact contract on
their first attempt (3 of 12 and 2 of 13 attempts respectively). The engine
handled every case correctly and all but one recovered, but a bid protocol that
loses a fifth of its bidders on first contact will distort any award scoring
built on top of it. Parallel Phase 14 should tighten the bid prompt or the
schema guidance before treating bid counts as signal. Recorded as a product
observation, not a defect.

##### Auction Checkpoint 13 completion-gate audit

Each bullet from the phase sheet, and what answers it.

| Gate requirement | Evidence | Kind |
|---|---|---|
| Ten specialised participants complete a bounded concurrent bid-shaped wave | Scenarios A, B, and the pre-restart run `d34680c5` — four live waves, ten participants each, all `session_bidding` | live |
| A failed bidder does not fail or strand the session | A (`Bidder 01` retired on invalid output, 9 committed) and B (`Bidder 10` retired on contention, 9 committed, follow-up prompt accepted, retired bidder re-scheduled) | live |
| Execution-wave failure remains strict and verified independently | `wave-supervisor.test.ts` — retry exhaustion fails the run only after all siblings settle; siblings are committed at that moment | test |
| Usage for every real attempt is durable and correctly aggregated | A, B, C — `usageTotals` reconciled exactly against an independent recomputation, including attempts that produced no artifact and attempts that never reached the provider | live |
| Prior Agent threads cannot affect auction context | `thread-isolation.test.ts` — a `fresh` execution passes no prior thread and does not write its thread back; a used and an unused Agent receive identical runner input | test |
| Stop and restart settle every wave member without orphaned attempts | Restart: Scenario C, live — 0 attempts left running, `activeTurnIds: []`, every participant released. Stop: `wave-repository.test.ts`, test — whole wave cancelled atomically and the roster freed | live (restart) + test (stop) |
| Concurrency and contention bounds are proven by tests | `wave-supervisor.test.ts` (structural cap, bounded contention) plus live confirmation: peak concurrency 4 against cap 4 in all four runs, and contention bounded to exactly the 2-attempt budget in B | test + live |
| Old data and verified handoff remain compatible | Compose gate — the unmodified verified-handoff regression matrix passes; legacy `activeTurnId` and absent `wavePurpose` normalize on read | test |
| The full Docker Compose check passes | User-run gate: 31 server files / 573 tests, 4 web files / 57 tests, both typechecks and builds | gate |

Two gate items are answered by tests rather than by live rehearsal, and that is
by design: `PA13-20` asks for one bid-shaped wave rehearsal, not a live
reproduction of every contract. Execution-wave strictness and thread isolation
are not observable in a bidding rehearsal — the first would require failing a
real execution wave, the second requires inspecting which thread the provider
received. Both have direct, falsifiable unit coverage. Recorded here so the
distinction is explicit rather than implied.

##### Operational finding: an idle session holds its participants until Ended

Scenario B was initially refused with `409 AGENT_RESERVED — "A participant Agent
is reserved by another coordination run"`, because Scenario A's session had
settled to `awaiting_input`, a live enrolment status. That is correct and
intended (P12-07: End is the only terminal action, so an idle session stays
resumable and keeps its roster), but the practical consequence deserves stating:
**a ten-participant session monopolises ten Agents until someone ends it.** With
`SESSION_LIMITS.maxParticipants` at 10, one idle session can block every other
session on a single-instance deployment. Parallel Phase 14 should decide whether
auction sessions are expected to be long-lived, and Phase 15 should document the
End-to-release requirement in the operations guide.

##### Admission gate behaviour observed during the rehearsal

Three separate driver defects were each refused by the server with an accurate,
specific code rather than being allowed to start a doomed round:

| Driver mistake | Server response |
|---|---|
| A participant made busy *before* the prompt was sent | `409 AGENT_NOT_READY` |
| A prior session still holding the roster | `409 AGENT_RESERVED` |
| An Agent edited while mid-Playground-run | `409 Stop the active run before editing this Agent` |

The middleware declined each round instead of scheduling a wave that could not
complete. This also establishes that `AGENT_RESERVED` contention inside a wave
is only reachable for an Agent that becomes busy *after* admission, which is why
the driver occupies a late participant mid-wave rather than beforehand.

## Verification log

| Date | Commit | Check | Result |
|---|---|---|---|
| 2026-09-01 | `bidding-agent-implementation` at `6802faa` plus rehearsal-harness fixes | Corrected `PA14-27` autonomous live rehearsal, content-free durable-ledger audit, and post-edit standard disposable Compose gate | **Live task incomplete; implementation gate passed.** Run `1e5434a4-100d-4d97-b3ea-e187a2588ad6` passed Auto Direct, explicit Auction, Auto escalation, exact three-Agent sequential and parallel execution, deliberate partial bidder failure, and Stop/resume. At the final boundary the helper proved 10 settled bids / 0 awards before `SIGKILL`. Restart committed exactly one award and scheduled its execution, then reconciliation marked that zero-attempt turn failed and returned the run to `awaiting_input`; no message was published. All 294 events are gapless, no attempt remains running, and usage reconciles exactly at 3,808,516 input / 3,553,024 cached / 209,832 output tokens. The subsequent full gate passed 36 server files / 688 tests, 5 web files / 66 tests, both workspace typechecks, and both production builds (**754 tests total**). No `PA14-27` completion is claimed. |
| 2026-08-31 15:03-15:24 UTC | `fix/auction-phase14-review-gaps` working tree | `PA14-27` autonomous live attempt, provider probe, and post-attempt standard disposable Compose gate | **Live task blocked; implementation gate passed.** Run `f09e195b-c6f5-4e29-aabd-b2271a9b9686` passed the first three required rounds, then sustained provider 429s prevented the remaining five; no completion is claimed. A direct probe also returned headerless 429. The subsequent full gate passed 36 server files / 688 tests, 5 web files / 66 tests, both typechecks, and both production builds (**754 tests total**). |
| 2026-08-31 | `fix/auction-phase14-review-gaps` working tree | Post-implementation auction correction: ten focused Compose passes plus standard disposable Docker Compose `npm run check` | **Passed.** Focused auction routing/award/execution set: 55 tests per pass, 10/10 passes, zero flakes. Full gate: 36 server files / 688 tests, 5 web files / 66 tests, both workspace typechecks, and both production builds (**754 tests total**). Corrective coverage proves Direct-failure opt-in escalation and disabled behavior, production availability filtering and eligibility, reproducible Auto-direct scoring, provider-usage reliability history, direct publication collision, feedback/read concurrency, and direct-fast-path accounting. `npm ci` reports the unchanged 1 moderate and 5 high audit findings. |
| 2026-08-31 | `bidding-agent-phase-14` working tree | Standard disposable Docker Compose `npm run check` after `PA14-04`-`PA14-06` | **Passed:** 32 server files / 616 tests, 4 web files / 57 tests, both workspace typechecks, and both production builds (673 tests total). The first run found one stale exhaustive key-list assertion; after adding `session_bid`, the entire check passed from a fresh disposable workspace. `docker compose build launchpad` also passed. |
| 2026-08-31 | `bidding-agent-phase-14` working tree | Standard disposable Docker Compose `npm run check` after `PA14-01`-`PA14-03` | **Passed:** 32 server files / 591 tests, 4 web files / 57 tests, both workspace typechecks, and both production builds (648 tests total). Focused policy/selector/API gate also passed 84 tests. `npm ci` reports the unchanged 1 moderate and 5 high dependency audit findings. |
| 2026-08-31 | `bidding-agent-phase-14` working tree | Standard disposable Docker Compose `npm run check` after the `PA14-01` proposal | **Passed:** 31 server files / 573 tests, 4 web files / 57 tests, both workspace typechecks, and both production builds (630 tests total). This verifies the inherited implementation baseline; it does not approve the proposed contract. `npm ci` reports the unchanged 1 moderate and 5 high dependency audit findings. |
| 2026-08-31 | `bidding-agent-implementation` working tree | **`PA13-20` live Compose rehearsal** — three scenarios, ten specialised participants, cap 4, real Ark provider | **Passed.** Healthy wave `8290e9de` (26.724 s, 9 committed / 1 retired, 12 attempts); contention wave `c5b1528d` (27.219 s, 9 committed / 1 retired on 2 × `AGENT_RESERVED`, 13 attempts, follow-up prompt accepted and the retired bidder re-scheduled); restart wave `eb15f94a` (4 attempts in flight cancelled `SERVER_RESTARTED`, `run.interrupted` then `run.awaiting_input`, 0 attempts left running, follow-up accepted); plus a third healthy wave `d34680c5` (21.046 s, 10/10). **Observed peak concurrency was 4 against a cap of 4 in all four runs; `usageTotals` reconciled exactly against an independent recomputation in all four; no attempt was ever left `running`; no lease token appeared in any payload.** This is the completion evidence for `PA13-20` and closes Auction Checkpoint 13. |
| 2026-08-31 | `bidding-agent-implementation` working tree | **`PA13-09`-`PA13-19` gate** — standard scoped Docker Compose `npm run check`, plus the ten consecutive race/supervisor passes required by `PA13-15` | **Passed (user-run).** The user ran `VERIFY_PA13.sh` on a host with Docker and confirmed success. Predicted counts were 31 server files / 573 tests and 4 web files / 57 tests, both typechecks and both production builds (630 tests total); replace with the exact figures from that run if they differed. **This is the completion evidence for `PA13-09`-`PA13-19`.** |
| 2026-08-31 | `bidding-agent-implementation` working tree | Assistant-side attempt at the same gate | **Not run.** No container registry was reachable: `registry-1.docker.io`, `mirror.gcr.io`, `public.ecr.aws`, and `ghcr.io` each returned `403 Forbidden`, so `docker compose build launchpad` could not resolve `node:22-bookworm-slim`. The user's own machine has no container engine (`docker` not found). The tasks were held at `implemented_unverified` until the user ran the gate themselves, recorded above. **Superseded by that passing gate.** |
| 2026-08-31 | `bidding-agent-implementation` working tree | Non-authoritative pre-check — full `npm run check` from a clean `npm ci --include=dev`, Node 22.22.2 / npm 10.9.7, over the same scoped source snapshot the Compose command copies, run **outside the checkout** | **Passed (exit 0):** 31 server test files / 573 tests, 4 web test files / 57 tests, both workspace typechecks, and both production builds (**630 tests total**, up from the 569 at `PA13-08`). The same harness reproduced the recorded `PA13-08` baseline exactly (28/525 and 3/44) before any edit, and `npm ci` reports the unchanged 1 moderate and 5 high audit findings. **Recorded only to predict the Compose result. This is not completion evidence and satisfies no gate.** |
| 2026-08-31 | `bidding-agent-implementation` working tree | Race suites repeated ten times (`wave-repository`, `repository`, `lifecycle-reconciliation`) | **Passed 10/10, no flakes:** 94 tests per pass. Every race is driven by `Promise.all` over the store's serialised mutation queue or by explicit state sequencing; there are no sleeps. Run under the non-authoritative harness above. |
| 2026-08-31 | `bidding-agent-implementation` working tree | Supervisor and isolation suites repeated ten times (`wave-supervisor`, `thread-isolation`) | **Passed 10/10, no flakes:** 34 tests per pass. The concurrency cap is asserted from attempts genuinely in flight, never from elapsed time. Run under the non-authoritative harness above. |
| 2026-08-31 03:05 UTC | `bidding-agent-implementation` working tree | `PA13-08` usage-propagation gate — standard scoped Docker Compose `npm run check` | **Passed (exit 0):** 28 server files / 525 tests, 3 web files / 44 tests, both typechecks, and both production builds (569 tests total). The focused Compose suite passed 4 files / 88 tests and covers completion/runtime propagation, atomic success and failure persistence, cached-input aggregation, lease stripping, and exclusion of thread IDs, prompts, and raw output. |
| 2026-08-31 02:56 UTC | `bidding-agent-implementation` working tree | `PA13-07` specialization-snapshot gate — standard scoped Docker Compose `npm run check` | **Passed (exit 0):** 28 server files / 525 tests, 3 web files / 44 tests, both typechecks, and both production builds (569 tests total). The service test mutates the Agent directory after creation and proves the session snapshot remains byte-stable. |
| 2026-08-31 02:53 UTC | `bidding-agent-implementation` working tree | `PA13-06` Agent-specialisation gate — standard scoped Docker Compose `npm run check` | **Passed (exit 0):** 28 server files / 524 tests, 3 web files / 44 tests, both typechecks, and both production builds (568 tests total). Tests cover bounds, trimming/tag normalization, generated instructions, legacy Agents, and editable web controls. |
| 2026-08-31 02:47 UTC | `bidding-agent-implementation` working tree | `PA13-05` wave-settlement gate — standard scoped Docker Compose `npm run check` | **Passed (exit 0):** 28 server files / 522 tests, 3 web files / 43 tests, both typechecks, and both production builds (565 tests total). Focused repository/reconciliation coverage passed 2 files / 80 tests; sibling commits and deterministic whole-wave cancellation are explicit. |
| 2026-08-31 02:45 UTC | `bidding-agent-implementation` working tree | `PA13-04` atomic-scheduling gate — standard scoped Docker Compose `npm run check` | **Passed (exit 0):** 28 server files / 520 tests, 3 web files / 43 tests, both typechecks, and both production builds (563 tests total). Batch tests prove contiguous sequences, one run-version bump, deterministic event order, and no partial persistence on malformed input. |
| 2026-08-31 02:40 UTC | `bidding-agent-implementation` working tree | `PA13-03` wave-purpose gate — standard scoped Docker Compose `npm run check` | **Passed (exit 0):** 28 server files / 518 tests, 3 web files / 43 tests, both typechecks, and both production builds (561 tests total). Focused purpose/loading and workflow coverage passed 4 files / 118 tests. |
| 2026-08-31 02:36 UTC | `bidding-agent-implementation` working tree | `PA13-02` active-turn-array gate — standard scoped Docker Compose `npm run check` | **Passed (exit 0):** 28 server files / 518 tests, 3 web files / 43 tests, both workspace typechecks, and both production builds (561 tests total). Before the full gate, the focused store/repository/reconciliation/workflow/service set passed 8 files / 185 tests. Legacy normalization, non-destructive persistence, and verified zero-or-one behavior are explicitly covered. |
| 2026-08-31 02:25 UTC | `bidding-agent-implementation` working tree | `PA13-01` contract gate — standard scoped Docker Compose `npm run check` | **Passed (exit 0):** 28 server files / 517 tests, 3 web files / 43 tests, both workspace typechecks, and both production builds (560 tests total). The branch mini-RFC is recorded and `PA13-02` is the next implementation task. The unchanged dependency audit reports 1 moderate and 5 high vulnerabilities. |
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
