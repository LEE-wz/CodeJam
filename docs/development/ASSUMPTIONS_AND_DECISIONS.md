# Relay Assumptions and Resolved Questions

**Last audited:** 2026-08-29  
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
