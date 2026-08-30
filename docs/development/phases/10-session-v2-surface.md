# Phase 10 — Session v2 Surface: Contract Amendment, Simplification, and Limits

**Goal:** make the product surface match the intended Session v2 shape — one workflow, one protocol, one name, ten participants — and amend the frozen contracts that forbid the rest of the plan, without deleting any working backend behaviour.  
**Ends at:** Checkpoint 10 — a ten-participant free-chat session is created, started, and completed from a UI that offers no verified-handoff and no countdown choice, while every server test still passes.

## Entry criteria

- A Phase 10 task branch has been created from the `main` tip that contains Checkpoint 8 (`2344f2c`).
- [`../plans/session-v2-plan.md`](../plans/session-v2-plan.md) has been read, and its six open questions have been answered and recorded.
- The Phase 10 paths in [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) have been reviewed; this phase adds them, so P10-02 is the first implementation task.
- Phases 0–8 are complete and their evidence is recorded in [`../STATUS.md`](../STATUS.md).
- Phase 9 is confirmed deferred to Phase 15; no release work is performed here.

If a frozen contract, an open-question answer, a limit value, or the treatment of historical runs is unclear, stop and ask for clarification. Do not encode an assumption in code, fixtures, or documentation.

## Required outputs

- An approved mini-RFC and the amended session contract authority.
- Filesystem-map coverage for Phases 10–15.
- Raised participant, turn, and context limits enforced identically in the routes, the service, and the workflow.
- A web app that offers only the shared-session workflow and only the free-chat protocol.
- The product renamed from Relay to Session in every user-visible surface.
- A web test suite rewritten for the reduced surface, plus one real ten-participant run.

## Tasks

### Contracts and access map

- [ ] **P10-01** Record a mini-RFC in [`../ASSUMPTIONS_AND_DECISIONS.md`](../ASSUMPTIONS_AND_DECISIONS.md) covering all six amendments in `plans/session-v2-plan.md` §3, then amend [`../overview-sessions.md`](../overview-sessions.md): Section 1 (countdown is no longer the headline demo; ordered coordination moves to a planned assignment in Phase 14), Section 2 (remove "parallel fan-out turns" from the non-goals; state that countdown is scheduled for deletion in Phase 14 and that free chat is the only creatable protocol from Phase 10), Section 4 (participants 2..10; `maxTurns` ceiling 100,000; note the new fields that Phases 12–14 will add), Section 6.5 (session termination becomes an explicit user action once Phase 12 lands), and Section 7 (create-contract ranges). Each amendment must state the phase that implements it, so the document never describes behaviour the code does not yet have. Do not amend [`../overview.md`](../overview.md): verified-handoff semantics are unchanged by this plan.
- [ ] **P10-02** Extend [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) with a primary/conditional path section for each of Phases 10–15, following the existing table and bullet conventions. Phase 10 primary paths are the web app under `apps/web/src/`, `apps/server/src/coordination/types.ts`, `routes.ts`, `service.ts`, `session-workflow.ts`, `context-builder.ts`, and their tests; conditional paths are the server fixtures under `coordination/testing/` and `apps/server/src/config.ts`. Later-phase sections may be sketched at the level of detail the corresponding sheet requires.

### Limits

- [ ] **P10-03** Raise the participant ceiling from 6 to 10. Change `SESSION_LIMITS.maxParticipants` in `coordination/types.ts`; change the `.max(6)` on the `agents` array in `sessionCreateRunBody` in `coordination/routes.ts`. `CoordinationService.createSessionRun` and `SharedSessionWorkflowV1.validateSessionView` already read `SESSION_LIMITS`, so they must not grow their own literals — confirm this by test rather than by inspection. Update every assertion that pins 6 (`coordination/api.test.ts`, `routes.test.ts`, `session-workflow.test.ts`, `session-contracts.test.ts`, `testing/session-fixtures.ts`) and add boundary cases at 2, 10, and 11 for both the route and the service.
- [ ] **P10-04** Raise the turn ceiling for session runs to 100,000. Add `maxSessionTurns: 100_000` and `defaultSessionTurns: 200` to `SESSION_LIMITS`, replace the free-chat `maxTurns` range in `sessionPolicySchema` (`coordination/routes.ts`) and in `CoordinationService.createSessionRun`, and keep the minimum at 3. The verified-handoff `validatePolicy` range (3..12) is not touched: this raise applies to session runs only, and a test must prove a verified run still rejects `maxTurns: 13`. Default `maxTurns` for a new session becomes `defaultSessionTurns`, not the old 6, so an accidental runaway is still bounded. Confirm by test that `run.nextTurnSequence`, event `sequence`, and the turn-ceiling comparison in `SharedSessionWorkflowV1` behave at values above 12 and above 65,535.
- [ ] **P10-05** Raise `DEFAULT_COORDINATION_POLICY.contextMaxChars` for session runs and window the transcript. Ten participants over a long session overflow the current 12,000-character budget, and the existing `FIELD_CAP_LADDER` in `coordination/context-builder.ts` degrades every message equally, which destroys a chat. Introduce a session-specific budget (recommend 40,000, configurable through `AppConfig`) and change the session branch of `buildArtifactSection` so it always renders the most recent `K` messages in full (recommend `K = max(2 × participantCount, 20)`) and drops or elides older ones from the top with an explicit `[earlier messages omitted]` marker, before the field-cap ladder is consulted. The verified-handoff branch keeps its existing ladder behaviour byte for byte. Prompt-digest stability for identical input must be preserved, and no expected-state or hidden-state leak may be introduced.

