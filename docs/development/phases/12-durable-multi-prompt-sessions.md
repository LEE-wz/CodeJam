# Phase 12 — Durable Multi-Prompt Sessions

**Goal:** turn a session from a single-shot run into a durable conversation: the user creates a session, adds Agents, sends a prompt, watches the Agents answer, and then sends another prompt into the same transcript. A session ends only when the user ends it.  
**Ends at:** Checkpoint 12 — one session accepts three consecutive user prompts, survives a server restart while idle, and keeps one ordered transcript containing both user and Agent messages.

## Entry criteria

- A Phase 12 task branch has been created from the completed Checkpoint 11.
- Checkpoint 11 is complete: no known path strands a run. A long-lived session multiplies the cost of any remaining lifecycle defect.
- The Phase 12 paths in [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) have been reviewed.
- The `overview-sessions.md` Section 6.5 amendment from `P10-01` is in place: session termination is an explicit user action.
- Session runs are still strictly sequential round-robin; parallelism is Phase 13 and planning is Phase 14. Do not anticipate them.

If the idle-state semantics, the user-message shape, the resume path, the stop-versus-end distinction, or the delta read contract is unclear, stop and ask for clarification before implementing.

## Required outputs

- A non-terminal `awaiting_input` run status and an `await_input` workflow decision.
- A durable `user_message` artifact variant with deterministic transcript ordering.
- An atomic append-and-resume command plus its HTTP route.
- Separated stop (ends the wave) and end-session (ends the session) actions.
- A delta read model and an incremental client transcript.
- A chat UI that replaces create-start-watch.
- Restart, race, and multi-prompt tests.

## Tasks

### Durable state

- [ ] **P12-01** Add `awaiting_input` to `CoordinationRunStatus` and `{ kind: "await_input" }` to `WorkflowDecision` in `coordination/contracts.ts`. `awaiting_input` is non-terminal, has no `activeTurnId`, and has no running loop. Update every exhaustive consumer: `terminalStatuses` and `isTerminal` in `service.ts`; `ACTIVE_RUN_STATUSES` and `TERMINAL_RUN_STATUSES` in `repository.ts`; the status guards in `session-workflow.validateSessionView` (which currently rejects any status but `running`); the web `activeStatuses` polling set; and the status chip styles. `SharedSessionWorkflowV1` returns `await_input` where it previously returned `complete` for the free-chat exhaustion cases; it still returns `fail` with `MAX_TURNS_EXCEEDED` at the hard ceiling and still returns `complete` only when the run is being ended deliberately.
- [ ] **P12-02** Add the `user_message` artifact. Extend `ArtifactType` with `"user_message"` and add the payload `{ schemaVersion: 1, type: "user_message", content: string }` with `content` trimmed and bounded at 4,000 characters, plus a strict Zod schema in `coordination/schemas.ts`. Extend the `CoordinationArtifact` union with a variant whose provenance is the user: keep `createdByRole`/`createdByAgentId` on Agent artifacts and give the user variant `createdBy: { kind: "user" }` with `turnId` optional, because a user message is not a turn. Every exhaustive map over `ArtifactType` must be updated with no `default` branch, as established in `P7-02`: `EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND` consumers, `capPayload`, `ROLE_VISIBILITY`, the artifact-protocol dispatch, and the event guards. A `user_message` is never the expected output of any turn: the artifact protocol must reject one arriving from an Agent.
- [ ] **P12-03** Add `transcriptSequence: number` to session artifacts, assigned inside the same mutation that stores the artifact, monotonically per run across both user and Agent messages. Ordering by `createdAt` is not sufficient — two writes can share a millisecond, and the transcript must be totally ordered for the context builder, the UI, and the delta read model. Backfill is unnecessary; absent values on pre-Phase-12 artifacts sort first by `createdAt`, and that rule is tested.
- [ ] **P12-04** Extend the run record with the session's conversational state: `lastUserArtifactId` (the prompt the current wave is answering) and `endedByUser?: boolean`. Both are optional and additive; old databases load unchanged and no migration is introduced.

### Repository and orchestration

- [ ] **P12-05** Implement `appendUserMessage` in `coordination/repository.ts`: in one `JsonStore.mutate()`, verify the run exists and is `created` or `awaiting_input` (never `running`, never terminal), assign `transcriptSequence`, push the artifact, set `lastUserArtifactId`, move the status to `running`, bump `version`, set `updatedAt`, and append a `user.message_appended` event with an actor of `{ type: "user" }` and no content in the details. Return a discriminated result: `appended`, `conflict` (run is `running` — a wave is in flight), `not_found`, or `terminal`. Add the event type, the events-factory entry, and redaction coverage.
- [ ] **P12-06** Add `resumeRun(id)` to `CoordinationService`, sharing the `activeLoops` guard with `startRun` so a second prompt cannot spawn a second loop for the same run. `startRun` keeps its `created → running` transition and its participant readiness and reservation checks; `resumeRun` performs the `awaiting_input → running` transition through `appendUserMessage` and then starts the same `runLoop`. The loop itself is unchanged apart from handling `await_input`: on that decision it calls a new `repository.awaitInput(runId)` that clears any active turn pointer, sets `awaiting_input`, bumps `version`, and appends a `run.awaiting_input` event, then the loop returns cleanly.
- [ ] **P12-07** Separate stop from end. `POST /:id/stop` now cancels the in-flight wave and returns the run to `awaiting_input` rather than to `stopped`: it keeps the existing `requestStop` → runtime cancellation → settle sequence, but the final durable state is `awaiting_input` with the cancelled attempt and turn recorded as evidence. Add `POST /:id/end` which is only valid from `awaiting_input` or `created`, sets `completed` with `endedByUser: true` and `finalArtifactId` pointing at the last committed artifact if one exists, and appends `run.completed`. A session that is `running` must be stopped before it can be ended, and the API says so with `INVALID_STATE` rather than silently doing both.
- [ ] **P12-08** Update `interruptActiveRuns` so a restart settles only `running` and `stop_requested` runs. An `awaiting_input` session has no in-flight work and must survive the restart untouched — this is the property that makes a session feel durable, and it is asserted directly by a test that writes an idle session, re-initialises, and reloads it unchanged.

