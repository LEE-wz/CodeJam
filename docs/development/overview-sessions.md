# Shipped Session Contract

This document is the final contract authority for the
`shared_session_v1` workflow on the adaptive-auction branch. It supersedes the
historical phase annotations and coordinator-planning proposal.

## Product contract

A Session is one durable, free-chat conversation shared by 2–10 pre-created
Agents. It accepts multiple user prompts, preserves one ordered transcript, and
stays non-terminal in `awaiting_input` until the user explicitly ends it or an
unrecoverable failure occurs.

The browser creates only Sessions. Stored verified-handoff and countdown runs
remain readable for compatibility but are not creatable from the current UI.

## Trust boundary

Models may propose:

- a strict `session_message`;
- a strict private `session_bid` containing a candidate, metrics, and a bounded
  single, sequential, or parallel plan.

Models may not choose limits, mutate the participant roster, schedule turns,
award themselves, author events, commit without a live lease, or end a Session.
The backend owns validation, eligibility, deterministic scoring, award
creation, fallback, scheduling, retry, cancellation, transcript sequencing,
reservations, and terminal state.

`session_award` is system-authored and immutable. The unique logical key is
`(runId, userArtifactId)`, so a competing loop or restart observes one durable
decision rather than creating another.

## Lifecycle

```text
created -> running -> awaiting_input -> running -> ...
    |         |             |             |
    |         +-> stopped   +-> completed +-> failed
    +------------> stopped
```

- **Start** moves a created Session to `awaiting_input`.
- **Send** is accepted only from an idle `created` or `awaiting_input`
  Session. It commits one `user_message`, selects the round route, and starts
  work.
- **Stop** settles all active work, fences late completions, and returns a
  long-lived Session to `awaiting_input`. It is not End.
- **End** is accepted only while idle and commits terminal `completed`.
- An idle Session survives restart. In-flight work is reconciled from durable
  bids and awards; an external provider process is never assumed to resume.
- A loop exit with no terminal repository action is reconciled or fails with
  `RUN_ABANDONED`; it cannot leave Agents permanently reserved.

## Transcript and artifacts

`user_message` and accepted `session_message` artifacts carry a monotonically
increasing `transcriptSequence`. Their union is the public transcript. Private
bids and system awards never appear as chat messages.

Session turns use `inputThroughSequence` to pin the inclusive transcript bound
visible when the turn was scheduled. Explicit round artifacts—such as the
current user message or committed award—remain named inputs. This makes context
stable across retry and restart without copying the entire prior artifact-id
list into every new turn. Legacy turns with `inputArtifactIds` remain valid.

The context builder:

1. reads only the pinned transcript prefix and explicit inputs;
2. renders the current user's message and Agent-attributed prior messages;
3. adds only the current bidder's snapshotted specialisation;
4. for execution, adds only the winning bid and the Agent's awarded assignment;
5. drops the oldest transcript entries first to fit the 40,000-character
   context budget;
6. never includes events, losing bids, lease tokens, authorization data, raw
   rejected output, provider thread ids, or private Agent history.

## Routing

New auction-capable Sessions store a `SessionAuctionPolicy` and default to
`auto`. A message may narrow the round to `direct` or `auction`, optionally
select one participant, express `single | team | any`, or mark risk `high`.
High risk forces Auction. Per-message input cannot widen any budget, participant,
attempt, or concurrency limit.

### Direct

The backend selects one ready primary deterministically: explicit selection,
sticky prior winner, specialisation match, default Agent, then participant
order. One ordinary execution turn runs. Failure expands to Auction only when
`auctionOnDirectFailure` is explicitly enabled.

### Auction

One fresh-thread bid turn is scheduled for each eligible participant. Bids are
strict JSON, bounded, private, and validated before ranking. Invalid bidders may
retry on the same turn within `maxBidAttempts`; exhaustion retires that bidder,
not healthy siblings.

After the bounded opportunity set settles, the backend applies
`confidence_cost_v1` with integer basis-point arithmetic and stable ties.
“Winner” means the highest-ranked eligible declared bid, not objectively best.
The award either publishes a qualifying candidate atomically or schedules its
single, sequential, or parallel plan.

