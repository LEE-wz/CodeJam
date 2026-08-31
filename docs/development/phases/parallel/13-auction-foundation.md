# Parallel Phase 13 — Auction Foundation and Purpose-Aware Waves

**Track:** Auction alternative. This sheet does not replace or amend
[`../13-parallel-waves.md`](../13-parallel-waves.md).  
**Goal:** build the concurrent execution foundation required for fair bidding,
including purpose-aware wave failure policies, Agent specialisation snapshots,
actual token-usage propagation, and isolated coordination threads.  
**Ends at:** Auction Checkpoint 13 — ten specialised participants can execute a
bounded bid-shaped wave concurrently, partial bidder failure does not fail the
session, actual usage is durably attributed to each attempt, and stop/restart
leaves no orphaned work.

## Entry criteria

- The auction implementation branch starts from the exact completed Checkpoint
  12 commit used as the base of the main Phase 13 branch.
- Checkpoints 10–12 are complete with their required evidence.
- The branch records a mini-RFC identifying this directory as its Phase 13/14
  execution authority and explaining the contract differences from the main
  coordinator-planning track.
- Lifecycle reconciliation and per-running-attempt reservation are stable. A bid
  wave deliberately touches every eligible participant, so any reservation leak
  is multiplied by the participant count.
- The Phase 10 ten-participant latency evidence is available to choose an
  initial bid concurrency cap.

If wave atomicity, purpose-specific failure behaviour, usage provenance, Agent
configuration migration, or thread isolation is unclear, stop and record the
decision on the auction branch before implementing it.

## Required outputs

- The main Phase 13 `activeTurnIds`, atomic `scheduleTurns`, and wave-supervisor
  capabilities, implemented independently on the auction branch.
- A durable wave purpose that distinguishes bidding from execution.
- Partial-success settlement for bidding waves without weakening execution
  failure semantics.
- Structured Agent specialisation with a per-session immutable snapshot.
- Actual runtime usage propagated into coordination attempt evidence.
- Fresh or session-scoped model threads for fair, isolated bids.
- Concurrency, contention, race, stop, and restart tests covering both wave
  purposes.

## Prior-phase compatibility changes

These are additive changes made in this parallel Phase 13. They do not require
rewriting the completed Phase 10–12 history.

### Agent configuration introduced before bidding

The existing Agent record has free-form `description` and `instructions`. Add an
optional structured field:

```ts
interface AgentSpecialization {
  perspective: string;       // bounded human-readable viewpoint
  focusAreas: string[];      // bounded normalized tags
  biddingInstructions: string;
}

interface Agent {
  // existing fields unchanged
  specialization?: AgentSpecialization;
}
```

Old Agent records load with no specialisation. The create/update API and Agent
settings UI gain bounded optional fields. The generated `AGENTS.md` may render
them, but auction prompts must not rely only on mutable workspace state.

When a session is created, snapshot the Agent's specialisation into its
participant entry. Subsequent Agent edits affect new sessions only. Every bid in
one session therefore sees the configuration the user selected at creation.
Snapshot fields are bounded and treated as instructions subordinate to the
fixed system and output contracts.

### Runtime usage propagation from the earlier execution boundary

`AgentRun` already stores provider usage, but `AgentExecutionHandle.completion`
does not return it and `CoordinationAttempt` does not retain it. Extend the
boundary additively:

```ts
interface AgentExecutionCompletion {
  status: "completed" | "failed" | "cancelled";
  output?: string;
  error?: string;
  usage?: RunUsage | null;
}

interface CoordinationAttempt {
  // existing fields unchanged
  usage?: RunUsage | null;
}
```

Copy usage from the completed Agent run into the attempt in the same mutation
that settles the attempt. Token counts are safe numeric evidence, but raw prompts
and outputs remain prohibited from events. Pre-auction attempts without usage
remain valid.

### Coordination thread isolation

The existing Agent-level Codex thread can contain unrelated Playground or
earlier-session context. That would make otherwise identical bids incomparable.
Add an execution thread policy at the AgentService boundary:

```ts
type ExecutionThreadPolicy = "agent_default" | "fresh";
```

All auction bids use `fresh`. Winning execution also defaults to `fresh` and
receives the awarded plan explicitly in its bounded prompt. This avoids adding a
new provider-thread collection and prevents one bidder receiving hidden context
that another bidder does not. A future implementation may add session-scoped
threads, but it must prove the same isolation and restart properties first.

### Phase 12 transcript and delta-read compatibility

No auction artifact is automatically chat-visible. Phase 14 explicitly
publishes only an accepted direct candidate or execution result into the
transcript. Delta reads must nevertheless carry bid/award evidence by their
ledger sequence so the evidence view can update without a full refetch.

`lastUserArtifactId` remains the durable auction-round key. No second mutable
"current auction" pointer is introduced; the workflow derives whether bidding,
award, or execution remains from committed artifacts for that user message.

## Tasks

### Contract and durable wave model

- [x] **PA13-01** Record the auction-track mini-RFC. State the common Checkpoint
  12 base, new Agent specialisation snapshot, attempt usage, thread policy,
  purpose-aware waves, forthcoming bid/award artifacts, migration behaviour,
  and verified-handoff non-regression requirement.
- [x] **PA13-02** Replace `CoordinationRun.activeTurnId` with
  `activeTurnIds: CoordinationTurnId[]` across types, persistence loading,
  repository methods, service, workflow validation, fixtures, and the web read
  model. An old `activeTurnId` loads as a single-element array. Verified handoff
  must retain zero-or-one active turn.
- [x] **PA13-03** Add `CoordinationWavePurpose = "session_execution" |
  "session_bidding"` to session turn scheduling metadata. Old and
  verified-handoff turns behave as `session_execution`; the field is optional on
  stored history and normalized on read.
