# PA14-27 Restart-Reconciliation Fix Plan

> **For the implementer:** implement task-by-task, TDD (red-green-refactor), commit after each task, stay on branch `bidding-agent-implementation`, never push or merge without the project owner's say-so.

**Goal:** A server restart at the exact post-bid / pre-award or post-award / pre-attempt boundary must recover the round: derive the award from the settled bids, execute the awarded plan, publish the response, and settle to `awaiting_input` — without duplicating bids, awards, or published messages.

**Architecture:** Two surgical changes. (1) Boot recovery (`interruptActiveRuns` in `repository.ts`) currently fails every active turn of a shared session and returns the run to `awaiting_input`, where nothing ever re-derives the round. Change it so auction-session rounds with pending work stay `running` and their interrupted award-execution turns become `cancelled` (not `failed`), so the existing boot reconciliation (`reconcileUnownedRuns`) starts a loop that re-derives. (2) The workflow's awarded-execution derivation (`session-workflow.ts`) currently counts every award-execution turn as "attempted", which blocks re-scheduling after a recovery cancellation; make it count only committed turns.

**Tech Stack:** TypeScript, Fastify server, in-memory + durable JSON repository, Vitest. Verification via disposable Docker Compose gate (the only valid gate) and the live rehearsal script.

---

## Verified context (read this first)

Evidence from run `1e5434a4-100d-4d97-b3ea-e187a2588ad6` (still in `data/launchpad.json`), re-readable with `node scripts/pa14-27-rehearsal.mjs report 1e5434a4-100d-4d97-b3ea-e187a2588ad6`:

- Event tail (gapless 294): `turn.committed` (10th bid) → `award.created` (outcome `execute_plan`) → `turn.scheduled` (one execution turn) → `run.interrupted` (`SERVER_RESTARTED`) → `run.awaiting_input`.
- The execution turn `3a6aa975-3880-40e4-b908-eab0be0ec19e` ended `failed` with **0 attempts**; award `695cda46-265f-45ff-8129-1e19afde0960` was never executed; no `session_message` was published for that round. Session sits at `awaiting_input`, looking healthy.

Root causes (all verified in code):

1. `interruptActiveRuns` (`apps/server/src/coordination/repository.ts:1188-1235`) settles **every** active turn of a shared session to `failed` via `settleActiveWork` (line 1327-1367), including zero-attempt scheduled turns, and unconditionally sets status `awaiting_input` + appends `run.awaiting_input` (lines 1208-1212). `reconcileUnownedRuns` (`service.ts:321-363`) only starts loops for `running`/`stop_requested` runs, so an `awaiting_input` run is never re-derived. The round dies silently.
2. `decideNext` award branch (`session-workflow.ts:410-505`): line 435-441 fails the run if any award-execution turn is `failed`; line 442 builds `attemptedAgentIds` from **all** award-execution turns regardless of status. So even if a loop resumed, a recovery-failed or recovery-cancelled turn blocks re-scheduling that assignment.
3. The re-derivation machinery itself already exists and is green: `decideNext` returns `resolve_auction` once bid turns exist (`session-workflow.ts:595-613`), the award branch re-derives remaining assignments (`session-workflow.ts:410-505`), and PA14-23 tests (`auction-execution.test.ts:470-547`, `auction-routing-decisions.test.ts:502+`) prove restart derivation works when the run is left resumable. **The fix aligns boot recovery with that machinery.**

Constraints that must stay green:

- Verified handoffs must keep failing terminally on restart (`api.test.ts:799` "settles a run interrupted by a restart..." expects `failed` + `SERVER_RESTARTED`).
- Legacy shared sessions (no `auctionPolicy`) must keep Phase 11/12 semantics: interrupted wave settled, run back to `awaiting_input`, byte-for-byte idempotent second `initialize()` (`lifecycle-reconciliation.test.ts:578-606`).
- Genuine awarded-execution failure still fails the round (PA14-13): no runner-up promotion.
- `validateSessionView` (`session-workflow.ts:44-231`) forbids `activeTurnIds.length > 0` and turns in status `scheduled`; allowed statuses are `committed | cancelled | failed`. Any recovery path must leave the run in a state that passes this view.
- The harness `scripts/pa14-27-rehearsal.mjs` must not change; it is the acceptance driver (its working-tree fixes at `a8a4722` are already in place).

---

## Approach

All new behavior is gated on `run.policy.auctionPolicy !== undefined` (auction sessions). Everything else keeps today's exact behavior.

### Change 1 — recovery: `apps/server/src/coordination/repository.ts`

In `interruptActiveRuns`, shared-session branch (`run.policy.workflow === "shared_session_v1"`):

