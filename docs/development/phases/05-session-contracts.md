# Phase 5 — Session Contracts and Freeze

**Goal:** approve the session mini-RFC, land the additive session contract types, schemas, and fixtures, and prove the extended contracts compile without changing any verified-handoff behavior.  
**Ends at:** Checkpoint 5 — session contracts compile.  
**Time box:** 2–3 focused team hours.

## Entry criteria

- A Phase 5 task branch has been created from `main` (which now includes the merged Phase 4 tip `139019b`).
- The Phase 5 paths in [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) have been reviewed; access stays within that map.
- Phases 0–4 are complete with recorded evidence in [`../STATUS.md`](../STATUS.md).
- The team has read [`../overview-sessions.md`](../overview-sessions.md) (the session contract authority) and the team's extension plan referenced there.
- The team has re-read overview.md Sections 4 and 6–11 only where session work must align with engine semantics.
- Any context-only decision has been copied into [`../ASSUMPTIONS_AND_DECISIONS.md`](../ASSUMPTIONS_AND_DECISIONS.md).

If a contract detail, route shape, task boundary, or expected evidence is unclear, stop and ask for clarification before proceeding. Record the answer in the decisions/status documentation.

## Required outputs

- Team approval of the session mini-RFC and resolution of every open decision in overview-sessions.md Section 11.
- Additive session domain types in `coordination/types.ts` (role, phase, turn kind, artifact type, workflow kind, policy field, `SessionMessagePayload`, `run.sharedState`).
- Additive session contract interfaces in `coordination/contracts.ts` (workflow dispatch, session workflow contract, create request union).
- Shared session fixtures in `coordination/testing/**` (participant Agents, transcripts, valid and wrong numbers).
- One construction/compile test proving the service can dispatch both workflows from fake dependencies.
- A recorded session contract commit reference.

## Scope amendment (team-approved, P5-02)

Adding the session enum members breaks compile-time exhaustiveness in tables
outside this phase's filesystem map, because the codebase uses
`Readonly<Record<CoordinationTurnKind, ...>>` and
`Readonly<Record<ArtifactType, ...>>` style tables. This phase's compile gate
cannot pass otherwise.

Phase 5 may therefore edit those files for **one purpose only**: adding loud
placeholder entries that throw at runtime and name the task that replaces them.
Placeholders must never look like working instructions. No real session
instruction, prompt, routing, or validation is written here.

Placeholders are **getters, not IIFEs**. An IIFE in an object literal evaluates
at module load and would throw on import, taking the server and the whole test
suite with it. A getter satisfies the same `Record` type and throws only when
the session entry is read.

Amended tables and their replacing task: `context-builder.ts`
`TASK_INSTRUCTIONS`, `OUTPUT_SHAPES`, `OUTPUT_LIMITS`, `ROLE_VISIBILITY` (P6-07);
`events.ts` `ROLE_LABELS`, `TURN_KIND_LABELS` (P6-01); `artifact-protocol.ts`
`EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND` (P6-05); `workflow.ts` local
`expectedOutput` (P6-01). The last was found by the typecheck and is additional
to the amendment's original list. `session-placeholders.test.ts` proves each one
throws.

Out of scope by instruction, and **not** fixed: `repository.ts`
`expectedArtifactTypeForTurn` (P7-02 now converts it to an exhaustive typed map
so the compiler enforces the case) and `context-builder.ts` `capPayload` (P6-07
adds the explicit `session_message` branch). Both accept the new members with no
compile error, so neither the build nor the test suite will remind anyone they
are outstanding. See [`../ASSUMPTIONS_AND_DECISIONS.md`](../ASSUMPTIONS_AND_DECISIONS.md).

`service.ts` is edited outside the amendment for the create dispatch and minimal
session create, because P5-07's construction test requires them.

## Tasks

### Team approval and decisions

- [x] **P5-01** Read [`../overview-sessions.md`](../overview-sessions.md) together. Approve the mini-RFC or record amendments. Settle the open decisions in its Section 11 (defaults are listed). Record everything in [`../ASSUMPTIONS_AND_DECISIONS.md`](../ASSUMPTIONS_AND_DECISIONS.md).
- [x] **P5-02** Confirm the nine-phase plan and checkpoint numbering: Phase 5 → Checkpoint 5, ..., Phase 8 → Checkpoint 8, Phase 9 (release) → Checkpoint 9. Confirm this phase owns the `P5-xx` task prefix and the release phase now owns `P9-xx`.

