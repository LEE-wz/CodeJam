# Phase 1 to Phase 2 handoff

**Audience:** whoever implements Phase 2 (durable backend), and any AI assisting them.
**Read after:** [`STATUS.md`](./STATUS.md) and [`README.md`](./README.md), before opening
[`phases/02-durable-backend.md`](./phases/02-durable-backend.md).
**State at handoff:** Phase 0 and Phase 1 `complete`, Checkpoint 1 verified at commit `fbf76ea`.

This document exists so Phase 2 does not rediscover, mid-implementation, that a
frozen field has no producer or that a stored value's meaning was never agreed.
Everything below is either a decision to make or a constraint to respect.

---

## 1. Decide before P2-01

P2-01 defines `DatabaseV2`. Each item here changes what gets persisted, so
deciding after P2-01 means writing a migration instead of an edit.

### 1.1 What `CoordinationArtifact.sizeChars` means

The frozen contract declares the field and never defines it. Phase 1 sets it to
**the length of the raw Agent output that was measured against
`outputMaxChars`**, on the reasoning that only the parsed payload is stored, so
this is the sole surviving record of how large the model's response was.

The alternative is the length of the serialised stored payload.

Decide which. Once artifacts persist, changing it is a migration, and the two
values differ substantially whenever output arrived inside a code fence.

Owner: whoever writes P2-01. Recorded in
[`ASSUMPTIONS_AND_DECISIONS.md`](./ASSUMPTIONS_AND_DECISIONS.md).

### 1.2 Where the `truncated` context flag lives

Overview Section 11.6 requires recording `truncated: true` in "attempt metadata
or event details". `ContextBuilder` computes it correctly and returns it on
`PromptEnvelope`. **`CoordinationService` currently drops it, because
`CoordinationAttempt` has no field to hold it.** The requirement is therefore
unmet today.

Two options:

- **Event detail only.** Emit it in the `attempt.started` event details in P2-05.
  No contract change; no persisted attempt field.
- **Attempt field.** Add `truncated?: boolean` to `CoordinationAttempt` via a
  mini-RFC, and have the service pass `envelope.truncated` into `beginAttempt`.

The second changes `DatabaseV2`, so it must be settled before P2-01.

### 1.3 Whether `attempt.outputDigest` survives

`CoordinationAttempt.outputDigest` is declared in the frozen type and **written
by nothing**. No Phase 1 code path produces it.

Either populate it during P2-11 (commit) and P2-09, or remove it from the type
by mini-RFC. Do not leave a permanently-null column in `DatabaseV2`.

---

## 2. Decide during Phase 2

These do not affect persisted shape, so they can wait, but they should not be
left to the end.

### 2.1 How `attempt.stale_ignored` is produced

`CoordinationAttemptStatus` includes `stale_ignored`, and overview Section 11.3
step 7 requires it when a commit loses its lease. **No code path can produce it.**
The frozen `FinishAttemptInput.status` union is
`"invalid_output" | "timed_out" | "failed" | "cancelled"` — it does not accept
`stale_ignored`.

The behaviour itself is already correct and tested: a late or duplicate result is
refused by the lease and cannot change state. Only the evidence row is missing.

Options: emit it purely as a `attempt.stale_ignored` event in P2-05/P2-09, or
extend the `finishAttempt` status union by mini-RFC so the attempt record itself
carries it. Phase 4's timeline is the consumer, so decide with the UI in mind.

### 2.2 Whether `PromptEnvelope.includedArtifactIds` is kept

Returned by the context builder and dropped by the service.
`CoordinationTurn.inputArtifactIds` already records nearly the same evidence.
Either surface it in an event detail in P2-09, or remove it from `PromptEnvelope`
by mini-RFC. Keeping an unused field invites a future reader to assume it is
authoritative.

---

## 3. Already settled — do not relitigate