1. Capture `run.activeTurnIds` before calling `settleActiveWork` (it clears the list).
2. Call `settleActiveWork` exactly as today (cancels running attempts, marks turns `failed`, clears `activeTurnIds`).
3. For auction sessions only, in the same mutation, flip interrupted **award-execution turns** from `failed` to `cancelled`: a turn is an award-execution turn iff `turn.kind === "session_turn"` and `turn.inputArtifactIds` includes the current round's award id. Current round's award = the `session_award` artifact with `payload.userArtifactId === run.lastUserArtifactId`. Do not emit a turn event for the flip (parity with the stop path, which also marks turns `cancelled` without a turn event).
4. For auction sessions only, decide the run status:
   - Compute the pending-round predicate (below). If **pending** → keep `run.status = "running"`, do **not** append `run.awaiting_input`, clear `errorCode`/`errorMessage` if any.
   - If not pending → `awaiting_input` exactly as today (append `run.awaiting_input`).
   - Always append `run.interrupted` (already the case; the harness asserts it).
5. Legacy sessions and verified handoffs: unchanged.

Pending-round predicate (auction sessions, current round = `run.lastUserArtifactId`):

- No award for the round: pending iff at least one `session_bid` turn exists for the round (`turn.kind === "session_bid" && turn.inputArtifactIds.includes(run.lastUserArtifactId)`). This covers the harness boundary (10 settled bids, no award) and auto/direct-failure escalation mid-round. A run killed before bidding began (no bids) settles to `awaiting_input` as today — direct rounds keep their current semantics.
- Award outcome `publish_candidate`: not pending (auto-direct is complete once published).
- Award outcome `execute_plan`: pending iff some assignment of the winning bid's plan has no **committed** award-execution turn. If the winning bid artifact is missing (corrupt state), treat as not pending (run stays usable; do not auto-fail).

### Change 2 — derivation: `apps/server/src/coordination/session-workflow.ts`

At line ~442, build `attemptedAgentIds` from **committed** award-execution turns only:

```ts
const attemptedAgentIds = new Set(
  awardExecutionTurns
    .filter(({ status }) => status === "committed")
    .map(({ agentId }) => agentId),
);
```

Keep the `some(({ status }) => status === "failed")` → `fail` check (line 435-441) unchanged: genuine agent failures still fail the round; recovery-produced `cancelled` turns no longer do.

### Why no `service.ts` change

`initialize()` (`service.ts:296-303`) runs `interruptActiveRuns` then `reconcileUnownedRuns`. A run kept `running` with cleared `activeTurnIds` hits `reconcileRun` → returns `noop` → `startLoop` (lines 340-353). `runLoop` (`service.ts:859+`) requires status `running` (satisfied), and `decideNext` then re-derives: settled bids → `resolve_auction` → `awardSessionBid` → award branch → schedule → execute → publish → `await_input`. Verified against the current code; no loop or epoch changes needed.

---

## Appendix: implementation sketch (verify against the real types before committing)

The durable store shapes below were read from `data/launchpad.json` (turn fields: `kind`, `status`, `agentId`, `inputArtifactIds`, `outputArtifactId`, `activeAttemptId`; award payload: `userArtifactId`, `winningBidArtifactId`, `outcome`; bid payload: `plan.assignments[{agentId, position, instruction}]`). Re-check the TypeScript types in `repository.ts` and `types.ts` before writing the final code.

```ts
// Inside interruptActiveRuns, shared-session branch, before settleActiveWork:
const activeTurnIds = [...run.activeTurnIds];

// ... settleActiveWork as today (clears activeTurnIds) ...

// Auction sessions only:
if (run.policy.auctionPolicy !== undefined) {
  const award = database.coordinationArtifacts.find(
    (a) => a.runId === run.id && a.type === "session_award"
      && a.payload?.userArtifactId === run.lastUserArtifactId,
  );

  // 1. Interrupted award-execution turns become cancelled, not failed.
  for (const turnId of activeTurnIds) {
    const turn = database.coordinationTurns.find((t) => t.id === turnId);
    if (turn && turn.kind === "session_turn" && award
        && turn.inputArtifactIds.includes(award.id)) {
      turn.status = "cancelled";
    }
  }

  // 2. Pending-round predicate decides whether the run stays running.
  const roundBidTurns = database.coordinationTurns.filter(
    (t) => t.runId === run.id && t.kind === "session_bid"
      && t.inputArtifactIds.includes(run.lastUserArtifactId),
  );
  let pending = false;
  if (!award) {
    pending = roundBidTurns.length > 0;
  } else if (award.payload.outcome === "execute_plan") {
    const winningBid = database.coordinationArtifacts.find(
      (a) => a.id === award.payload.winningBidArtifactId && a.type === "session_bid",
    );
    if (winningBid?.payload?.plan) {
      const committedExecutionAgents = new Set(
        database.coordinationTurns
          .filter((t) => t.runId === run.id && t.kind === "session_turn"
            && t.status === "committed" && t.inputArtifactIds.includes(award.id))
          .map((t) => t.agentId),
      );
      pending = winningBid.payload.plan.assignments.some(
        ({ agentId }) => !committedExecutionAgents.has(agentId),
      );
    }
  }
  // If pending: keep run.status = "running", skip the run.awaiting_input event.
  // Else: existing awaiting_input path unchanged.
}
```

