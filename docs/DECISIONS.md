# Coordination Decisions

This is the release summary of the binding coordination decisions. Detailed
mini-RFC text and deviations live in
[development/ASSUMPTIONS_AND_DECISIONS.md](development/ASSUMPTIONS_AND_DECISIONS.md).

## ADR-01 through ADR-14

| # | Decision | Release status |
|---|---|---|
| ADR-01 | Three fixed Planner/Critic/Finaliser Agents | Superseded for Sessions by a snapshotted roster of 2–10 participants; retained for stored verified-handoff runs |
| ADR-02 | Sequential turns only | Superseded for Sessions by atomic bounded waves; verified handoff stays sequential |
| ADR-03 | Backend-owned pure routing state machine | Retained; model artifacts propose evidence, never schedule work |
| ADR-04 | Strict versioned JSON artifacts | Retained; `session_bid`, `session_award`, `session_message`, and `user_message` are bounded discriminated shapes |
| ADR-05 | Strip at most one outer JSON fence | Retained for legacy artifacts; auction bid parsing is JSON-only and rejects fences |
| ADR-06 | One bounded same-Agent retry | Retained and specialised by turn policy; bid attempts are 1–3 |
| ADR-07 | Critic rejection is a committed review | Retained for verified-handoff compatibility |
| ADR-08 | Two revisions after the first proposal | Retained for verified-handoff compatibility |
| ADR-09 | Opaque active lease gates every attempt commit | Retained; late results are harmless and the lease never enters public reads |
| ADR-10 | Additive v2 `JsonStore` migration | Retained at release with the measured 2,000-turn recommendation |
| ADR-11 | Poll detail every 1–2 seconds | Retained at 1.5 seconds; after first load the client requests deltas only |
| ADR-12 | Do not pretend to resurrect an interrupted provider call | Retained; recovery derives safe next actions from committed bids and awards |
| ADR-13 | Active Agent use is reserved | Retained for running attempts; idle Sessions release execution reservations and End releases membership |
| ADR-14 | Events carry bounded redacted metadata | Retained; user prompts are durable artifacts but never event detail |

## Session v2 amendments

- Sessions are durable, multi-prompt conversations with explicit
  `awaiting_input`, Stop, and End semantics.
- The product surface is Session-only. Stored verified-handoff and countdown
  history remains readable, but neither workflow is creatable from the current
  UI.
- A Session snapshots 2–10 participants. Waves are scheduled atomically and
  parallel execution is capped by `maxParallelTurns`.
- User prompts are first-class `user_message` artifacts and transcript order
  is an explicit sequence.
- The explicit type ceiling is 100,000 turns. The measured default and
  recommendation are 2,000 and the UI warns from 1,600.

## Auction-track Phase 13

The auction branch made parallel waves purpose-aware. `activeTurnIds` replaced
the single active pointer for Sessions; scheduling a wave is one atomic
repository mutation; each sibling settles independently. Bid-wave exhaustion
retires only the failed bidder, while awarded execution remains strict. Attempts
use fresh provider threads and provider usage is durable.

## Adaptive auction Phase 14

New auction-capable Sessions default to `auto`; absent auction policy remains
the legacy routing marker.

- **Direct** executes one deterministic primary Agent.
- **Auction** gathers private strict `session_bid` artifacts from eligible
  participants, filters structurally invalid or unavailable plans, ranks the
  rest with versioned integer-only `confidence_cost_v1`, and records one
  backend-authored immutable `session_award`.
- **Auto** uses one bid-capable primary call. A qualifying direct candidate is
  awarded and published atomically; otherwise the valid primary bid is reused
  and the remaining opportunity set fans out.

The award key is `(runId, userArtifactId)`; collisions and restart reload the
committed decision instead of re-scoring. Only the winning bid is reachable from
awarded execution context. Losing bids stay evidence-only. Fallback is bounded
to `default_agent | round_robin | fail`; winning execution failure never
promotes a runner-up. Actual bidding, projected execution, and actual execution
usage remain separate.

The implemented award uses `outcome` as the discriminator instead of a
redundant `selectionKind`, and feedback is an immutable audit event projection
instead of a mutable award field. Both recorded deviations preserve the
approved invariant.

## Phase 15 storage mini-RFC

**Decision: keep `JsonStore`; defer a repository-engine swap.**

The audit found quadratic growth in the *turn data model*: every turn stored the
entire prior transcript's artifact-id list. New turns now record one inclusive
`inputThroughSequence` bound plus only explicitly required round artifacts.
Legacy turns using id lists remain readable. Moving the old shape to SQLite or
JSONL first would have preserved the quadratic bytes.

Measured after the fix:

| Turns | Database | mutation p50 / p95 | details read | final prompt |
|---:|---:|---:|---:|---:|
| 100 | 0.42 MiB | 22.32 / 25.27 ms | 2.42 ms | 0.11 s |
| 500 | 2.05 MiB | 130.05 / 157.04 ms | 14.09 ms | 0.63 s |
| 2,000 | 8.21 MiB | 529.00 / 833.28 ms | 64.58 ms | 2.97 s |
| 10,000 | 41.15 MiB | 2,697.20 / 5,655.91 ms | 226.45 ms | 18.05 s |

The file shape is approximately linear, but every mutation still clones and
rewrites the whole document. Ten thousand turns are not an interactive product
default. A future engine swap remains behind `CoordinationRepository` and must
preserve atomic mutation, expected-version, lease, and race semantics.

## Deliberately open limitations

- The delta response is byte-efficient but still pays for a whole-store snapshot
  before filtering.
- The first detail read is unpaginated.
- Storage and orchestration are single-process.
- Deterministic scoring ranks declared evidence; it does not establish semantic
  quality.

## Related

- [Architecture](COORDINATION_ARCHITECTURE.md)
- [Protocol](COORDINATION_PROTOCOL.md)
- [API](COORDINATION_API.md)
- [Operations](COORDINATION_OPERATIONS.md)
