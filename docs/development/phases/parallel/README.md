# Parallel Phase Alternative — Auction Agent System

**Status:** Proposed alternative implementation track. No auction code has been
implemented, and this directory does not change the active Phase 13 or Phase 14
plan.

This directory contains a parallel design for the Session v2 coordination
engine. The existing implementation sheets remain the main track:

- [`../13-parallel-waves.md`](../13-parallel-waves.md)
- [`../14-coordinator-planning.md`](../14-coordinator-planning.md)

The alternative track is:

- [`13-auction-foundation.md`](13-auction-foundation.md) — concurrent wave
  mechanics plus the runtime, Agent-specialisation, usage, and isolation changes
  required by bidding.
- [`14-adaptive-auction-coordination.md`](14-adaptive-auction-coordination.md) —
  direct, auction, and automatic routing; bid collection; deterministic award;
  and single-Agent or team execution.

Nothing in this directory amends `overview-sessions.md`,
`ASSUMPTIONS_AND_DECISIONS.md`, `STATUS.md`, or the main phase sheets. If the
alternative is implemented, its branch must record its own mini-RFC before code
changes begin. Until then, the existing Session v2 mini-RFC and main phase
sheets remain authoritative.

## Intended branch relationship

Both implementations should start from the same completed Checkpoint 12 commit:

```text
Checkpoint 12
  ├─ main Phase 13 → main Phase 14
  └─ auction Phase 13 → auction Phase 14
```

Suggested branch names are `auction-phase-13-foundation` followed by
`auction-phase-14-coordination`. These are suggestions only; the branch names
and integration strategy should be chosen when implementation begins.

Do not merge the main and auction Phase 13/14 state-machine changes into one
working branch merely to compare them. They deliberately make different
workflow and artifact choices. Keep both histories available until their
implementations have been exercised against the same manual comparison suite.

## Shared prerequisites

The auction alternative assumes Phases 10–12 are complete, including:

- ten-participant sessions and the 100,000-turn contract ceiling;
- per-running-attempt Agent reservations and lifecycle reconciliation;
- durable `awaiting_input` sessions;
- `user_message`, `lastUserArtifactId`, and deterministic transcript sequence;
- append-and-resume, stop-versus-end, delta reads, and the chat surface.

The alternative does not reimplement those phases. Where their types or
execution boundaries need additive changes, the work is explicitly listed in
the parallel Phase 13 sheet.

## Product difference

The main track asks one coordinator Agent to author a plan and then executes
that plan. The alternative chooses among specialised Agents:

```text
direct
  User prompt → selected Agent → response

auction
  User prompt → bid wave → deterministic award → winning execution

auto
  User prompt → one primary candidate
              → accept its response, or expand to a bid wave
              → deterministic award → winning execution
```

An awarded plan may select only the winner or may propose validated sequential
or parallel team execution. This keeps multi-Agent collaboration available
instead of reducing every auction to winner-takes-all routing.

## Manual comparison, not automatic promotion

Completion of either branch does not automatically make it the preferred
implementation. Once both are complete, run the same synthetic prompt suite,
runtime configuration, participant specialisations, concurrency cap, timeout,
and repetition count against each branch. Suggested evidence is:

- implementation completeness against each branch's own phase gates;
- correctness and usefulness of final responses under blinded human review;
- total input, cached-input, and output tokens, separating selection overhead
  from execution;
- wall-clock latency, including p50 and p95 across repeated runs;
- invalid-output, retry, timeout, fallback, stop, and restart behaviour;
- deterministic recovery with no duplicate plan, award, or execution;
- code complexity, test coverage, migration burden, and operational clarity;
- performance on simple prompts, ambiguous prompts, specialist prompts,
  ordered coordination, parallel fan-out, and multi-prompt follow-ups.

Treat these as comparison suggestions, not a formula that selects a branch.
The final choice should be made manually after reviewing implementation
completeness, behavioural accuracy, recorded evidence, and product fit.

## Non-negotiable invariants

Both tracks must preserve the shared engine guarantees:

- the backend owns scheduling, leases, limits, cancellation, and settlement;
- model output never changes policy, participants, budgets, or another run;
- all state transitions are atomic and version-checked;
- one lease authorises exactly one attempt;
- retries and restarts cannot duplicate durable work;
- terminal runs remain immutable;
- stored pre-auction runs remain readable;
- events never contain prompts, raw output, credentials, or lease tokens;
- verified-handoff behaviour remains unchanged.

