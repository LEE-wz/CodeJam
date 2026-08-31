# Phase 14 — Coordinator Planning and Ordered Assignment

**Goal:** make the session context-aware. After each user prompt, one Agent proposes a validated plan — who answers, in what order, and with what instruction — and the backend executes it either as an ordered sequence or as a parallel wave. This replaces the hard-coded countdown protocol, which is then deleted.  
**Ends at:** Checkpoint 14 — "count down from 10 to 1" produces the correct ordered output through an Agent-authored plan with no numeric validator in the engine, and a fan-out prompt executes as a parallel wave.

## Entry criteria

- A Phase 14 task branch has been created from the completed Checkpoint 13.
- Wave scheduling (Phase 13) and multi-prompt sessions (Phase 12) are complete and stable.
- The coordinator-identity decision (open question 3 in [`../plans/session-v2-plan.md`](../plans/session-v2-plan.md)) is recorded in [`../ASSUMPTIONS_AND_DECISIONS.md`](../ASSUMPTIONS_AND_DECISIONS.md). `P14-03` cannot start without it.
- The Phase 14 paths in [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) have been reviewed.
- The countdown protocol still exists and still passes its tests; this phase is the only place it may be removed.

If the plan schema, the validation rules, the coordinator's identity, the fallback behaviour, or the deletion order is unclear, stop and ask for clarification. The trust boundary is the constraint that decides most of these answers: the Agent proposes, the backend validates shape and owns every scheduling decision.

## Required outputs

- A `session_plan` turn kind, artifact type, schema, and mechanical validator.
- A coordinator turn scheduled after each user prompt, with a deterministic fallback.
- Plan execution in sequential and parallel modes, reusing Phase 13 waves.
- Per-assignment instructions delivered through the context builder.
- Invalid-plan rejection and retry evidence.
- Deletion of the countdown protocol and its shared state.
- A live rehearsal proving ordered output without a numeric validator.

## Tasks

### Plan contract

- [x] **P14-01** Add the plan artifact. Extend `CoordinationTurnKind` with `"session_plan"` and `ArtifactType` with `"session_plan"`, and define the payload:

  ```jsonc
  { "schemaVersion": 1, "type": "session_plan",
    "mode": "parallel" | "sequential",
    "assignments": [ { "agentId": "<participant id>", "position": 1, "instruction": "<= 500 chars" } ] }
  ```

  Add the strict bounded Zod schema in `coordination/schemas.ts` and the exhaustive-map entries required by `P7-02` discipline: `EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND.session_plan → "session_plan"`, `ROLE_VISIBILITY.session_plan`, `capPayload`, and the artifact-protocol dispatch. A plan artifact is committed evidence like any other: immutable, attributed, and visible in the ledger.
- [x] **P14-02** Implement the mechanical plan validator in the shared-session artifact protocol, applied after the existing parsing order from `overview.md` Section 11.4 (size, trim, single fence, one parse, expected type, schema version, bounded schema, then the protocol rule). The rules are purely structural: every `agentId` is a participant of this run; agent ids are distinct; `position` values are integers forming a contiguous run from 1 to the assignment count; the assignment count is between 1 and the participant count; `instruction` is non-empty and bounded; `mode` is one of the two literals. Rejection produces `INVALID_AGENT_OUTPUT` with a retry-safe message that names the structural problem (for example `Assignment positions must be contiguous from 1`) and never quotes raw output. The middleware still judges no substance: it never checks whether the plan is a *good* plan, only whether it is a *well-formed, executable* one.

### Coordination

- [x] **P14-03** Schedule the coordinator turn. After a user message is appended and the loop resumes, `SharedSessionWorkflowV1` schedules exactly one `session_plan` turn before any `session_turn` for that user message, assigned per the recorded coordinator decision (first participant, a designated participant, or a dedicated coordinator). The decision is derived from committed state — a plan exists for `lastUserArtifactId` or it does not — so a retry never schedules two plans, and a restart mid-plan re-derives correctly.
- [x] **P14-04** Execute the plan. `mode: "parallel"` becomes one `schedule_wave` decision containing every assignment, bounded by `maxParallelTurns` from `P13-07`. `mode: "sequential"` schedules assignments strictly in `position` order, one turn at a time, each seeing the transcript including its predecessors' committed messages — this is what makes an ordered countdown correct without an engine-side numeric rule. Both modes terminate the round when every assignment has committed or the run fails, after which the workflow returns `await_input` from Phase 12.
- [x] **P14-05** Add `policy.sessionPlanning: "coordinator" | "round_robin"` (default `"coordinator"`), validated in the routes and the service and exposed in the create form. `"round_robin"` restores the deterministic Phase 13 behaviour with no planning turn — the demo-safe fallback when a model plans badly. The workflow selects between them from durable policy only; no Agent output can change the mode.
- [x] **P14-06** Deliver per-assignment instructions through the context builder. A `session_turn` whose run has an active plan renders, in addition to the transcript and objective, the instruction assigned to *that* participant and its position in the round. A participant never sees another participant's assignment text beyond what the committed plan artifact already contains, and the prompt still never states an expected answer — the ordered-output property must come from the plan and the transcript, exactly as the countdown rule required the number never be stated. Add a `session_plan` prompt template containing the roster with names and ids, the recent transcript, the new user message, and the output contract.

