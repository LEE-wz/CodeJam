# Relay Assumptions and Resolved Questions

**Last audited:** 2026-08-30  
**Baseline commit:** `655fba5`
**Accepted contract commit:** `ea469b2` (`relay/contracts-v1`)
**Contract authority:** Sections 4 and 6–11 of [`overview.md`](./overview.md)

This file closes questions that can be answered from the checked-out code and isolates the few items that require measurement or a team contract change.

## Resolved Sprint 0 questions

| Question | Answer | Consequence |
|---|---|---|
| Does `AgentService` expose completion as a promise? | No. `sendMessage()` returns the queued run/message while `executeRun()` remains private and its promise is stored internally. | Phase 3 must add `startExecution()` returning an `AgentExecutionHandle`, retain `sendMessage()` as a compatibility wrapper, and add run-scoped cancellation. |
| Does `JsonStore` have a migration hook? | No. `initialize()` parses directly as `Database` and rejects any version other than `1`. | Phase 2 must add explicit v1 parsing and additive v1→v2 migration before changing the empty database to v2. A future/invalid version must be rejected without overwriting the file. |
| Where are route modules registered? | `createApp(config, service, coordination?)` conditionally calls `registerCoordinationRoutes(...)` after existing Agent routes and before static-file setup. | Preserve this seam. Phase 2 must construct the real coordination dependencies in `index.ts`, initialize them after `AgentService`, and pass the service into `createApp`. |
| Which spelling is canonical? | Code and API values use `finalizer`. | Use “Finaliser” in user-facing copy to match the product narrative, but never use it as a stored enum or API value. Tests should assert `finalizer` in code. |
| How should stopping a terminal run behave? | The service returns the terminal run and the route returns `202` with `accepted: true`. | Stop is idempotent for MVP. Route tests cover completed, failed, and stopped runs; changing this now requires a mini-RFC. |

## Measured later, not open design questions

| Item | How it is resolved | Required evidence |
|---|---|---|
| Real model latency | Measure in Phase 3 with three fresh demo Agents and the seeded short objective. Do not lower the normal timeout merely to manufacture a failure. | Record per-turn and total timings for at least three successful rehearsals; confirm `perAttemptTimeoutMs=120000` is practical or approve a mini-RFC. |
| Schema compliance of real output | Exercise each role prompt through the real runtime after pure protocol tests pass. Validators remain authoritative. | Several successful outputs for proposal, rejecting/approving review, and final schemas; record only redacted results. |
| Old thread contamination | Use fresh Agents for the MVP demo as required by the plan. | Rehearsal checklist confirms fresh Agents; per-run threads remain post-MVP unless promoted by mini-RFC. |

## Resolved contract deviations

### Mini-RFC: artifact schema field limits

**Status:** Approved by the user on 2026-08-29 for P1-05.

**Current contract and blocker:** The frozen artifact contract requires strict
Zod schemas with bounded strings and arrays but does not assign numeric limits.
P1-05 cannot provide stable boundary behavior or tests without those values.

**Approved change:** Proposal/review section keys and review issue codes are
limited to 64 characters; section keys use the existing required-section slug
format. Section and final titles are limited to 120 characters, proposal
summaries to 1,000, section content to 6,000, issue messages to 1,000, review
feedback to 2,000, and final content to 16,000. Proposal sections contain 1–20
items and review issues 0–20 items. Every textual field is trimmed and non-empty.
All objects are strict. The separate raw `outputMaxChars` check remains P1-06.

**Affected files/workstreams:** Artifact schemas and tests, protocol parsing,
prompt output-contract documentation, and future API/UI artifact fixtures. There
is no persistence-shape change because the TypeScript payload fields are
unchanged.

**Required evidence:** Each valid fixture parses; exact string/array boundaries
are accepted; one-over boundaries, empty strings, invalid section-key slugs, and
unknown root/nested fields are rejected. Decision consistency and proposal
coverage remain P1-07 cross-field rules.

### Mini-RFC: workflow view includes committed turns

**Status:** Approved by the user on 2026-08-29 for P1-01.

**Current contract and blocker:** The frozen `WorkflowView` contains a run and
its artifacts, while P1-01 requires latest-artifact selectors to order artifacts
by committed turn sequence. An artifact contains only `turnId`; artifact array
order and timestamps are not ordering contracts, so the required selector cannot
be implemented from the frozen view without guessing.

**Approved change:** Add `turns: CoordinationTurn[]` to `WorkflowView`. The
workflow receives the turns already loaded in `CoordinationRunDetails` and uses
them only as immutable input. A candidate artifact is committed only when its
same-run turn has `status: "committed"` and `outputArtifactId` equal to the
artifact ID. Latest selection compares `turn.sequence`, never timestamps or
array position.

**Affected files/workstreams:** The overview and TypeScript workflow contract,
the coordination service call site, pure workflow selectors, and their tests.
There is no persisted-schema or HTTP API change. Phase 2 repositories must not
rely on artifact array ordering.

**Required evidence:** Focused pure selector tests cover shuffled input,
misleading timestamps, artifact type filtering, and exclusion of uncommitted,
mismatched, and cross-run records. The full Docker Compose `npm run check` must
pass.