---

## Step-by-step tasks (TDD)

### Task 1: Write the failing regression tests

**Files:**
- Test: `apps/server/src/coordination/auction-execution.test.ts` — extend the `PA14-23 restart boundaries` describe block, or add a sibling `describe("PA14-27 restart recovery", ...)`.

Follow the existing harness patterns in that file (`harness`, `settle`, `auctionRequest`, `bid`, `restart` helper at lines 472-494; durable-repo restart pattern in `api.test.ts:799+` and `lifecycle-reconciliation.test.ts:578+` — a fresh `CoordinationService`/repository over the same store, then `initialize()`).

Tests to add:

1. **Pre-award boundary (case a):** session with auction policy, `routingMode: "auction"`, all bids committed, no award, run `running`, `activeTurnIds` empty. Call `interruptActiveRuns()`. Assert: `run.interrupted` appended, run stays `running`, **no** `run.awaiting_input` event, all bid turns still `committed`, bids intact. Then resume with the restarted service (scripted runtime provides the execution response) and assert: exactly one `session_award` (outcome `execute_plan`), exactly one `session_message`, run settles `awaiting_input`, no extra bids.
2. **Post-award boundary (case b):** session with award committed (`execute_plan`, single assignment) plus one execution turn in status `scheduled` with zero attempts, run `running`, `activeTurnIds = [turn]`. Call `interruptActiveRuns()`. Assert: the execution turn is now `cancelled` (not `failed`), `activeTurnIds` cleared, run stays `running`, award intact. Resume and assert: exactly one new `session_turn` commits, exactly one `session_message`, exactly one award total, `awaiting_input`.
3. **Derivation unit (workflow-level):** `decideNext` with a `cancelled` award-execution turn present → returns `schedule` for the same assignment (remaining includes the cancelled agent). And with a `failed` award-execution turn → still returns `fail` `MAX_ATTEMPTS_EXCEEDED` (PA14-13 preserved).
4. **Idempotency:** after the recovered round settles to `awaiting_input`, a second `initialize()` changes nothing byte-for-byte (mirror `lifecycle-reconciliation.test.ts:603-605`).
5. **Gate preservation:** a legacy free-chat session (no `auctionPolicy`) interrupted mid-attempt still settles to `awaiting_input` with turns `failed` (explicit assertion so the gate is documented, not incidental).

### Task 2: Run the new tests — confirm they FAIL

Run the focused suite (host run of the workspace tests is fine for red-green; the Compose gate is the acceptance gate):

```sh
cd apps/server && npx vitest run src/coordination/auction-execution.test.ts
```

Expected: the new cases fail (run settled to `awaiting_input` early, or turn `failed` instead of `cancelled`, or no message published). Record the red run.

### Task 3: Implement Change 1 (recovery) in `repository.ts`

- `interruptActiveRuns` (`repository.ts:1188-1235`): capture active turn ids before settling; add the auction-session post-pass (flip award-execution turns `failed` → `cancelled`); add the pending-round predicate and conditional status/`run.awaiting_input` handling.
- Keep `settleActiveWork` itself untouched if possible; if a signature change is cleaner, keep it backward-compatible for `failRun`/`finishStopped`/`reconcileRun` callers (they must not get the flip).

### Task 4: Implement Change 2 (derivation) in `session-workflow.ts`

Committed-only `attemptedAgentIds` (see Approach). Re-run Task 2 tests — now green.

### Task 5: Run the full focused suite set

```sh
cd apps/server && npx vitest run src/coordination/auction-execution.test.ts src/coordination/auction-award.test.ts src/coordination/auction-routing-decisions.test.ts src/coordination/auction-routing.test.ts src/coordination/session-workflow.test.ts src/coordination/lifecycle-reconciliation.test.ts src/coordination/api.test.ts
```

