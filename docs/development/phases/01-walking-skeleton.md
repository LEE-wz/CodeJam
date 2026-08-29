# Phase 1 — In-Memory Walking Skeleton

**Goal:** prove all Relay workflow semantics end to end using deterministic in-memory dependencies before disk, HTTP, or model latency complicates debugging.  
**Ends at:** Checkpoint 1 — real service/workflow/protocol/context with fake repository and scripted runtime.

## Entry criteria

- A Phase 1 task branch has been created from the recorded frozen contract commit.
- The Phase 1 paths in [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) have been reviewed and no unrelated paths will be accessed.
- Phase 0 is complete and its frozen commit is recorded.
- Shared fixtures, fake repository, and scripted runtime compile.
- Changes to contracts require the mini-RFC process.

If workflow semantics, schema behavior, context visibility, or expected test evidence is unclear, stop and ask for clarification. Do not encode an assumption in code or fixtures.

## Required outputs

- Pure verified-handoff workflow and exhaustive routing tests.
- Strict artifact schemas/parser and protocol tests.
- Role-scoped, bounded context builder and digest tests.
- Scripted runtime supporting success, invalid, failure, timeout, cancellation, and deferred completion.
- Service lifecycle/orchestration using those components.
- In-memory evidence sufficient to explain retries and revisions.

## Tasks

### Pure workflow

- [x] **P1-01** Implement deterministic selectors for the latest committed proposal, review, and final artifact by turn sequence.
- [x] **P1-02** Route new run → Planner, proposal → Critic, rejection → Planner revision, approval → Finaliser, and final artifact → complete.
- [x] **P1-03** Enforce `maxRevisions` and `maxTurns`; map impossible durable state to safe `INVALID_STATE` failure.
- [x] **P1-04** Add table tests for every routing branch and boundary. No repository, clock, or runtime is allowed in these tests.

### Artifact protocol

- [x] **P1-05** Implement strict, bounded Zod schemas for proposal, review, and final payloads.
- [ ] **P1-06** Enforce the parsing order: output size, optional single outer JSON fence, JSON parse, expected type/version, schema, then cross-field/coverage rules.
- [ ] **P1-07** Enforce required proposal section keys exactly once, reject/approve issue consistency, non-empty final content, and backend-owned provenance.
- [ ] **P1-08** Test plain/fenced valid JSON, commentary, malformed/wrong type, unknown fields, oversize output, section coverage/duplicates, inconsistent reviews, and Agent-forged IDs.

### Scoped context builder

- [ ] **P1-09** Implement the backend contract header and templates for initial proposal, critique, revision, and finalization.
- [ ] **P1-10** Include only the context allowed by the role matrix: initial none; Critic latest proposal; revising Planner latest proposal plus rejecting review; Finaliser approved proposal plus approving review.
- [ ] **P1-11** Add canonical serialization, stable digest, deterministic size handling, and retry feedback containing only safe validator/runtime feedback.
- [ ] **P1-12** Test excluded superseded artifacts and absence of raw prompts, events, auth data, leases, Agent thread IDs, and unrelated state.

### Scripted runtime and orchestration

- [ ] **P1-13** Implement queued scripted outcomes and captured calls, including manually resolvable deferred calls for races.
- [ ] **P1-14** Implement service create/list/detail validation and one local loop per run.
- [ ] **P1-15** Implement schedule → attempt → runtime → validate → lease commit with state reload between durable transitions.
- [ ] **P1-16** Implement bounded retry feedback, terminal completion/failure, safe top-level catch, active-loop cleanup, and stop cancellation.
- [ ] **P1-17** Test normal approval, reject/revise/approve, invalid→retry→success, invalid twice, timeout→retry, failure twice, stale commit, duplicate start, and stop during a deferred attempt.

## Requirements and boundaries

- Workflow/protocol/context code is pure and has no global mutable state.
- Routing never depends on arbitrary Agent prose.
- Parser does not extract “best effort” JSON from surrounding commentary.
- Critic rejection increments workflow revision but does not consume a retry.
- Retry uses the same role Agent and logical turn.
- Automated tests use no disk, HTTP, arbitrary sleeps, or real model.
- Prompts may be inspected in fixtures but are not persisted in production records.

## Verification

Run focused coordination unit tests through Docker Compose as needed. Before marking each implementation task complete, run the repository-wide check through Docker Compose:

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

If the test runner does not support the shown filter, run the specific test files followed by the full server test command and update this sheet with the verified syntax.

## Completion gate

Phase 1 is complete only when:

- every real workflow/protocol/context branch is tested;
- the real service completes both normal and rejection/revision paths with fake dependencies;
- invalid output visibly retries once and exhaustion fails safely;
- stale/deferred output cannot progress the run;
- no real persistence, HTTP server, or Agent is needed;
- full pre-existing server tests remain green.
- the final Docker Compose `npm run check` passes on the task branch.

## Handoff to Phase 2

Freeze fixture behavior used by repository/API tests. Set `P2-01` as the next task and do not connect real Agents until all Phase 2 race gates pass.