### Web surface

- [ ] **P10-06** Remove the verified-handoff surface from the web app. In `apps/web/src/RelayWorkspace.tsx` delete the workflow radio group, `FormMode`, the planner/critic/finalizer selects, the required-sections editor, `maxRevisions`, `ArtifactCard`, the non-session artifacts panel, and the verified branches of `validateForm` and `initialForm`. In `apps/web/src/coordination-types.ts` keep the `CreateCoordinationRunRequest` type only if a historical run still needs it to render, and delete the rest. The server retains `verified_handoff_v1` in full: no route, service, workflow, protocol, or test on the server side is changed by this task. Historical verified runs must still open without throwing — per the recorded answer to open question 2, either render them read-only with a "legacy workflow" banner or filter them out of the run index, but never crash on `policy.workflow === "verified_handoff_v1"`.
- [ ] **P10-07** Remove the countdown protocol from the web app only. Delete the protocol radio group, `sessionStartValue`, the countdown branches of `validateForm`, and the "next expected number" panel; every created session now sends `sessionProtocol: "free_chat"` (or omits it once the server default flips in Phase 14). Completed countdown runs created before this change must still render their transcript and their `sharedState`. The countdown branches in `session-workflow.ts`, `artifact-protocol.ts`, and `repository.ts` stay untouched and tested until Phase 14 deletes them, so a working ordered demo always exists on the branch.
- [ ] **P10-08** Rename the product from Relay to Session across every user-visible surface: the nav item and its `aria-current` target in `App.tsx`, the hero, empty states, notices, button labels, error copy, the `workspaceView` union value, and the `relay-*` CSS class prefix in `styles.css` (68 rules). Rename the component and its files: `RelayWorkspace.tsx` → `SessionWorkspace.tsx` and `RelayWorkspace.test.tsx` → `SessionWorkspace.test.tsx`. Per the recorded answer to open question 4, the HTTP surface `/api/coordination-runs` and the server-side `coordination*` module names are **not** renamed in this phase; record that decision in `ASSUMPTIONS_AND_DECISIONS.md` so the divergence between product name and API path is deliberate and documented.

### Tests and rehearsal

- [ ] **P10-09** Rewrite the web test suite for the reduced surface. Delete or convert the verified-handoff fixtures in `apps/web/src/testing/coordination-fixtures.ts` and the verified cases in the renamed workspace test; keep every session fixture (running, retry, consensus, withdrawal, stopped, failed, interrupted, completed). Add cases for a ten-participant picker, a `maxTurns` value above 12, a legacy verified run rendering under the chosen treatment, and a legacy countdown run rendering its transcript. Keyboard, label, focus-on-error, and responsive checks from P8-11 must survive the rename.
- [ ] **P10-10** Rehearse in the Compose browser deployment: create ten fresh demo Agents, run one free-chat session with all ten as participants to a bounded `maxTurns`, and record start-to-completion time, per-attempt durations, prompt sizes at the widest turn, and whether transcript windowing engaged. Record the redacted evidence and the latency conclusion in `STATUS.md`. If ten concurrent participants make round-robin latency unacceptable, say so plainly in the evidence — Phase 13 is where that is fixed, and the number is the input to its concurrency cap.

## Requirements and boundaries

- No server-side workflow, protocol, or repository behaviour is deleted in this phase. This phase removes UI surface and raises limits; deletion happens in Phase 14 once its replacement exists.
- Every limit has exactly one source of truth in `SESSION_LIMITS`, enforced at both the route and the service layer. HTTP validation is never the only enforcement.
- The verified-handoff server regression suite stays green and unmodified except where a shared limit constant legitimately moved.
- Old databases load unchanged. No migration, no new collection, no removed field.
- Prompts still never contain lease tokens, event data, auth material, or another Agent's raw output.
- Renaming is a rename: no behaviour change may ride along with P10-08.

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

Run focused web tests through Docker Compose first, then require the full Docker Compose `npm run check` before marking any implementation task complete. Use the Compose browser deployment for P10-10; capture a screenshot only after layout stabilises.

## Completion gate

Phase 10 is complete only when:

- the mini-RFC is approved and `overview-sessions.md` states which phase implements each amendment;
- `FILESYSTEM_MAP.md` covers Phases 10–15;
- a session with ten participants and a `maxTurns` above 12 can be created, started, and completed;
- the web app offers no workflow choice and no protocol choice, and no user-visible string says "Relay";
- legacy verified and countdown runs still render without error;
- the full server regression suite passes unmodified in behaviour;
- the final Docker Compose `npm run check` passes on the task branch.

## Handoff to Phase 11

Record the ten-participant timing evidence, the chosen legacy-run treatment, and the answered open questions in `STATUS.md`, and set `P11-01` as the next action. Phase 11 must not begin until the reservation decision (open question 1) is recorded, because it determines the shape of `P11-05`.