Six prompt-construction decisions were made where the frozen contract is silent.
None touches a frozen type, route, or persisted shape, and all are reversible at
any time. The full table with rationale is in
[`ASSUMPTIONS_AND_DECISIONS.md`](./ASSUMPTIONS_AND_DECISIONS.md):

- retry feedback bounded to 10 messages of 500 characters;
- context truncation via a fixed descending cap ladder (6000, 3000, 1500, 750,
  400, 200), failing safely below the last rung;
- only long free-text fields truncate — section keys and titles never do;
- artifact identifiers are withheld from prompts entirely;
- retry feedback is appended inside `[YOUR TASK]`, keeping the Section 11.5
  envelope literally four sections;
- required section keys are trimmed and lower-cased before the duplicate check,
  then rejected unless they match the frozen slug format.

---

## 4. Findings that change Phase 2's task list

### P2-19 is already satisfied

"Resolve/remove the non-contract `/events` endpoint" was completed in `ea469b2`.
`routes.test.ts` asserts the route returns `404` so it cannot silently return.
Verify rather than implement.

### P2-17's composition root must wire the real Phase 1 components

```
workflow:         VerifiedHandoffWorkflowV1        (coordination/workflow.ts)
artifactProtocol: VerifiedHandoffArtifactProtocol  (needs { clock, ids })
contextBuilder:   RoleScopedContextBuilder         (coordination/context-builder.ts)
```

`CoordinationService.createRun` calls `contextBuilder.build()` with a synthetic
probe turn (`<runId>-context-probe`) to enforce Section 11.6's create-time
context check. Wiring a stub builder here silently disables that check.

### The real repository has a behavioural reference

`testing/memory-repository.ts` (`InMemoryCoordinationRepository`) already
enforces the lease, active-attempt, and status checks that P2-09 to P2-13
require, and returns deep copies so callers must reload. Use it as the
specification for the durable implementation's accept/reject conditions; it is
not a substitute for the atomicity, migration, event, and reservation work,
which remain entirely Phase 2.

### The context builder throws

`RoleScopedContextBuilder` throws `CoordinationError(400, "VALIDATION_FAILED")`
when a prompt cannot be made to fit `policy.contextMaxChars`. The service's
top-level catch preserves that structured code rather than flattening it to
`INTERNAL_ERROR`. Phase 2 error mapping must not swallow it.

---

## 5. Constraints Phase 2 inherits

- **Shared test fixtures are frozen.** `testing/fixtures.ts`, `testing/fakes.ts`,
  `testing/controls.ts`, `testing/memory-repository.ts` and the scripted runtime
  are depended on by Phase 1's 237 tests. Extend them additively; changing
  existing fixture behaviour requires a recorded decision.
- **Do not connect real Agents.** Real execution is Phase 3 and is gated on all
  Phase 2 race and correctness tests passing.
- **Every task:** new task branch first, consult `FILESYSTEM_MAP.md`, verify only
  through the Docker Compose command in `README.md`, and require a passing
  Docker Compose `npm run check` before marking anything `complete`. Host `npm`
  results are not evidence.
- **When anything is unclear, stop and ask.** Record the answer in
  `ASSUMPTIONS_AND_DECISIONS.md` or `STATUS.md` before resuming. Do not
  substitute an assumption.
- **Source of truth order:** overview Sections 4 and 6–11, then an approved
  mini-RFC, then the phase sheet, then `STATUS.md`.

## 6. Open risks carried forward

| Risk | Detail |
|---|---|
| Dependency audit | `npm ci` reports 1 moderate and 5 high findings, deferred to release review (P9-16). Do not apply breaking upgrades mid-phase. |
| Agent-ID-keyed cancellation | Current cancellation can target unrelated later work. Fixed by run-scoped cancellation in P3-04, after Phase 2 gates. |
| Single-process store | `JsonStore` serialises mutations for one process only. This is an accepted MVP limitation, not a defect to solve in Phase 2. |