### Phase 1 implementation decisions (confirmed)

**Status:** Recorded on 2026-08-29 for P1-06 to P1-17. **Confirmed unchanged by
the user on 2026-08-30 at the Phase 2 sign-off, before P2-01.** Each sits where
the frozen contract is silent. None changes a frozen type, route, or persisted
shape, so none required a mini-RFC. `sizeChars` was the one that becomes
expensive to change once Phase 2 persists artifacts; it is settled below and in
the Phase 2 handoff decision table.

| Decision | Choice made | Why | Reversal cost |
|---|---|---|---|
| `CoordinationArtifact.sizeChars` | Length of the raw Agent output that was measured against `outputMaxChars` | Only the parsed payload is stored, so this is the sole surviving record of how large the model's response was | Cheap now; a stored-field meaning change after Phase 2 |
| Retry feedback bounds | At most 10 messages, each at most 500 characters | Overview Section 11.3 requires concise feedback but assigns no numbers; the context cap still applies on top | Cheap, prompt-only |
| Context truncation | Fixed descending ladder of per-field caps (6000, 3000, 1500, 750, 400, 200), lowest rung then fails | A fixed ladder keeps the chosen cap, prompt, and digest reproducible; a search would not | Cheap, prompt-only |
| Truncatable fields | Proposal summary and section content, review feedback and issue messages, final content only | Section keys and titles stay intact so a truncated proposal still shows the coverage it claims (Section 11.6 forbids silently removing required section content) | Cheap, prompt-only |
| Artifact identifiers in prompts | Withheld; only payloads are serialised | The output contract forbids emitting IDs, so an Agent is never shown one it could echo back as forged provenance; `includedArtifactIds` still records what was shown | Cheap, prompt-only |
| Retry feedback placement | Appended inside `[YOUR TASK]`, not as a fifth envelope section | Keeps the Section 11.5 envelope literally four sections while satisfying Section 11.3 | Cheap, prompt-only |
| Required section key normalisation | Trimmed and lower-cased before the duplicate check, then rejected unless it matches the frozen slug format | Section 25.1 requires normalising to the documented slug format and rejecting duplicates; without this a run could be created that no Agent output could ever satisfy | Cheap; changes accepted create inputs |
| Create-time context check | `createRun` builds a probe prompt with the real context builder and rejects the run if it cannot fit | Section 11.6 requires failing creation when the objective and sections alone do not fit; using the real builder means creation cannot succeed for a run whose first prompt is impossible | Cheap |
| Cross-field rules for final artifacts | Non-empty final title and content are left to the bounded schema and asserted by test rather than re-checked in the cross-field step | The trimmed schema already guarantees it; a second check would be dead code | Cheap |

Two related gaps are deliberately left to their own phases rather than solved
here:

- A stale commit cannot record `attempt.stale_ignored`, because events are
  Phase 2 (P2-05) and `finishAttempt` does not accept that status. The late
  result is still refused; only its evidence row is missing.
- `CoordinationTurn.lastValidationErrors` records validator messages only. A
  runtime timeout or failure surfaces through the attempt's `errorCode` and
  `errorMessage` and through the failed run's message, not through that field.

### Mini-RFC: additive repository inputs for `truncated` and `outputDigest`

**Status:** Recorded on 2026-08-30 during P2-09/P2-11. **Awaiting user
confirmation**; implemented because it is the only way to honour the handoff
decisions the user already made, and it is additive and reversible.

**Current contract and blocker:** The confirmed handoff decisions require the
repository to emit `truncated` on the `attempt.started` event (§1.2) and to
write `attempt.outputDigest` at commit (§1.3). Neither value can reach the
repository: the frozen `BeginAttemptInput` is `{ runId, turnId, attempt }` and
`CoordinationAttempt` has no `truncated` field, and the frozen
`CommitAcceptedArtifactInput` is `{ runId, turnId, attemptId, leaseToken,
artifact }` with no digest of the raw output. Both values exist in
`CoordinationService`, which holds the `PromptEnvelope` and the raw output.

**Proposed change:** Two optional input fields, nothing else.

- `BeginAttemptInput.truncated?: boolean | undefined`
- `CommitAcceptedArtifactInput.outputDigest?: string | undefined`

No frozen domain type, event type, route, or persisted shape changes.
`CoordinationAttempt.outputDigest` already exists and merely gains a producer.
Both fields are optional, so every existing caller and the Phase 1 fixtures
compile unchanged.

**Affected files/workstreams:** `coordination/contracts.ts`,
`coordination/repository.ts`, `coordination/service.ts` at the two call sites,
and the repository tests. `testing/memory-repository.ts` ignores both fields and
so is unchanged, preserving the frozen Phase 1 fixture behaviour.

**Required evidence:** `attempt.started` carries `truncated` for a truncated
prompt and for an untruncated one; a committed attempt records the supplied
`outputDigest`; omitting either field leaves the attempt and event exactly as
before. The full Docker Compose `npm run check` must pass.

