# Phase 7 — Durable Session Backend and API

**Goal:** persist session runs atomically through the existing repository and expose the session create variant through Fastify, while keeping the scripted runtime and leaving every verified-handoff behavior intact.  
**Ends at:** Checkpoint 7 — durable session runs complete with fake runtime and the session API surface passes race and injection tests.

## Entry criteria

- A Phase 7 task branch has been created from the latest completed integration checkpoint.
- The Phase 7 paths in [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) have been reviewed and access is limited accordingly.
- Phase 6 semantics pass entirely in memory.
- Frozen session contracts and fixtures from Phase 5 are available.
- Real Agent execution remains disconnected (scripted runtime only).

If atomicity, event data, reservation semantics, API validation, or allowed file access is unclear, stop and ask for clarification before implementing.

## Required outputs

- Repository commit case for `session_message` that decrements `sharedState.nextExpectedNumber` in the same atomic mutation.
- `expectedArtifactTypeForTurn` coverage for `session_turn`, plus a sweep of every exhaustive switch touched by the new enum members.
- Session create-body union in the routes with the validation rules from overview-sessions.md Section 7.
- Composition-root wiring of the session workflow and dispatch.
- Race, restart, API, and evidence-timeline tests for session runs.

## Tasks

### Atomic repository

- [ ] **P7-01** Implement the commit case for `session_message`. For countdown runs, on accepting a message with value `n`, set `run.sharedState.nextExpectedNumber = n - 1` in the same `JsonStore.mutate()` that settles the attempt and turn, stores the immutable artifact, updates pointers and version, and appends events. For free-chat runs the same mutation stores the artifact and settles the attempt and turn with no shared-state update. The lease and status checks are byte-for-byte the existing ones; no new race semantics are introduced.
- [ ] **P7-02** Add the `session_turn` case to `expectedArtifactTypeForTurn` returning `"session_message"`. Sweep every exhaustive switch over `CoordinationRole`, `CoordinationPhase`, `CoordinationTurnKind`, and `ArtifactType` (including the workflow expected-output map and event guards) and add the missing cases without changing existing behavior.
- [ ] **P7-03** Add race and restart tests using deferred promises, not sleeps: wrong lease is stale; a previous attempt cannot commit after a retry starts; stop-versus-commit; duplicate completion; concurrent commits; restart interruption settles active session runs with `SERVER_RESTARTED`; per-run event sequence stays gapless.

### API and composition

- [ ] **P7-04** Implement the create-body union in `coordination/routes.ts`: `workflow` optional and defaulting to `"verified_handoff_v1"`; the session variant validates an ordered `agents` array of 2..6 distinct IDs, `sessionProtocol` (`"countdown"` default, `"free_chat"`), countdown `sessionStartValue` 2..12 with `maxTurns >= sessionStartValue`, free-chat `maxTurns` 3..12 with `sessionStartValue` forbidden, absent or empty `requiredSections`, and rejection of `maxRevisions`. The verified body shape is accepted unchanged.
- [ ] **P7-05** Mirror every session rule in the service create path so HTTP validation is never the only enforcement.
- [ ] **P7-06** Add Fastify injection tests for the session surface: create `201`, start `202`, detail with `sharedState` and without leases; every session and protocol validation `400`; `404` unknown Agent; `409` `AGENT_NOT_READY` and `AGENT_RESERVED`; `413` oversized body; auth required; safe `500`.
- [ ] **P7-07** Wire the composition root: construct `SharedSessionWorkflowV1`, register the workflow dispatch in `index.ts`, and initialize coordination exactly as today. No new dependencies are added.
- [ ] **P7-08** Add evidence-timeline fixture tests: the detail response for normal countdown, wrong-number retry, free-chat completion, stopped, and interrupted session fixtures is ordered and coherent, with every event type in the frozen set.
- [ ] **P7-09** Verify reservation inheritance with tests: a session run reserves all of its participants through the existing derived reservation; reservations release on terminal settlement; two runs with overlapping participants cannot both start; verified-path reservation tests remain green.

## Requirements and invariants

- All concurrency decisions occur inside one `JsonStore.mutate()`; HTTP prechecks are advisory only.
- Artifact acceptance checks active run, active turn/attempt, attempt status, and opaque lease together, unchanged.
- No new database collections and no migration: `sharedState` is an optional run field on the existing v2 shape.
- Existing v1 data is never discarded; session runs reuse the existing migration and reload paths.
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

Phase 7 is complete only when:

- session commit, lease, stop/commit, restart, and terminal immutability tests pass;
- session create/start/detail/stop work through HTTP against the real repository;
- the detail response for session fixtures contains ordered turns, attempts, artifacts, `sharedState`, and redacted events;
- the composition root starts with both workflows registered and the scripted runtime;
- reservation inheritance for session runs is proven;
- the full existing server regression suite passes;
- no real Agent has been connected prematurely;
- the final Docker Compose `npm run check` passes on the task branch.

## Handoff to Phase 8

Record a durable fake-runtime session demonstration and a redacted completed session fixture, and set `P8-01` as the next task. If any lease/race test is flaky, remain in Phase 7.