### Countdown removal

- [x] **P14-07** Delete the countdown protocol from the backend, now that ordered coordination has a replacement. Remove `SessionProtocol`'s `"countdown"` member (or the type entirely if free chat is the only remaining protocol), `sessionStartValue`, `CoordinationSharedState`, `run.sharedState`, `nextCountdownValue` in `repository.ts`, the countdown branch of `SharedSessionWorkflowV1`, the countdown validation branch in the artifact protocol, the countdown task instruction in the context builder, and the countdown route and service validation. Approximately 140 references across 20 files, most of them tests and fixtures. Stored history keeps its fields: a pre-existing run with `sharedState` must still load, render, and be readable through the API — deletion applies to the engine, not to the ledger, and a fixture test asserts it.
- [x] **P14-08** Delete the countdown surface remnants from the web app and its fixtures, leaving only the legacy-render path from `P10-07`. Update `overview-sessions.md` so Sections 1, 2, 6.1 and 6.5 describe planned ordering as the mechanism for ordered demos, and record in `ASSUMPTIONS_AND_DECISIONS.md` that the acceptance demo now proves ordering through Agent coordination rather than through an engine-side numeric validator.

### Tests and rehearsal

- [x] **P14-09** Add plan-validation tests: valid sequential and parallel plans; an agent id that is not a participant; duplicate agent ids; positions starting at 0; positions with a gap; more assignments than participants; zero assignments; an oversized instruction; a fenced or prose-wrapped plan; a plan with unknown fields; a plan arriving for a turn that expected a `session_message`; and a `session_message` arriving for a plan turn. Each rejection must carry a retry-safe message and must be retried through the existing per-turn retry path.
- [x] **P14-10** Add workflow tests: exactly one plan per user message; a plan retried after rejection does not duplicate; sequential execution follows `position` order under the scripted runtime; parallel execution produces one wave; `round_robin` policy schedules no plan turn; a restart between plan commit and first assignment re-derives the same remaining work; stop during a planned round settles everything and returns to `awaiting_input`.
- [x] **P14-11** Live rehearsal in the Compose browser deployment. With ten real Agents in one session: prompt "count down from 10 to 1, one number each, in order" and confirm the plan is sequential, the assignments are ordered, and the transcript reads 10 to 1 correctly with correct attribution — with no numeric validator anywhere in the engine. Then prompt something fan-out shaped in the same session and confirm a parallel wave. Then send a third prompt to confirm the session is still live. Record timings, the committed plan artifacts, and at least one genuine plan rejection with its recovery. Never simulate middleware behaviour; if the model plans badly, record that honestly and note the `round_robin` fallback.

## Requirements and invariants

- The Agent proposes; the backend disposes. Scheduling, leases, limits, cancellation, and completion remain backend-owned, and no plan field can change policy, participants, limits, or another run.
- Plan validation is structural only. The middleware never evaluates whether the plan is sensible.
- A plan is committed evidence: immutable, attributed to its author, and visible in the ledger and the transcript.
- Ordered output must be an emergent property of sequential scheduling plus the transcript. No expected value is ever stated in a prompt.
- The deterministic `round_robin` fallback must remain fully functional, because it is the demo contingency.
- Deleting countdown never invalidates stored history.
- Verified handoff is untouched.

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

Run the plan-validation and workflow suites through Docker Compose, then the full check. Rehearse `P14-11` at least three times and record the range, not the best run.

## Completion gate

Phase 14 is complete only when:

- a sequential plan produces correct ordered output from ten real Agents with no numeric validator in the engine;
- a parallel plan fans out correctly in the same session;
- at least one genuine plan rejection and recovery is recorded from a real run;
- `round_robin` still works as a complete fallback;
- countdown is gone from the engine and stored countdown runs still load and render;
- `overview-sessions.md` describes the replacement accurately;
- the verified-handoff regression matrix passes unchanged;
- the final Docker Compose `npm run check` passes on the task branch.

## Handoff to Phase 15

Record the rehearsal range, the plan artifacts, the rejection evidence, and the countdown-removal diff summary in `STATUS.md`, then set `P15-01` as the next action. Feature work ends here: Phase 15 measures, documents, and releases.