**Alternative rejected:** deriving the digest inside the repository from the
stored payload. That would silently redefine `outputDigest` as a payload digest,
contradicting decision §1.3 and mirroring the `sizeChars` ambiguity the handoff
was written to close.

### Phase 2 handoff decisions

**Status:** Decided by the user on 2026-08-30, before P2-01, in answer to the
four open items in [`PHASE_2_HANDOFF.md`](./PHASE_2_HANDOFF.md) sections 1 and
2.1. None of the four requires a mini-RFC: no frozen type, route, or field is
added, removed, or changed by any of them.

| Handoff item | Decision | Consequence for Phase 2 |
|---|---|---|
| §1.1 `CoordinationArtifact.sizeChars` | **Length of the raw Agent output measured against `outputMaxChars`** — Phase 1 behaviour is confirmed, not changed | `DatabaseV2` stores the raw-output length. Only the parsed payload is persisted, so this remains the sole surviving record of the model response size. No Phase 1 code or test changes. |
| §1.2 `truncated` context flag | **Event detail only.** P2-05 emits `truncated` in the `attempt.started` event details | Satisfies overview Section 11.6 ("attempt metadata **or** event details") with no contract change and no persisted attempt field. `CoordinationAttempt` gains no `truncated` field, so `DatabaseV2` is unaffected. Phase 4's timeline is the consumer. |
| §1.3 `attempt.outputDigest` | **Populate it.** The digest of the raw Agent output is written when an attempt settles with output, in P2-09/P2-11 | The frozen field keeps a producer and `DatabaseV2` gets no permanently-null column. It mirrors the existing `promptDigest` and gives attempt→output evidence without persisting raw output. |
| §2.1 `attempt.stale_ignored` | **Event only.** The repository appends an `attempt.stale_ignored` event referencing the refused attempt; the attempt row keeps the status it settled as | The frozen `FinishAttemptInput.status` union is not extended, so a caller that lost its lease never writes to an attempt it does not hold. Accepted cost: the `stale_ignored` member of `CoordinationAttemptStatus` stays unwritten, and Phase 4 reads the evidence from the event stream. |

Handoff §2.2 (`PromptEnvelope.includedArtifactIds`) is **still open**. It does not
affect persisted shape and is decided at P2-09, as the handoff allows.

### Extra events endpoint

The implementation previously exposed `GET /api/coordination-runs/:id/events`, but the frozen route table only requires list, create, detail, start, and stop. The detail response already contains events. The extra route was removed in `ea469b2`, and its route test now verifies `404` so it cannot silently return as an accidental UI dependency.

### Contract export drift

The same contract freeze restored the API response envelopes, `Redactor`, and the future `AgentExecutionControl` boundary from overview Sections 8–9. The service-only logger interface moved into `service.ts` so it does not impose an implementation detail on other workstreams.

### Contracts merged before the contract gate

The domain types, interfaces, service, and routes were present before the contract gate. Commit `ea469b2` adds the missing shared deterministic artifacts, controls, fakes, module shells, construction test, and explicit contract corrections. Checkpoint 0 still requires the manual baseline and three-Agent checks.

### Shared conversation availability

The supplied ChatGPT share URL was inaccessible during this audit: the page reader could not fetch it, direct HTTP was stopped by a Cloudflare challenge, and the available browser runner requires Node 20 while the environment currently has Node 18. The implementation plan was therefore treated as authoritative, per the user request. If the shared conversation contains decisions absent from `overview.md`, copy those decisions into this file before freezing Checkpoint 0.

## Repository assumptions confirmed

- The project is TypeScript with ECMAScript modules.
- Fastify and Zod are the server route/validation pattern; React is the client.
- `AgentService.initialize()` marks queued/running Agent runs cancelled and busy Agents ready after restart.
- The JSON database is version 1 and `JsonStore` serializes mutations for a single process.
- The web client uses the existing API wrapper/polling style.
- Node.js 22+ and npm 10+ are repository prerequisites.

## Invariants that may not be weakened

- Exactly three distinct, pre-created Agents map to fixed roles.
- Backend state, never model prose, chooses the next role and terminal state.
- Artifacts are strict, bounded, versioned JSON and immutable after commit.
- Critic rejection is a committed workflow outcome; invalid/runtime output is an attempt failure.
- Only the active attempt and lease may commit.
- A timeout must settle/cancel the correlated Agent run before retrying the same Agent.
- Stops and restarts settle conservatively; late results are visible but ignored.
- Events and logs contain bounded, allowlisted, redacted metadata—not raw prompts or output.

## Mandatory workflow decisions

- Every task begins on a new task branch created from the intended current base. Direct implementation on `main` or the shared integration branch is prohibited.
- Every task consults `FILESYSTEM_MAP.md` first and limits file access to its mapped primary and justified conditional paths.
- All testing and verification runs through Docker Compose. Host Node/npm results are not accepted as completion evidence.
- Every completed development or implementation ends with a passing Docker Compose execution of `npm run check`; focused tests do not replace it.
- When any contract, phase instruction, file boundary, behavior, or acceptance criterion is unclear, work pauses for clarification. The answer is recorded before implementation resumes; assumptions are not silently substituted.
