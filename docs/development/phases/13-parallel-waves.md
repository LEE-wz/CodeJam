# Phase 13 — Parallel Waves

**Goal:** let several Agents work at once inside one session. A wave of turns is scheduled atomically, executed concurrently under a bounded cap, and committed independently, with the same lease, version, stop, and evidence guarantees the sequential path already has.  
**Ends at:** Checkpoint 13 — a wave of six participants answers one prompt concurrently, one sibling failure does not corrupt the others, stop cancels the whole wave, and the verified-handoff pipeline is unchanged.

## Entry criteria

- A Phase 13 task branch has been created from the completed Checkpoint 12.
- The `overview-sessions.md` Section 2 amendment from `P10-01` is in place: parallel fan-out is no longer a non-goal.
- The Phase 13 paths in [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) have been reviewed.
- Checkpoint 11 reconciliation and Checkpoint 12 session lifecycle are complete and stable; both are load-bearing here.
- The Phase 10 ten-participant latency evidence is available — it is the input to the concurrency cap default.

If wave atomicity, lease scope, the stop contract during a wave, or the effect on `run.version` is unclear, stop and ask for clarification. Do not widen concurrency ahead of the tests that constrain it.

## Required outputs

- `run.activeTurnIds` replacing the single active-turn pointer, with every consumer migrated.
- An atomic batch schedule command.
- A wave supervisor in the service, with per-turn retry semantics unchanged.
- A bounded concurrency cap with busy-Agent handling.
- Race, stop, restart, and contention tests for concurrent turns.

## Tasks

### Durable model

- [x] **P13-01** Replace `CoordinationRun.activeTurnId?: CoordinationTurnId` with `activeTurnIds: CoordinationTurnId[]` and migrate all 34 references. The consumers are: `scheduleTurn` (currently refuses to schedule while the pointer is set), `beginAttempt`, `commitAcceptedArtifact`, `finishAttempt`, `settleActiveWork`, `finishStopped`, `interruptActiveRuns`, `SharedSessionWorkflowV1.validateSessionView` (which rejects any view with an active turn), `VerifiedHandoffWorkflowV1`, the fixtures under `coordination/testing/`, and the web read model. Loading an old record with `activeTurnId` maps it to a single-element array on read; no file migration is written and no field is dropped from stored history. A verified-handoff run always has zero or one entry, and a test asserts that invariant so the older workflow cannot accidentally fan out.
- [x] **P13-02** Add `scheduleTurns(input: { runId, expectedRunVersion, turns[], nextPhase, nextRevision })` to the repository, scheduling an entire wave inside one `JsonStore.mutate()`. The optimistic `expectedRunVersion` check is taken once for the whole wave, so siblings cannot invalidate each other; `nextTurnSequence` advances by the wave size; each turn gets `turn.scheduled`; and the result is the discriminated `scheduled` / `stale` / `not_found` shape the single-turn command already uses. Keep `scheduleTurn` as a thin wrapper over `scheduleTurns` with one turn so the verified path's tests and behaviour do not move.
- [x] **P13-03** Make per-turn settlement independent. `commitAcceptedArtifact` and `finishAttempt` remove only their own turn from `activeTurnIds`; a commit no longer implies the run has nothing in flight. `settleActiveWork` (used by `finishStopped`, `failRun`, and `interruptActiveRuns`) iterates every entry, cancelling each running attempt and failing or cancelling each turn, and then empties the array. Every one of these paths stays a single mutation, and per-run event sequences stay gapless with a deterministic ordering across siblings (recommend ordering by turn sequence within the mutation).

### Decision and orchestration

- [x] **P13-04** Extend `WorkflowDecision` with `{ kind: "schedule_wave"; turns: ScheduledTurnSpec[] }` where each spec carries the fields the current `schedule` decision carries per turn (`role`, `agentId`, `turnKind`, `phase`, `revision`, `inputArtifactIds`, `expectedArtifactType`). Keep `schedule` as the single-turn form so `VerifiedHandoffWorkflowV1` is untouched. `SharedSessionWorkflowV1` returns a wave whose membership is, in this phase, still deterministic: either the single next round-robin participant (default) or, when `policy.sessionParallel` is enabled, every participant that has not yet answered the current `lastUserArtifactId`. Content-aware wave membership arrives in Phase 14; this phase proves the machinery with a rule that needs no model output.
- [x] **P13-05** Rewrite `SharedSessionWorkflowV1.validateSessionView` for concurrent history. It currently asserts that committed turns form a strict round-robin sequence, that every turn is `committed`, and that no turn is active — all three are false during and after a parallel wave. The new validation must still be a pure function of committed state and must still reject genuinely corrupt history: unknown participants, duplicate turn ids or sequences, artifacts without a committed turn, artifacts belonging to another run, a session run holding verified artifacts, and turns whose `agentId` is not a participant. Round-robin position becomes "participants who have not yet answered the current user message", derived from committed artifacts, so a retry still never advances it.
- [x] **P13-06** Implement the wave supervisor in `CoordinationService`. Replace the single `await executeTurnWithRetries(...)` with: schedule the wave atomically, start one execution pipeline per turn, await all of them with `Promise.allSettled`, then reload and re-decide. Per-turn retry, validation, lease handling, and `finishAttempt` semantics are unchanged — each pipeline is today's code with its own turn and attempt. A sibling's failure must not abort its siblings: collect outcomes, then decide once. Exhausting `maxAttemptsPerTurn` on any turn still fails the run with `MAX_ATTEMPTS_EXCEEDED`, but only after every sibling has settled, so no attempt is orphaned mid-flight.
- [x] **P13-07** Add `policy.maxParallelTurns` (default `min(participantCount, 4)`, ceiling 10, validated in the routes and the service) and enforce it with a semaphore inside the supervisor. Each parallel turn is a live Codex process against a real model, so this is a resource control, not a formality; its default must be justified by the Phase 10 timing evidence. A wave larger than the cap executes in bounded batches within the same wave, and the run stays `running` between batches.
- [x] **P13-08** Handle Agent contention. `AgentService.startExecution` already rejects a `busy` Agent with `409`, and a session participant can be busy from a Playground turn if reservations were narrowed in `P11-05`. The supervisor must treat that as a retryable condition for that turn — bounded backoff and re-attempt within `maxAttemptsPerTurn`, with an `attempt.failed` event carrying a safe reason — rather than failing the entire wave.