Sequential assignments run by contiguous position and each later Agent sees
earlier committed messages. Parallel assignments are scheduled in one atomic
wave and run under `maxParallelTurns`. A failed winning execution fails the
round; no runner-up is silently promoted.

### Auto

Auto begins with one bid-capable primary call. If the direct recommendation,
candidate, confidence, output estimate, policy, and availability gates pass,
the backend scores, awards, and publishes that candidate atomically. Otherwise,
any valid primary bid is reused and only the remaining eligible participants
are scheduled.

### Fallback

Fewer than `minimumValidBids` applies exactly one configured fallback:
`default_agent`, deterministic `round_robin`, or `fail`. Fallback is durable
evidence and never fabricates an answer.

## Atomic waves, retries, and reservations

- A wave is scheduled in one expected-version mutation with contiguous event
  sequences. Partial scheduling is impossible.
- Each turn has at most one live attempt lease. Invalid output retries the same
  turn and Agent within the applicable attempt budget.
- Sibling execution failure settles the wave before strict run failure. Bid
  failure retires only that bidder.
- Stop and restart settle every scheduled member, including members not yet
  admitted to provider execution.
- Reservations are derived from live work. Idle Session membership is visible
  but does not monopolise execution; End releases the roster deliberately.

## Read model and polling

`GET /api/coordination-runs/:id` returns the full detail projection. Supplying
`sinceSequence` returns only records after the durable ledger cursor plus the
current run projection. The browser performs one full read, then polls deltas
every 1.5 seconds and merges them by stable ids and sequence.

Public attempts omit `leaseToken`. Usage is split into actual bidding, actual
execution, and projected execution. Provider usage is evidence; it is never
presented as currency.

## Limits

| Limit | Shipped value |
|---|---:|
| Participants | 2–10 |
| Default and recommended turns | 2,000 |
| UI warning | 1,600 committed turns |
| Explicit hard ceiling | 100,000 |
| User message | 1–4,000 characters |
| Session message | 1–500 characters |
| Parallel work | 1–10; default 4 |
| Context | 40,000 characters |
| Direct output budget | 1–4,000 tokens |
| Bid output budget | 128–4,096 tokens |
| Bid attempts | 1–3 |
| Awarded execution budget | 128–16,000 tokens |

The hard turn ceiling is a safety/type bound, not a performance promise. The
measured final prompt took 2.97 seconds at 2,000 turns and 18.05 seconds at
10,000 turns on the Phase 15 host. `JsonStore` is single-process and rewrites
the full document on each mutation.

## Evidence and redaction

Events carry allowlisted identifiers, states, bounded reasons, counts, digests,
score components, and usage. They carry no prompt content, objective,
candidate answer, raw model output, authorization header, cookie, provider
thread id, lease token, or stack trace.

User-authored content is intentionally durable only in `user_message`
artifacts and authorized detail/transcript responses. Agent content is durable
only in accepted artifacts. Invalid raw output is represented by digest,
bounded size, and validation reason.

## Acceptance criteria

The shipped contract is accepted when all of these are evidenced:

1. 2–10 specialised participants can hold one multi-prompt durable Session.
2. Direct, explicit Auction, Auto-direct, and Auto-escalation routes are
   deterministic and visible.
3. Private bids, strict plan validation, stable scoring, and exactly one
   immutable award are enforced.
4. Awarded single, sequential, and parallel plans execute with correct context
   and bounded concurrency.
5. Invalid/missing bidders, fallback, winning-execution failure, contention,
   Stop, End, and restart settle without orphaned work or silent promotion.
6. Idle restart preserves the conversation; post-bid/pre-award restart creates
   no duplicate bid, award, execution, or message.
7. Full then delta reads reconstruct the same ledger; public reads omit internal
   capabilities and losing bids stay outside the transcript.
8. Provider usage and projected usage are durable, separate, and reconcilable.
9. The measured scale ceiling, single-process constraint, and security limits
   are documented and verified through the clean Compose release gate.

The request-by-request evidence ledger is maintained in
[STATUS.md](STATUS.md).