### Additive contract code

- [x] **P5-03** Add to `coordination/types.ts`: `"participant"` role, `"sessioning"` phase, `"session_turn"` turn kind, `"session_message"` artifact type, `CoordinationWorkflowKind`, `policy.workflow` as the workflow kind (keep `DEFAULT_COORDINATION_POLICY` set to `"verified_handoff_v1"`), `policy.sessionStartValue?` (countdown), `policy.sessionProtocol?` (`"countdown"` default, `"free_chat"`), `SessionMessagePayload` (content 1..500), and optional `run.sharedState`. Do not change any existing type member.
- [x] **P5-04** Add to `coordination/contracts.ts`: `CreateSessionRunRequest` (workflow `"shared_session_v1"`, ordered `agents: AgentId[]`, optional session policy), a widened `createRun` input union, a `SharedSessionWorkflow` contract reusing `WorkflowDecision`, and a workflow dispatch contract that maps `run.policy.workflow` to the decision source. Additive only; the `VerifiedHandoffWorkflow` contract is untouched.
- [x] **P5-05** Add session fixtures to `coordination/testing/**`: three or four participant Agent fixtures with ordered IDs and name snapshots; a committed 10-to-1 transcript fixture; valid `session_message` artifacts; wrong-number raw outputs (for example `"6"` when the expected number is 8); free-chat message fixtures; the expected event sequence for a normal countdown run and a normal free-chat run; a fixed `sessionStartValue`. Fixtures contain no random time, IDs, network calls, or secrets.
- [x] **P5-06** Confirm the existing deterministic clock, ID generator, and scripted runtime already cover session needs. Extend them additively only where a session-specific control is genuinely missing, and record the reason.
- [x] **P5-07** Add a construction/compile test: `CoordinationService` is constructed with both workflows registered in the dispatch; a session create produces a `created` run with `phase: "sessioning"` and `sharedState.nextExpectedNumber` initialized from `sessionStartValue`; verified-handoff fixtures and construction tests still pass unchanged.
- [x] **P5-08** Record the accepted session contract commit as an immutable commit reference (and an optional convenience tag) in `STATUS.md`, mirroring P0-11.

## Requirements and review rules

- All changes are additive; no existing type member, route, persisted shape, or verified-handoff behavior changes.
- The session workflow can never be selected for a verified run and vice versa.
- Fixtures contain no secrets and no nondeterminism.
- Contract files contain no implementation-specific dependencies that force one workstream's design on another.
- No real Agent/model call occurs in automated tests.
- Existing single-Agent and verified-handoff behavior remains unchanged; all 389 existing tests stay green.

## Verification

Run all checks through Docker Compose. Focused commands may be used during implementation, but before marking any `P5-*` task complete run the standard full check from the runbook:

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

Record command, date, commit, and result in `STATUS.md`.

## Completion gate

Phase 5 is complete only when:

- all `P5-*` tasks are complete or explicitly marked non-applicable by an approved decision;
- the team approval and every open decision are recorded;
- session contracts and fixtures compile and the construction test passes;
- every existing test passes unchanged;
- no unresolved semantic question remains about countdown validation, retry on the same Agent, completion at 1, turn ceilings, participant limits, workflow defaulting, or shared-state visibility;
- the final Docker Compose `npm run check` passes on the task branch.

## Completion record

Phase 5 is complete. Checkpoint 5 was verified on 2026-08-30 by the standard
scoped Docker Compose `npm run check`: exit 0, server and web typechecks,
23 server test files with 399 tests, 2 web test files with 12 tests, and both
builds. 411 tests total — the 389-test baseline intact, plus 22 new. The run
used a clean working tree, so the source it tarred is exactly the frozen commit.

Frozen session contract commit: **`2fe14eb`**. No convenience tag was created;
that remains an explicit team decision.

On 2026-08-30 the whole team confirmed the free-chat completion signal
(unanimous `done`) and the final-artifact-pointer rule (last committed session
message); see [`../ASSUMPTIONS_AND_DECISIONS.md`](../ASSUMPTIONS_AND_DECISIONS.md).
The Phase 6 sheet already encodes both.

## Handoff to Phase 6

Record the frozen session contract commit and set the next action to `P6-01`. Freeze the session fixture behavior; any later contract change uses the five-line mini-RFC process.
