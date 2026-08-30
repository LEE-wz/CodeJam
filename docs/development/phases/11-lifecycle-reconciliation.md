# Phase 11 — Lifecycle Reconciliation and Agent Recovery

**Goal:** make it impossible for a session to strand its Agents. Every orchestration exit must leave the run in a state that is terminal, resumable, or explicitly owned by a live loop, and a user must be able to recover an Agent without restarting the server.  
**Ends at:** Checkpoint 11 — every stale-path exit is proven by test to settle or resume the run, and no sequence of stop, failure, restart, or race leaves an Agent unusable.

## Entry criteria

- A Phase 11 task branch has been created from the completed Checkpoint 10.
- The reservation decision (open question 1 in [`../plans/session-v2-plan.md`](../plans/session-v2-plan.md)) is recorded in [`../ASSUMPTIONS_AND_DECISIONS.md`](../ASSUMPTIONS_AND_DECISIONS.md). `P11-05` cannot start without it.
- The Phase 11 paths in [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) have been reviewed.
- The deterministic test kit (`coordination/testing/controls.ts`, `fakes.ts`, `memory-repository.ts`) is understood; this phase uses deferred promises, never sleeps.

If a stale-path classification, an error-code choice, the reservation rule, or the recovery affordance is unclear, stop and ask for clarification. Do not guess which non-terminal exits are safe.

## Required outputs

- A complete classification of every `CoordinationService` exit that leaves a run non-terminal.
- Loop-exit reconciliation and a boot-time plus periodic reconciler.
- A narrowed reservation rule matching the recorded decision.
- Agent-level recovery in the UI, with the reserving session named.
- Regression tests that fail on the pre-fix code for each stale path.

## Tasks

### Diagnosis and classification

- [x] **P11-01** Enumerate, in the task evidence, every path in `coordination/service.ts` that ends `runLoop` or `executeTurnWithRetries` without a terminal repository call, and state for each whether the correct response is *resume*, *fail*, or *already owned by another actor*. The known set is: `beginAttempt` returning `stale`/`not_found`; the reloaded turn no longer being `scheduled`; `attachAgentRun` returning `stale`; `commitAcceptedArtifact` returning anything but `committed`; `scheduleTurn` returning `not_found`; and `finishAttempt` returning `stale`. Today all of these `return false`, `runLoop` returns, and the run stays `running` forever with its participants reserved — this is the reported "stuck Agents" defect and the classification is the contract for `P11-02`.
- [x] **P11-02** Add a `RUN_ABANDONED` member to `CoordinationErrorCode` and a `run.reconciled` event type to the frozen event set, with redaction coverage in `coordination/redaction.ts` and an entry in the events factory. Both are additive; a mini-RFC entry records the addition. If the recorded classification makes every abandoned case resumable rather than failable, still add the event and use `INTERNAL_ERROR` only for the genuinely unexpected residue.

### Reconciliation

