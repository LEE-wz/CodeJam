# Session Demo

This script demonstrates one durable, adaptive-auction Session. Every routing,
validation, award, retry, and transcript decision is middleware-owned.

## Setup

1. Complete the Docker Compose setup and `.env` bootstrap in the root
   [README](../README.md#docker-compose). Then start the release
   stack and confirm health:

   ```bash
   docker compose up --build -d launchpad
   curl -fsS http://localhost:3001/api/health
   ```

2. Create 4–6 Agents from [AGENT_TEMPLATES.md](AGENT_TEMPLATES.md). Ten Agents
   are supported, but a smaller room fits the three-minute narration and uses
   less provider capacity.
3. Wait until every participant is `ready`.
4. Create a free-chat Session with routing mode **Auto**. For the three-minute
   talk track, open the portable [Phase 15 recording report](recordings/PA14-27.md)
   in a second tab. On the prepared release host, the same evidence is retained
   as the completed Session named **[RECORDING] Phase 15 adaptive-auction
   fallback**.

Suggested objective:

> Design the trust and safety model for a peer-to-peer marketplace.

## Three-minute recorded narration

The complete provider-backed ordered and parallel rounds took 325.2 and 291.3
seconds respectively, so they cannot honestly fit in a three-minute live demo.
Use the labelled recording/report for the ordered, parallel, restart, and
rejection beats below. Keep a small live Session open to demonstrate creation,
follow-up, Stop, resume, and End when provider latency permits. Never present a
recording as live.

### 1. Create and start (~20 seconds)

Choose the participants, leave routing on **Auto**, and start the small live
Session.

Say: “The Agents do not share memory. The durable transcript, participant
snapshot, limits, and evidence ledger belong to the middleware.”

Expected state: `created`, then `awaiting_input` after Start.

### 2. Ordered team evidence (~35 seconds)

Show the labelled ordered segment. Its prompt was:

> In a strict sequence, identify launch risks, challenge them, then give the
> final priority order.

Say: “Bids are private evidence. The backend validates every embedded plan,
scores valid bids deterministically, commits one immutable award, and schedules
the winning plan. A sequential award runs positions in order.”

Recorded evidence: a bid wave, one `session_award`, then three sequential
awarded execution messages in plan position order. Only final
`session_message` artifacts entered the transcript. A fresh live auction may
choose a different valid plan; the UI never promises that a model-proposed plan
will be sequential.

### 3. Fan-out evidence (~30 seconds)

Show the labelled parallel segment. Its prompt was:

> Work in parallel: each specialist name one thing to cut from v1.

Recorded evidence: one bounded bid wave, one award, and several execution turns
in flight, never above `maxParallelTurns`.
Transcript order is `transcriptSequence`, not completion time.

### 4. Follow up in the same Session (~20 seconds plus provider latency)

Return to **Auto** and send:

> Given the evidence so far, what should ship first?

Say: “This is the same Session and the same durable transcript. Auto can publish
a high-confidence primary candidate in one call or expand that call into an
auction without discarding its valid bid.”

Expected live state: `awaiting_input` after the response. If provider latency
would overrun the talk track, show the recorded multi-prompt transcript and let
the live request continue visibly in the background.

### 5. Stop, resume, and End (~30 seconds plus provider latency)

Send another Auction prompt and press **Stop** while bids or execution are in
flight. After it settles, send a new prompt, then press **End**.

Say: “Stop cancels the current work and fences late completions but leaves the
Session usable. End is the deliberate terminal action and releases the roster.”

Expected: no running attempt or active turn after Stop; a later prompt succeeds;
End produces `completed` and later messages are rejected.

### 6. Evidence and security (~20 seconds)

Open the timeline and bid evidence.

Say: “Events contain bounded identifiers, enums, counts, and score components.
User prompts live only in user-message artifacts and the transcript. Events do
not contain prompt content, raw model output, authorization data, provider
threads, or lease capabilities.”

## Genuine failure and recovery evidence

The approved run contains genuine middleware-caught failures; do not fake or
force a model response for a short demo:

- **Invalid bid recovery:** the recording contains 22 genuine
  `attempt.invalid_output` bid attempts. Multiple bidders then committed on a
  same-turn retry; exhausted bidders retired without invalidating healthy bids.
- **Contention and restart recovery:** the rehearsal deliberately occupies a
  late bidder, exercises Stop/resume, and restarts after all ten bids settle but
  before an award. Recovery preserved the bids, committed exactly one award,
  scheduled no duplicate work, and left no attempt running.

To reproduce both paths with real configured Agents, run the long-form driver
after completing Setup. It creates its own ten-Agent rehearsal roster and can
take well over ten minutes depending on the provider:

```bash
node scripts/pa14-27-rehearsal.mjs run
```

Malformed output is genuine model behaviour and therefore not guaranteed on
every fresh run. The middleware outcomes for too few valid bids and winning
execution exhaustion are deterministic and covered by the release test gate;
they are operational failure modes, not claims about what every live demo will
produce.

## Recorded fallbacks

Always label these **Recording** on screen. The durable source run is
`40f52425-ea3d-4a9c-917e-b05e08c27128` (`PA14-27 PASS`):

| Recording | Segment | Real elapsed time | Evidence |
|---|---|---:|---|
| Ordered Session | awarded sequential | 325.2 s | three execution messages committed in plan position order |
| Parallel Session | awarded parallel | 291.3 s | three execution turns ran as a bounded fan-out |
| Multi-prompt restart | all nine prompts, including restart boundary | 4.3–325.2 s per round | one long-lived Session retained its transcript; ten settled bids survived post-bid/pre-award restart and produced exactly one award |
| Bid/plan-rejection recovery | invalid bid attempts across the run | n/a | 22 genuine `attempt.invalid_output` bid attempts; multiple same-turn retries later committed and healthy bids remained eligible |
| Partial bidder contention | occupied late bidder | 42.7 s | the bounded wave settled without leaving an attempt running |

The content-free portable report is committed at
[recordings/PA14-27.md](recordings/PA14-27.md). On a prepared host that retains
the labelled runtime recording, regenerate the API-backed report with:

```bash
node scripts/pa14-27-rehearsal.mjs report \
  40f52425-ea3d-4a9c-917e-b05e08c27128
```

The portable and API-backed reports deliberately omit prompts, raw output,
credentials, provider thread IDs, and lease tokens. A clean checkout does not
contain runtime data; the committed report is its fallback, and the `run`
command above is the regeneration path.

## Latency and deterministic fallback

The three-minute path always uses the labelled recording for provider-backed
auction rounds. A long-form live rehearsal can remain on screen while the
recorded evidence is narrated. Provider latency is not a middleware correctness
signal.

If the auction cannot gather `minimumValidBids`, the default `round_robin`
fallback selects one available participant deterministically. This is an
auction fallback policy, not the removed coordinator-planning mode.

## Reset between rehearsals

End the Session and create a new one. For a completely disposable environment,
set `APP_DATA_DIR` and workspace roots to fresh temporary directories rather
than deleting an existing operator data directory.

## Honest limitations

- Single process and single user; no tenancy or horizontal storage semantics.
- Idle Sessions survive restart. In-flight work is fenced and reconciled from
  durable evidence; an external provider process is never pretended to resume.
- The default and recommendation are 2,000 committed turns, with a UI warning
  from 1,600. The explicit 100,000 ceiling is not a performance claim; the
  measured 10,000-turn prompt took 18.05 seconds.
- The middleware guarantees structure, determinism, and bounded recovery—not
  semantic quality.

## Related

- [Agent templates](AGENT_TEMPLATES.md)
- [Architecture](COORDINATION_ARCHITECTURE.md)
- [Protocol](COORDINATION_PROTOCOL.md)
- [Operations](COORDINATION_OPERATIONS.md)
- [Portable Phase 15 recording report](recordings/PA14-27.md)
