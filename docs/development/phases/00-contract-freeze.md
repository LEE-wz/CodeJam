# Phase 0 — Baseline and Contract Freeze

**Goal:** produce one verified, compilable contract baseline from which every workstream can implement without redefining semantics.  
**Ends at:** Checkpoint 0 — contracts compile.  
**Time box:** 2–3 focused team hours after the environment works.

## Entry criteria

- A task branch has been created from the intended baseline before any edit.
- The Phase 0 paths in [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) have been reviewed; access stays within that map.
- Everyone is on the same commit and can identify the repository root.
- Node.js 22+ and npm 10+ are installed.
- The team has read scope, non-goals, ADRs, and Sections 7–11 of [`../overview.md`](../overview.md).
- Any context-only decisions missing from the overview have been copied into [`../ASSUMPTIONS_AND_DECISIONS.md`](../ASSUMPTIONS_AND_DECISIONS.md).

If the baseline application or tests fail before Relay changes, record the failure in `STATUS.md`; do not hide it inside Relay work.

If any contract, route behavior, task boundary, or expected evidence is unclear, stop and ask for clarification before proceeding. Record the answer in the decisions/status documentation.

## Required outputs

- Frozen `coordination/types.ts` and `coordination/contracts.ts`.
- Empty or minimal compilable modules for workflow, protocol, context, repository, runtime, events/redaction, service, and routes.
- Shared deterministic fixtures and fakes.
- One compile/construction test proving dependencies fit the service contract.
- A clean baseline verification record.
- Explicit resolution of every freeze question and deviation.

## Tasks

### Environment and baseline

- [x] **P0-01** Verify `node --version` is 22+ and `npm --version` is 10+.
- [x] **P0-02** Install from the checked-in lockfile. Prefer `npm ci` on a clean dependency tree; use `npm install` only when intentionally updating the lockfile.
- [x] **P0-03** Run `npm run check` before further Relay changes and record the result.
- [ ] **P0-04** Start the existing app and verify Agent list/create/edit/start/stop/delete and one Playground turn still work.
- [ ] **P0-05** Create three fresh demo Agents and prove one simple ordinary turn works for each. Do not put credentials or raw output in docs.

### Product and contract freeze

- [x] **P0-06** Confirm fixed Planner → Critic → Finaliser workflow, exactly three distinct pre-created Agents, sequential turns, and explicit non-goals.
- [x] **P0-07** Review ADR-01 through ADR-14 and default limits. Confirm code spelling `finalizer` and the UI label “Finaliser.”
- [x] **P0-08** Diff `types.ts` and `contracts.ts` against overview Sections 7 and 9. Correct accidental drift through an approved mini-RFC.
- [x] **P0-09** Confirm API route/envelope/status semantics. Resolve the extra `/events` endpoint noted in the decisions file.
- [x] **P0-10** Confirm parsing, retry versus revision, maximum revisions, stop, restart, reservation, lease, and stale-result semantics.
- [x] **P0-11** Tag or record the accepted contract commit as `relay/contracts-v1` (a Git tag or immutable commit reference is sufficient).

### Shared implementation scaffolding

- [x] **P0-12** Add compilable module shells for `workflow.ts`, `schemas.ts`, `artifact-protocol.ts`, `context-builder.ts`, `repository.ts`, `runtime-gateway.ts`, `events.ts`, and `redaction.ts` as applicable.
- [x] **P0-13** Add a fixed/advancing clock and deterministic generator for run, turn, attempt, artifact, event, and lease IDs.
- [x] **P0-14** Add three stable Agent fixtures, one objective, and three required sections.
- [x] **P0-15** Add valid proposal, rejecting review, approving review, and final artifact fixtures plus at least one invalid output.
- [x] **P0-16** Add shared fake repository and scripted runtime contracts. Unused methods may fail loudly with `NotImplemented`.
- [x] **P0-17** Add a compile-only construction test for `CoordinationService` using all fake dependencies.

## Requirements and review rules

- Frozen exports match the overview or an approved mini-RFC.
- Fixtures contain no random time, IDs, network calls, or secrets.
- Contract files contain no implementation-specific dependencies that force one workstream's design on another.
- No real Agent/model call occurs in automated tests.
- Existing single-Agent behavior remains unchanged.

## Verification

Run all checks through Docker Compose. Focused commands may be used during implementation, but before marking any `P0-*` task complete run the standard full check from the runbook:

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

Then manually confirm the baseline app and the three fresh Agents. Record command, date, commit, and result in `STATUS.md`.

## Completion gate

Phase 0 is complete only when:

- all `P0-*` tasks are complete or explicitly marked non-applicable by an approved decision;
- baseline application and existing tests pass;
- new contracts and module shells compile;
- shared fixture/fake construction test passes;
- every workstream can import its contracts from the same commit;
- no unresolved semantic question remains about rejection/retry, limits, stop, leases, stale output, or route envelopes.
- the final Docker Compose `npm run check` passes on the task branch.

## Handoff to Phase 1

Record the frozen commit and set the next action to `P1-01`. Workstreams branch from the frozen commit. Any later contract change uses the five-line mini-RFC process.
