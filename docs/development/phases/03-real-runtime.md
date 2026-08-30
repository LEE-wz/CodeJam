# Phase 3 — Real Agent Runtime and Recovery

**Goal:** connect Relay to existing Agents through a backward-compatible execution seam with correlated cancellation, reservation enforcement, bounded timeout recovery, and measured demo latency.  
**Ends at:** Checkpoint 3 — one real Planner → Critic → Finaliser workflow completes without regressing Playground.

## Entry criteria

- A Phase 3 task branch has been created from the completed durable-backend checkpoint.
- The Phase 3 paths in [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) have been reviewed; provider files are accessed only when a direct contract requires them.
- Phase 2 lease/race/restart gates pass with the scripted runtime.
- Agent reservation semantics and correlation fields are frozen.
- Existing `AgentService` tests pass before refactoring.
- Ark/runtime configuration is available for manual smoke tests.

If cancellation ownership, timeout settlement, reservation behavior, provider access, or smoke-test expectations are unclear, stop and ask for clarification before proceeding.

## Required outputs

- `AgentExecutionHandle` completion seam and run-scoped cancellation.
- Backward-compatible `sendMessage()` behavior.
- Real `CoordinationRuntime` with timeout/cancel/cleanup mapping.
- Reservation enforcement across competing operations.
- Real-Agent smoke evidence and latency measurements.

## Tasks

### AgentService execution seam

- [x] **P3-01** Add `startExecution()` that creates the existing run/message state and immediately returns an Agent run ID plus completion promise.
- [x] **P3-02** Keep `sendMessage()` as a compatibility wrapper with unchanged observable API behavior.
- [x] **P3-03** Add coordination run/turn/attempt correlation to Agent runs without exposing lease tokens.
- [x] **P3-04** Add `cancelRun(agentRunId)` or equivalent run-scoped cancellation; never cancel by Agent ID when that could target later work.
- [x] **P3-05** Enforce reservation on Playground send, edit, delete, start/stop as frozen; allow only the internal request matching the reserving coordination run.
- [x] **P3-06** Preserve status, messages, output/error/usage, thread ID, restart, and workspace behavior.
- [x] **P3-07** Expand regression tests for normal send, failure reset, stop/cancel, correlations, reservation conflicts, and reservation release.

### Coordination runtime gateway

- [x] **P3-08** Start real execution with correlations and return `RuntimeExecutionHandle` before awaiting completion so the Agent run ID can be persisted.
- [x] **P3-09** Map success/failure/cancel into the small runtime outcome contract with safe messages.
- [x] **P3-10** Implement an explicit attempt timeout and attempt→Agent-run map with cleanup in `finally`.
- [x] **P3-11** On timeout, request correlated cancellation and wait a short bounded grace period for settlement before allowing retry.
- [x] **P3-12** If settlement cannot be confirmed, fail safely; never run two attempts concurrently on one Agent.
- [x] **P3-13** Test timeout-winning races, user cancellation, late completion, targeted cancellation, timer/map cleanup, and redaction using fake execution control.

### Real smoke and timing

- [x] **P3-14** Invoke one fresh Agent through the real gateway using a tiny harness before full orchestration.
- [x] **P3-15** Verify Agent runs/messages remain visible and thread IDs behave as expected.
- [x] **P3-16** Complete one short real Planner → Critic → Finaliser run.
- [x] **P3-17** Demonstrate that a reserved Agent rejects a competing Playground or coordination request.
- [x] **P3-18** Run at least three successful rehearsals and record per-turn/total timing ranges, redacted IDs, runtime profile, and timeout conclusion in `STATUS.md`.

## Requirements and boundaries

- Relay calls `AgentService`; it never calls provider/container code directly.
- Timeout and stop target a correlated Agent run, not “whatever this Agent is doing now.”
- Timers and active maps are always cleaned up.
- A late external completion may exist physically but cannot commit after lease loss.
- No timeout is reduced merely to stage a live failure.
- Use fresh demo Agents to avoid old persistent thread context.

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

Run all focused tests and smoke verification through Docker Compose. Before marking each implementation task complete, require the full Docker Compose `npm run check` above to pass. Then perform the one-Agent smoke, complete real workflow, reservation conflict, and three timing rehearsals through the Compose deployment. Never put credentials, raw prompts, or full model output in evidence notes.

## Completion gate

Phase 3 is complete only when:

- all existing AgentService/Playground tests pass;
- runtime success/failure/timeout/cancel/late-result cleanup tests pass;
- one real full workflow completes and artifacts validate;
- reservation conflict is demonstrated and terminal release works;
- timings show the default timeout/demo plan is feasible or an approved mini-RFC updates it;
- no correlated cancellation can stop a later unrelated Agent run.
- the final Docker Compose `npm run check` passes on the task branch.

## Handoff to Phase 4

Keep a redacted completed-run fixture for UI work and set `P4-01` as the next task. If real execution is unstable, freeze features and fix the one normal workflow before UI expansion.
