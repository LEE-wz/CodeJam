# Phase 4 — End-to-End UI and Evidence Experience

**Goal:** let a user configure, start, observe, stop, and understand a Relay run without reading server logs.  
**Ends at:** Checkpoint 4 — real create/start/poll/detail/stop flow with understandable normal and failure evidence.

## Entry criteria

Preflight status on `codex/phase4-preflight-cleanup`: the Phase 3 checkpoint is
stable, API strings are frozen, and the reusable lease-free fixture matrix is
in `apps/server/src/coordination/testing/phase4-response-fixtures.ts`. The
automated/web-browser test split is recorded in
[`../ASSUMPTIONS_AND_DECISIONS.md`](../ASSUMPTIONS_AND_DECISIONS.md). These are
preconditions only; no `P4-*` task is complete yet.

- A Phase 4 task branch has been created from the completed real-runtime checkpoint.
- The Phase 4 paths in [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) have been reviewed and server internals remain out of scope except as read-only API references.
- Phase 3 real runtime is stable.
- API envelopes and status/event strings are frozen.
- Redacted fixtures exist for normal, rejection, retry/timeout, stopped, failed, and interrupted runs.
- Existing `api.ts` auth/error and `App.tsx` ownership patterns have been reviewed.

If an API envelope, UI state, polling rule, accessibility expectation, or file boundary is unclear, stop and ask for clarification rather than inventing client behavior.

## Required outputs

- API-facing client types and calls.
- Creation form with role/policy validation.
- Run list/detail, timeline, attempts, decisions, and artifacts.
- Safe active polling and stop interaction.
- Responsive, accessible integration into the existing app.
- UI/manual checks for all fixture states and one real run.

## Tasks

### Client contracts and form

- [ ] **P4-01** Add an API-facing coordination type subset; keep it aligned with response envelopes without importing server internals.
- [ ] **P4-02** Add list/create/detail/start/stop calls using existing bearer/auth and error conventions.
- [ ] **P4-03** Build fields for name, objective, required sections, Planner/Critic/Finaliser selectors, and optional safe policy controls.
- [ ] **P4-04** Validate exactly three distinct ready Agents, unique section keys, input bounds, and policy ranges client-side while retaining server authority.
- [ ] **P4-05** Preserve form input on errors and make create→start two visible operations. Automatic start occurs only after successful create.

### Detail, timeline, and artifacts

- [ ] **P4-06** Display run status/phase/revision, role mappings, limits, and actionable terminal errors.
- [ ] **P4-07** Render events ordered and grouped by turn, with attempts nested and retry versus revision visually distinct.
- [ ] **P4-08** Render proposal/review/final artifacts, including clear approve/reject state, as escaped text. Do not use raw HTML.
- [ ] **P4-09** Provide safe empty/loading/error/long-content states and stable labels/colors for status, role, and event types.

### Polling and stop

- [ ] **P4-10** Poll detail every 1–2 seconds only while active; ensure one timer/request chain and clean up on terminal state, selection change, and unmount.
- [ ] **P4-11** Add stop with pending/disabled state and reconcile the returned terminal status without multiplying requests.
- [ ] **P4-12** Test or manually prove normal, rejection, retry, timeout, stopped, interrupted, failed, and completed views.

### App integration and accessibility

- [ ] **P4-13** Integrate minimally through the single `App.tsx` owner and preserve all current Agent/Playground features.
- [ ] **P4-14** Verify keyboard operation, associated labels, focus/error behavior, contrast, and screen-reader-meaningful status text.
- [ ] **P4-15** Verify laptop judge resolution and narrow responsive layout; cut animation/filtering before core evidence.
- [ ] **P4-16** Run one real end-to-end create/start/poll/complete flow and one stop flow from the browser.

## Requirements and boundaries

- The UI never decides routing, validates acceptance, or synthesizes events.
- UI code never receives auth secrets beyond the existing app convention and never renders leases/raw prompts.
- Polling stops at terminal state and cannot accumulate intervals.
- Artifact text is escaped; Markdown is allowed only if an existing safe renderer is configured.
- Failure states must be understandable without server logs.
- Existing single-Agent CRUD and Playground remain usable.

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

Run available web tests through Docker Compose, then require the full Docker Compose `npm run check` above before marking each implementation task complete. Use the fixture matrix and a browser against the Compose deployment. Capture a screenshot only after layout stabilizes and only if useful for README/demo evidence.

## Completion gate

Phase 4 is complete only when:

- a user can select three Agents, create/start a run, and observe all phases;
- proposal/review/final artifacts and middleware decisions are clear;
- stop works and polling cleans up;
- at least one failure/retry fixture is legible without logs;
- keyboard/labels and responsive layout pass the checklist;
- existing app features and the real happy path remain functional.
- the final Docker Compose `npm run check` passes on the task branch.

## Handoff to Phase 5

Freeze UI scope, select stable demo fixtures/assets, and set `P5-01` as the next action. From here, prefer documentation, tests, rehearsal, and release blockers over new features.