- [x] **P11-03** Implement loop-exit reconciliation. When `runLoop` is about to return without having issued `completeRun`, `failRun`, or observing a non-`running` status, it must reload the run and act on the P11-01 classification: if the run is still `running` with no `activeTurnId`, continue the loop (the decision source is pure and will re-derive the next turn); if it is still `running` *with* an `activeTurnId` whose attempt is not running, clear the stranded turn through a repository command and continue; if neither is safe, call `failRun` with `RUN_ABANDONED` and a message that names no lease, prompt, or raw output. Bound the resume path with a per-run attempt counter so a permanently stale run cannot spin — after a small number of consecutive reconciliations with no progress, fail it.
- [x] **P11-04** Add repository support for reconciliation: a read that lists non-terminal runs (`running`, `stop_requested`) and, for each, whether an attempt is still `running`; and a `reconcileRun` command that, in one `JsonStore.mutate()`, settles a stranded turn and attempt exactly the way `settleActiveWork` already does, appends `run.reconciled`, bumps `version`, and leaves the run `running` and schedulable. Terminal runs are untouched and immutable, and the command is idempotent on a run that needs nothing.
- [x] **P11-05** Implement the recorded reservation decision. If reservations narrow (the plan's recommendation, D5): change `collectReservedAgentIds` and `getReservingRunId` in `coordination/repository.ts`, and `assertDatabaseAgentNotReserved` in `agent-service.ts`, so an Agent is reserved while it has a **running attempt** in a non-terminal run, rather than while it merely appears in a `running` run; add a separate advisory read that reports which non-terminal session an Agent belongs to, for display only. If reservations stay whole-run, instead make the release path explicit and prove that every terminal transition releases. Either way, `startRun`'s participant checks (`repository.ts` `AGENT_NOT_READY` / `AGENT_RESERVED`) must keep refusing an Agent that is genuinely mid-attempt, and the existing verified-handoff reservation tests must keep passing under the new rule or be updated with a recorded justification.
- [x] **P11-06** Add a boot-time and periodic reconciler in the composition root. `CoordinationService.initialize` currently only calls `interruptActiveRuns`; extend it so that after interruption it also reconciles any run left non-terminal with no owning loop. Add a bounded interval sweep (recommend every 60 seconds, configurable, disabled in tests by injection) that reconciles runs with no entry in `activeLoops`. The sweep must be a no-op on a healthy system and must never resume a run whose loop is alive.

### Agent-level recovery

- [x] **P11-07** Surface Agent recovery in the web app. An Agent left in `error` after a failed Codex run blocks every future session because `startRun` demands `ready` for all participants. Show `lastError` on the Agent detail, add a clearly labelled control that calls the existing `POST /api/agents/:id/start` to return it to `ready`, and explain in one sentence what that does. No new server route is required.
- [x] **P11-08** Replace the opaque "Agent is reserved by coordination" message with one that names the session and links to it, using the advisory read from `P11-05`. The message must not leak lease tokens, prompts, or run internals beyond the session name and id already visible in the run index.

### Tests

- [x] **P11-09** Add a regression test per stale path from `P11-01`, each of which must fail against the pre-fix implementation: a commit that loses its lease; a `beginAttempt` that arrives after a stop; a turn superseded between reload and attempt; an `attachAgentRun` race; a `scheduleTurn` that finds a deleted run. Each asserts that the run reaches a terminal state or resumes to completion, and that no participant remains reserved afterwards. Use deferred promises and the existing scripted runtime; no sleeps.
- [x] **P11-10** Add lifecycle property tests: for a matrix of interleavings (stop during attempt, failure during attempt, restart during attempt, two runs contending for one Agent), assert the invariant *"no Agent is reserved unless some non-terminal run has a running attempt for it"* holds after settlement. Add a restart test proving `initialize` settles a crashed run and frees its Agents, and that a second `initialize` changes nothing.
- [x] **P11-11** Add a UI test that an Agent in `error` shows its message and can be reset, and that a reserved Agent shows the naming message rather than the opaque one.

## Requirements and invariants

- Every concurrency decision stays inside a single `JsonStore.mutate()`. Reconciliation adds no read-check-write sequence across store calls.
- A terminal run is immutable. Reconciliation may settle a `running` run; it may never re-open a `completed`, `failed`, or `stopped` one.
- Reconciliation is idempotent: running it twice on the same state produces the same state and no duplicate events.
- Per-run event sequences stay gapless, and every new event passes redaction.
- The reconciler never cancels work owned by a live loop; ownership is decided by the `activeLoops` map plus durable attempt status, not by timing.
- Error messages remain safe: no lease, prompt, raw output, or stack trace reaches HTTP, the UI, or the event ledger.

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

Run the race and reconciliation suites repeatedly through Docker Compose — at least ten consecutive passes — before declaring them stable. Then require the full Docker Compose `npm run check`. Also perform one manual Compose-deployment check: start a session, kill the server mid-attempt, restart it, and confirm from the UI alone that the run is settled and its Agents are usable.

## Completion gate

Phase 11 is complete only when:

- every stale path identified in `P11-01` has a test that fails on the old code and passes on the new;
- a killed and restarted server leaves no Agent reserved and no run stuck in `running`;
- the reservation rule matches the recorded decision and is proven by the invariant test;
- an Agent in `error` can be recovered from the UI without a restart;
- reservation messages name the responsible session;
- the verified-handoff regression suite passes;
- the final Docker Compose `npm run check` passes on the task branch.

## Handoff to Phase 12

Record the stale-path classification table, the reservation decision as implemented, and the restart evidence in `STATUS.md`, then set `P12-01` as the next action. Phase 12 introduces a run status that is deliberately long-lived and non-terminal; it must not start while any known path can strand a run, because that defect would then persist for the life of a session rather than for the life of a run.