- [x] **PA13-04** Implement atomic `scheduleTurns` with a single expected-version
  check, contiguous turn sequences, deterministic event order, and an all-or-
  nothing mutation. Keep `scheduleTurn` as the verified-compatible one-turn
  wrapper.
- [x] **PA13-05** Make attempt commit, failure, cancellation, and settlement
  remove only their own turn from `activeTurnIds`. Whole-run stop, failure, and
  restart settlement still clear every member of the active wave atomically.

### Agent specialisation, usage, and isolation

- [x] **PA13-06** Add the optional bounded `AgentSpecialization` type, API
  validation, create/update service support, generated instruction rendering,
  web settings controls, and old-record loading tests. Normalize `focusAreas`
  for matching while preserving the human-readable perspective.
- [x] **PA13-07** Snapshot specialisation into session participants at creation.
  Prove that later Agent edits do not alter an existing session's prompt digest
  or routing metadata.
- [x] **PA13-08** Propagate `RunUsage` through the execution completion boundary
  and persist it on `CoordinationAttempt`. Add API read fields and aggregate
  helpers for input, cached-input, and output tokens without exposing provider
  thread IDs, prompts, raw output, or leases.
- [x] **PA13-09** Add the execution thread policy. Bid-shaped test turns always
  invoke the runner with a fresh thread. Prove that an Agent with an existing
  Playground thread and another with no thread receive equivalent explicit
  coordination context.

### Purpose-aware supervisor

- [x] **PA13-10** Add `schedule_wave` to `WorkflowDecision` and implement the
  bounded wave supervisor with `Promise.allSettled`. Enforce
  `maxParallelTurns`, defaulting to `min(participantCount, 4)` with a ceiling of
  10, through a semaphore rather than timing assumptions.
- [x] **PA13-11** Define execution-wave settlement exactly as the main Phase 13
  contract: siblings settle independently, but retry exhaustion of an execution
  turn fails the run only after all siblings have settled.
- [x] **PA13-12** Define bidding-wave settlement differently: invalid output,
  timeout, busy exhaustion, or retry exhaustion marks that bidder unavailable
  for the round and does not fail healthy siblings. The workflow proceeds when
  the wave settles and Phase 14 decides whether enough valid bids exist. Zero
  valid bids is not silently successful; Phase 14 owns its bounded fallback.
- [x] **PA13-13** Treat Playground contention as a bounded retryable condition.
  A busy bidder may be skipped after its bid retry budget; a busy execution
  assignee follows the stricter execution failure policy. Never wait without a
  deadline.
- [x] **PA13-14** Rewrite shared-session validation for concurrent history and
  explicit wave purpose. Reject unknown participants, duplicate turn IDs or
  sequences, foreign artifacts, invalid Agent attribution, and mixed-purpose
  active waves for the same user-message round.

### Tests and evidence

- [x] **PA13-15** Add repository races for atomic scheduling, concurrent sibling
  commits, stale leases, concurrent commit/failure, stop, and restart. Run the
  race suite at least ten consecutive times through Docker Compose.
- [x] **PA13-16** Add supervisor tests proving the different failure policies:
  one failed bidder plus valid siblings leaves the session usable; one failed
  execution assignee fails only after siblings settle; the concurrency cap is
  never exceeded; and contention cannot wait forever.
- [x] **PA13-17** Add usage tests for completed, failed, cancelled, missing-usage,
  cached-input, and retry cases. The aggregate must count every actual attempt,
  not only accepted artifacts.
- [x] **PA13-18** Add specialisation and isolation tests covering old Agents,
  session snapshots, edits after session creation, malicious specialisation
  text, bounded prompts, and pre-existing Agent threads.
- [x] **PA13-19** Add web evidence coverage for a purpose-aware wave, per-attempt
  usage, partial bidder failure, and ten participant specialisations without
  exposing raw prompts or losing keyboard and narrow-screen behaviour.
- [x] **PA13-20** (runbook: [`PA13-20-RUNBOOK.md`](./PA13-20-RUNBOOK.md)) Rehearse one real ten-participant bid-shaped wave. Record total
  and per-attempt usage, concurrency, wall-clock time, partial-failure behaviour,
  and whether provider rate limits engaged. The output is test-shaped evidence;
  no award is made until Phase 14.

## Requirements and invariants

- A wave is scheduled atomically or not at all.
- Wave purpose is backend-owned and cannot be selected by model output.
- Bid failure tolerance never weakens execution failure handling.
- Agent specialisation is snapshotted per session and cannot override the output
  contract, policies, or trust boundary.
- Actual usage is attributed to the attempt that incurred it, including failed
  and retried attempts.
- Bids start from equivalent explicit context with no hidden prior thread.
- Per-running-attempt reservation remains the only auction reservation rule.
- Verified handoff retains its exact single-turn behaviour.

## Verification

Use the standard Docker Compose verification command from
[`../../README.md`](../../README.md). Focused tests may run first, but the full
`npm run check` gate is mandatory before Auction Checkpoint 13 is complete.

## Completion gate

Auction Phase 13 is complete only when:

- ten specialised participants complete a bounded concurrent bid-shaped wave;
- a failed bidder does not fail or strand the session;
- execution-wave failure remains strict and verified independently;
- usage for every real attempt is durable and correctly aggregated;
- prior Agent threads cannot affect auction context;
- stop and restart settle every wave member without orphaned attempts;
- concurrency and contention bounds are proven by tests;
- old data and verified handoff remain compatible;
- the full Docker Compose check passes.

## Handoff to parallel Phase 14

Record the auction-branch checkpoint commit, wave timings, actual token totals,
concurrency cap, partial-failure evidence, and isolation proof. Do not implement
award scoring while any purpose-aware wave race remains flaky.