Expected: all green, including the pre-existing restart tests (`api.test.ts:799`, `lifecycle-reconciliation.test.ts:578+`, PA14-23 blocks). Per project practice, run the focused auction set (now ~55+ tests) ten consecutive times to prove zero flakes.

### Task 6: Full disposable Docker Compose gate (mandatory acceptance)

Exact command from the runbook / phase sheet (see `docs/development/README.md`):

```sh
docker compose build launchpad
LAUNCHPAD_ENV_FILE=/dev/null docker compose run --rm launchpad sh -c "npm ci --include=dev && npm run check"
```

Expected: both workspace typechecks, both production builds, server + web tests all green (754 existing tests + the new ones). Record the exact counts.

### Task 7: Live rehearsal (acceptance for PA14-27)

```sh
node scripts/pa14-27-rehearsal.mjs run
```

Expected: all 8 rounds pass, ending `PA14-27 PASS`. The restart round must show: 10 bids preserved, exactly one award naming a settled bid, exactly one published message, a `run.interrupted` event, no running attempts. Budget ~20-30 minutes (real model calls, 60s cooldowns) and be mindful of provider capacity. Recommend running it twice for stability evidence. This task is deliberately separated from the implementation tasks: it consumes real provider budget (~3.8M input tokens per run) and its failures can be environmental (provider capacity, 429s), not code.

### Task 8: Close out

- Update `docs/development/STATUS.md` only after the rehearsal passes: `PA14-27` → `complete`, then proceed to `PA14-18` (countdown engine deletion) per the phase sheet, then the final gate. Log the rehearsal evidence with the run id. Doc-only changes must not claim the gate passed unless it did.
- Commit per task; keep everything on `bidding-agent-implementation`. No push/merge without the project owner.

---

## Definition of done (for the implementer)

- [ ] New regression tests exist for both boundaries (pre-award, post-award) and fail on the pre-fix code (red run recorded).
- [ ] `repository.ts` + `session-workflow.ts` changed; `service.ts`, `contracts.ts`, `types.ts`, `scripts/` untouched (`git diff --stat` shows only the planned files).
- [ ] Focused suites green; restart tests run 10 consecutive times with zero flakes.
- [ ] Full disposable Compose gate green with exact counts recorded.
- [ ] The live rehearsal and STATUS.md update are NOT part of this implementation pass; they are the next step after acceptance.

## Files likely to change

- `apps/server/src/coordination/repository.ts` — `interruptActiveRuns` (+ optional small helper for the pending predicate; `settleActiveWork` only if a clean signature is chosen).
- `apps/server/src/coordination/session-workflow.ts` — `attemptedAgentIds` (one line + filter).
- `apps/server/src/coordination/auction-execution.test.ts` (or new `auction-restart-recovery.test.ts`) — regression tests.
- `docs/development/STATUS.md` — after acceptance only.
- NOT changed: `service.ts`, `scripts/pa14-27-rehearsal.mjs`, `contracts.ts`/`types.ts` (no schema or contract changes; `cancelled` is already a valid turn status), web app.

---

## Risks and tradeoffs

- **Legacy contract protection:** all new behavior is gated on `auctionPolicy !== undefined`; P11/P12 restart tests pin the legacy path and must stay green. This is the main regression risk — Task 5 and the 10x focused runs exist to catch it.
- **Behavior change (intended):** an auction round interrupted by a restart now auto-completes (deriving the award from settled bids and executing it) instead of returning to `awaiting_input` for the user to re-ask. This is exactly what PA14-27 requires; record it in STATUS.md once verified.
- **Run kept `running` forever:** bounded by existing failure paths (`resolveAuction` fail, `MAX_TURNS_EXCEEDED`, invalid state). The pending predicate must never return true for a round that cannot make progress — the "winning bid missing → not pending" rule covers the corrupt-data edge.
- **Repeated `run.interrupted` on successive boots:** only if a pending round never settles; terminates once the round completes. Acceptable.
- **Parallel awarded plans:** recovery cancels in-flight attempts and re-derives the wave for non-committed assignments — consistent with PA14-12 ("a restart repeats no committed work"). Covered by test 3 pattern extended to `schedule_wave` if desired.

## Open questions (for the project owner, not blockers)

1. Should the fixed recovery also auto-complete **direct** rounds interrupted mid-execution (they currently settle to `awaiting_input`; the fix deliberately leaves them)? Recommendation: leave unchanged — not needed for acceptance, smaller blast radius.
2. Where should the new tests live: extend `auction-execution.test.ts` (consistent with PA14-23) or a new `auction-restart-recovery.test.ts` (cleaner file boundary)? Either is fine; pick one.
