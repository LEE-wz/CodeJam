# Phase 2 — Durable Backend and Evidence Ledger

**Goal:** replace in-memory state with an additive, atomic repository and expose the complete asynchronous lifecycle through Fastify while retaining the scripted runtime.  
**Ends at:** Checkpoint 2 — real JSON store/repository/routes with fake runtime and passing race/restart tests.

## Entry criteria

- A Phase 2 task branch has been created from the latest completed integration checkpoint.
- The Phase 2 paths in [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) have been reviewed and access is limited accordingly.
- Phase 1 semantics pass entirely in memory.
- Frozen database/API contracts and event types are available.
- A realistic copy of a v1 database fixture exists.
- Real Agent execution remains disconnected.

If migration behavior, atomicity, event data, reservation semantics, API status, or allowed file access is unclear, stop and ask for clarification before implementing.

## Required outputs

- Database v2 and lossless v1→v2 migration.
- Atomic coordination repository with active-lease enforcement.
- Agent reservation query/guard contract.
- Redacted event factories integrated into every state transition.
- Real create/list/detail/start/stop routes and composition wiring using scripted runtime.
- Concurrency, restart, API, authentication, and regression tests.

## Tasks

### Database and migration

- [x] **P2-01** Define `DatabaseV2` with additive coordination collections and optional Agent-run correlations.
- [x] **P2-02** Parse v1 explicitly, migrate without losing or rewriting existing Agent/message/run values, and make new empty databases v2.
- [x] **P2-03** Load and persist v2; reject malformed/future versions before any write.
- [x] **P2-04** Test empty startup, realistic v1 migration, v2 reload, field/timestamp preservation, and unsupported-version non-overwrite.

### Events and redaction

- [x] **P2-05** Implement pure event factories for every frozen type with stable, short display messages.
- [x] **P2-06** Implement an allowlist redactor for token/header/cookie patterns, bounded strings/arrays, and permitted detail keys.
- [x] **P2-07** Test that lease tokens, raw prompts/output, unknown objects, and oversized secret-bearing values cannot enter events.

### Atomic repository

- [x] **P2-08** Implement deterministic newest-first run lists (cap 50) and sorted detail reads.
- [x] **P2-09** Atomically create/start runs, validate readiness, derive reservations from non-terminal runs, schedule turns, begin attempts, and append per-run ordered events.
- [x] **P2-10** Attach Agent run correlation only to the active lease.
- [x] **P2-11** Atomically finish attempts and commit accepted artifacts only when run/turn/attempt statuses and lease all match.
- [x] **P2-12** Atomically update pointers, version, turn, attempt, immutable artifact, and evidence events in one mutation.
- [x] **P2-13** Implement request/finish stop, complete, fail, and interrupt-active-run commands with terminal-state immutability.
- [x] **P2-14** Test concurrent starts, overlapping/disjoint participants, wrong/previous lease, timeout-late commit, stop/commit race, duplicate completion, event sequence, and terminal overwrite prevention using deferred promises—not sleeps.

### API and composition

- [x] **P2-15** Validate strict create inputs, unique sections/Agents, policy ranges, UUID params, and safe error envelopes.
- [x] **P2-16** Verify list/create/detail/start/stop statuses, auth, `404`, `409`, body limit, and safe `500` through Fastify injection.
- [x] **P2-17** Construct real workflow/context/protocol/repository plus scripted runtime in `index.ts`; initialize coordination after `AgentService`; pass it into `createApp`.
- [x] **P2-18** Add structured logs with run/turn/attempt identifiers and no prompt/output/lease content.
- [x] **P2-19** Confirm stop semantics and resolve/remove the non-contract `/events` endpoint.

### Restart and reservation readiness

- [x] **P2-20** On initialization, settle running/stop-requested coordination runs, their turns/attempts, and append `run.interrupted` with `SERVER_RESTARTED`.
- [x] **P2-21** Expose the reservation helper needed by `AgentService`; test release after completed/failed/stopped/interrupted states.
- [x] **P2-22** Confirm the detail response is a coherent evidence timeline for normal, reject, retry, stopped, interrupted, and failed fixtures.

## Requirements and invariants

- All concurrency decisions occur inside one `JsonStore.mutate()`; HTTP prechecks are advisory only.
- Artifact acceptance checks active run, active turn/attempt, attempt status, and opaque lease together.
- Expected races return discriminated `stale`/`conflict`, not generic exceptions or corrupt state.
- Artifact/event/state changes are one atomic mutation.
- Existing v1 data is never discarded and future versions are never overwritten.
- Single backend process remains an explicit MVP limitation.

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

All focused repository race and API tests also run through Docker Compose. Execute the race suite repeatedly and inspect only a safe temporary migrated database. Before marking every implementation task complete, require the full Docker Compose `npm run check` above to pass. Use Fastify injection for API checks; keep the runtime scripted.

## Completion gate

Phase 2 is complete only when:

- migration, leases, concurrent starts, stop/commit, restart, and terminal immutability tests pass;
- create/start/detail/stop work through HTTP against the real repository;
- the detail response contains ordered turns, attempts, artifacts, and redacted events;
- composition root can start with a scripted runtime;
- the full existing server regression suite passes;
- no real Agent has been connected prematurely.
- the final Docker Compose `npm run check` passes on the task branch.

## Handoff to Phase 3

Record a durable fake-runtime demonstration and set `P3-01` as the next task. If any lease/race test is flaky, remain in Phase 2.