### Tests

- [x] **P13-09** Add repository race tests for waves, using deferred promises: two siblings committing concurrently both succeed and each clears only its own entry; a sibling committing after the run stopped is `stale`; a stale lease from a superseded attempt is refused while a sibling proceeds; concurrent `finishAttempt` and `commitAcceptedArtifact` on different turns are both applied; `scheduleTurns` is atomic under a competing version bump — all or nothing, never a partial wave.
- [x] **P13-10** Add supervisor tests: a wave where one turn times out and one commits; a wave where one turn exhausts retries; stop mid-wave cancels every running attempt and settles every turn; a restart mid-wave settles the whole wave with `SERVER_RESTARTED`; a wave larger than `maxParallelTurns` runs in batches and never exceeds the cap concurrently (assert on the scripted runtime's observed concurrency, not on timing).
- [x] **P13-11** Add workflow tests for the rewritten validation: parallel committed history is accepted; interleaved sequences are accepted; corrupt histories from `P13-05` are each rejected with `INVALID_STATE`; a verified-handoff run still routes exactly as before, proven by the unmodified Phase 1–4 workflow matrix.
- [x] **P13-12** Add web coverage: a transcript that receives several messages from one wave renders them in `transcriptSequence` order with per-Agent attribution; the working indicator reflects a wave rather than a single turn; stop during a wave settles the whole wave in the UI without a stuck spinner.

## Requirements and invariants

- A wave is scheduled atomically or not at all. There is no partially scheduled wave in durable state.
- One lease still governs exactly one attempt. Concurrency changes how many leases are live, never their scope.
- Stop remains a single durable transition followed by best-effort cancellation of every live attempt; a cancellation failure never strands the run (Phase 11 reconciliation is the backstop).
- Per-run event sequences stay gapless and deterministically ordered across siblings.
- An Agent is never in two concurrent turns of the same wave; participant distinctness plus the `busy` check both enforce it, and a test proves it.
- Verified-handoff behaviour is bit-for-bit unchanged: same decisions, same events, same phases.
- The concurrency cap is enforced in the supervisor, not by hoping the model is slow.

## Verification

```bash
docker compose build launchpad
docker compose run --rm --no-deps --user root \
  -v "$PWD:/source:ro" -v /workspace \
  -w /workspace \
  launchpad sh -lc "tar -C /source \
    --exclude='apps/*/node_modules' --exclude='apps/*/dist' \
    -cf - package.json package-lock.json tsconfig.base.json apps \
    | tar --no-same-owner -C /workspace -xf - \
    && npm ci --include=dev && npm run check"
```

Run the wave race suite at least ten consecutive times through Docker Compose before declaring it stable, then require the full check. In the Compose browser deployment, run one real six-participant parallel wave and one real ten-participant wave with the cap engaged; record wall-clock time against the Phase 10 sequential baseline, peak memory, and any provider rate-limit responses.

## Completion gate

Phase 13 is complete only when:

- a wave of six real participants answers one prompt concurrently with correct, attributed evidence;
- a single sibling failure, timeout, or retry exhaustion leaves the other siblings and the ledger coherent;
- stop and restart settle an entire wave with no orphaned attempt and no reserved Agent;
- concurrency never exceeds `maxParallelTurns`, proven by test;
- the rewritten workflow validation accepts parallel history and still rejects corrupt history;
- the verified-handoff regression matrix passes unchanged;
- the measured speed-up against the Phase 10 baseline is recorded honestly, including the case where it is small;
- the final Docker Compose `npm run check` passes on the task branch.

## Handoff to Phase 14

Record the wave timings, the chosen cap, and the contention behaviour in `STATUS.md`, then set `P14-01` as the next action. Phase 14 decides *which* Agents are in a wave and in what order; it depends on the wave machinery being correct, so do not begin it while any wave race test is flaky.
