# Phase 8 — Session UI and Real Rehearsal

**Goal:** let a user create and watch a shared-session countdown without reading server logs, and prove one real 10-to-1 run plus one honest wrong-number recovery in the browser.  
**Ends at:** Checkpoint 8 — a real 10-to-1 session completes in the browser while the verified workflow still works.

## Entry criteria

- A Phase 8 task branch has been created from the completed durable-session checkpoint.
- The Phase 8 paths in [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) have been reviewed and server internals remain out of scope except as read-only API references.
- Phase 7 durable session and API gates pass with the scripted runtime.
- API envelopes and status/event strings are frozen, including the session additions.
- Redacted session fixtures exist for normal, wrong-number retry, stopped, failed, and interrupted runs.
- Existing `api.ts` auth/error and `App.tsx` ownership patterns have been reviewed.

If an API envelope, UI state, polling rule, accessibility expectation, or file boundary is unclear, stop and ask for clarification rather than inventing client behavior.

## Required outputs

- API-facing session types and create calls.
- Creation form mode toggle with the session fields.
- Chat-like transcript view with shared-state display.
- Session-aware timeline labels and validation-error visibility.
- Browser fixture tests plus one real 10-to-1 run and one honest wrong-number recovery.

## Tasks

### Client contracts and form

- [x] **P8-01** Mirror the session subset in `apps/web/src/coordination-types.ts`, aligned with response envelopes and without importing server internals.
- [x] **P8-02** Add session create/start/detail/stop handling to `coordination-api.ts` using the existing bearer/auth and error conventions.
- [x] **P8-03** Add a mode toggle to the create form: verified handoff (existing, unchanged) and shared session (new). Existing fields and behavior in verified mode stay exactly as they are.
- [x] **P8-04** Build session fields: protocol selector (countdown or free chat), ordered participant picker (2..6 ready Agents; selection order is the turn order), `sessionStartValue` (2..12, default 10, countdown only), name, objective, `maxTurns` (free-chat default 6), and timeout.
- [x] **P8-05** Validate client-side: participant count and distinctness, readiness, protocol choice, countdown start-value range and `maxTurns >= sessionStartValue`, free-chat `maxTurns` range, while retaining server authority. Preserve input on errors and keep create then start as two visible operations.

### Transcript and evidence

- [x] **P8-06** Render the session transcript: a chronological list where each committed message shows the Agent name, content, and attempt badges. Display `sharedState.nextExpectedNumber` as the shared-state evidence for countdown runs; free-chat runs show no expected number, but show each participant's latest `done` signal (for example a small badge) so the consensus forming is visible.
- [x] **P8-07** Render session turns in the existing timeline with participant labels, and surface protocol validation errors (for countdown, the retry-safe `Expected the next number <N>, received <X>` message) so a rejection is understandable without logs.
- [x] **P8-08** Escape all artifact text (no raw HTML), provide safe empty/loading/error/long-content states, and add session-specific status labels consistent with the existing design.

### Polling, integration, and accessibility

- [x] **P8-09** Reuse the single 1.5-second polling chain; prove it cleans up on session terminal states, selection change, and unmount, and that stop reconciles without multiplying requests.
- [x] **P8-10** Integrate through the single `App.tsx` owner and preserve all current Agent/Playground features.
- [x] **P8-11** Add fixture tests for session states (normal transcript, wrong-number retry, free-chat transcript, free-chat done-consensus states: partial, unanimous, withdrawn, stopped, failed, interrupted, completed) plus keyboard, labels, error focus, and responsive checks.

### Real rehearsal

- [x] **P8-12** Complete one real 10-to-1 session run and one short free-chat run (bounded `maxTurns` or a unanimous `done` round) in the browser using fresh demo Agents on the fastest available model endpoint, then run one verified-workflow regression.
- [x] **P8-13** Demonstrate the live wrong-number failure: one demo Agent is created with a base instruction that occasionally subtracts two instead of one. The middleware rejects the wrong number, retries, and the run recovers or fails with clear evidence. The Agent genuinely misbehaved; the middleware genuinely caught it. Never simulate middleware behaviour.
- [x] **P8-14** Measure per-turn and total timings; record redacted evidence and the latency conclusion in `STATUS.md`; confirm the Phase 9 demo-budget mitigations from overview-sessions.md Section 10.

## Requirements and boundaries

- The UI never decides routing, validates acceptance, or synthesizes events.
- UI code never receives auth secrets beyond the existing app convention and never renders leases or raw prompts.
- Polling stops at terminal state and cannot accumulate intervals.
- Artifact text is escaped; Markdown is allowed only if an existing safe renderer is configured.
- Failure states must be understandable without server logs.
- Existing single-Agent CRUD, Playground, and the verified-handoff form remain usable.

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

Run available web tests through Docker Compose, then require the full Docker Compose `npm run check` above before marking each implementation task complete. Use the session fixture matrix and a browser against the Compose deployment. Capture a screenshot only after layout stabilizes and only if useful for README/demo evidence.

### Checkpoint 8 evidence

- The full Docker Compose gate passed on `phase-8`: 474 server tests, 27 web tests, both typechecks, and both production builds (501 tests total).
- The Compose browser deployment completed a real 10-to-1 countdown in 11.880 seconds, a three-turn unanimous free-chat session in 5.321 seconds, and a verified handoff regression in 11.335 seconds.
- The live failure rehearsal rejected a genuine wrong first answer (`Expected the next number 5, received 3`), retried the same participant, and completed 5-to-1 in 10.084 seconds.
- A live shared-session stop settled as `STOPPED_BY_USER` and cancelled the active attempt. Desktop 1440×900 and mobile 390×844 checks had no document overflow, semantic labels remained available, and the browser reported no warnings or errors.
- The completed countdown state now renders as `Complete` rather than exposing the backend's post-completion sentinel value `0` as a misleading next action.

## Completion gate

Phase 8 is complete only when:

- a user can select two to six Agents, create/start a session, and watch the transcript fill in round-robin order;
- the shared state and validation decisions are visible without logs;
- the wrong-number recovery is demonstrated live and honestly;
- stop works and polling cleans up for session runs;
- keyboard/labels and responsive layout pass the checklist;
- one real 10-to-1 run and one verified-workflow regression run both succeed;
- the final Docker Compose `npm run check` passes on the task branch.

## Handoff to Phase 9

Freeze UI scope, select stable demo fixtures/assets for both workflows, and set `P9-01` as the next action. From here, prefer documentation, tests, rehearsal, and release blockers over new features.