### API and context

- [ ] **P12-09** Add `POST /api/coordination-runs/:id/messages` in `coordination/routes.ts`, accepting `{ content: string, clientMessageId?: string }` with the same bearer auth, body-size cap, and structured error envelope as the existing routes. It returns `202` with the updated run. Double submission is defused by `clientMessageId`: if the last user artifact on the run carries the same id, the call is a no-op that returns the current run rather than appending twice. Validation failures are `400`; appending to a `running` run is `409 INVALID_STATE`; a terminal run is `409 INVALID_STATE`; an unknown run is `404`.
- [ ] **P12-10** Add the delta read model. `GET /api/coordination-runs/:id` accepts `?sinceSequence=<n>` and, when present, returns only events, turns, attempts, and artifacts at or after that cursor plus the full current run record, with an explicit `cursor` field for the next call. Without the parameter, the response is exactly what it is today, so nothing that already consumes it breaks. Leases are still stripped. Add injection tests for the cursor at 0, mid-transcript, past the end, and with a malformed value.
- [ ] **P12-11** Extend the context builder for user messages. `ROLE_VISIBILITY.session_turn` widens to `["session_message", "user_message"]`; the session branch of `buildArtifactSection` renders user lines as `User: <content>` interleaved with Agent lines in `transcriptSequence` order; and the session task instruction states that the most recent user message is the current request. The Phase 10 recency window applies to the combined transcript, and the newest user message is always included in full regardless of the window. Re-prove the leakage tests: no lease, no event data, no auth material, no other run's content, stable digest for identical input.

### Web

- [ ] **P12-12** Replace the create-start-watch flow with a session chat surface in `SessionWorkspace.tsx`: a create form that names the session and picks participants; a transcript pane that renders user and Agent messages distinctly in `transcriptSequence` order; a composer that is enabled when the run is `created` or `awaiting_input` and disabled with a visible "Agents are working" indicator while `running`; and Stop and End session controls whose different consequences are stated in the UI, not just in the docs. Sending a prompt from a `created` session performs start-then-append, or append-then-start, as one user gesture — the two-step create/start requirement from `P8-05` is superseded here and the supersession is recorded.
- [ ] **P12-13** Move polling to the delta cursor. Keep the single 1.5-second chain and its cleanup guarantees from `P8-09`, but request `?sinceSequence=` and append into local state instead of replacing it. Polling runs while the status is `running` or `stop_requested`, stops on `awaiting_input` and on terminal states, and restarts on send. Prove there is still exactly one in-flight request per chain, no accumulation across sends, and correct cleanup on unmount and on session switch.

### Tests

- [ ] **P12-14** Add durable multi-prompt tests: prompt → wave → `awaiting_input` → second prompt → wave → third prompt, asserting one run, one participant set, a totally ordered transcript, gapless events, and `version` monotonicity. Assert that `appendUserMessage` on a `running` run conflicts, that a duplicate `clientMessageId` appends once, and that a prompt racing a commit resolves to a single consistent order.
- [ ] **P12-15** Add lifecycle tests: restart while `awaiting_input` leaves the session intact and resumable; restart mid-wave settles the wave per Phase 11 and leaves the session usable; stop mid-wave returns to `awaiting_input` with the cancelled attempt recorded, then a new prompt succeeds; end from `awaiting_input` is terminal and immutable; end from `running` is rejected.
- [ ] **P12-16** Add web tests for the chat surface: composer disabled while working; user and Agent messages visually and semantically distinguishable; delta polling appends rather than replaces; Stop then send works; End session disables the composer; long transcripts stay bounded and scrollable; keyboard and label checks survive.

## Requirements and invariants

- One session is one run: the participant set, the transcript, and the evidence ledger never fork.
- `awaiting_input` is non-terminal and immutable-in-place only with respect to committed history; new user messages are appends, never edits.
- Terminal runs stay immutable. `end` is the only new terminal transition and it is one-way.
- All state changes remain single-mutation. The append-and-resume transition is one mutation, not an append followed by a status write.
- The UI never decides routing, acceptance, or completion; it sends prompts and renders committed state.
- Prompt content is task data, never instructions that override the output contract — the existing injection warning stays in every session prompt.
- Old databases and pre-Phase-12 runs load and render unchanged.

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

Run the durable and race suites through Docker Compose repeatedly. Then, in the Compose browser deployment, hold one real session across at least three prompts, restart the server while it is idle, and continue the same session afterwards. Record the transcript length, prompt sizes, and per-wave timings.

## Completion gate

Phase 12 is complete only when:

- one session accepts three consecutive prompts with one ordered transcript;
- a server restart while idle leaves the session usable and unchanged;
- stop ends a wave and end ends the session, and each is distinguishable in the UI;
- duplicate sends and prompt-versus-commit races are proven safe;
- delta polling appends correctly and cleans up exactly as the Phase 8 chain did;
- no Agent is left reserved after any of the above;
- the verified-handoff regression suite passes;
- the final Docker Compose `npm run check` passes on the task branch.

## Handoff to Phase 13

Record the multi-prompt evidence, the restart-while-idle proof, and the observed per-wave latency in `STATUS.md`, then set `P13-01` as the next action. Phase 13 changes how a wave is scheduled, not what a session is: freeze the session lifecycle here so the parallelism work has a stable contract underneath it.
