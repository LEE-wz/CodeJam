# Phase 6 — Session Core in Memory

**Goal:** prove the complete session workflow semantics end to end using deterministic in-memory dependencies before persistence, HTTP, or model latency complicates debugging.  
**Ends at:** Checkpoint 6 — in-memory 10-to-1 completes with fake repository and scripted runtime; wrong numbers retry and exhaustion fails safely.

## Entry criteria

- A Phase 6 task branch has been created from the recorded frozen session contract commit.
- The Phase 6 paths in [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) have been reviewed and no unrelated paths will be accessed.
- Phase 5 is complete and its frozen commit is recorded.
- Shared session fixtures, fake repository, and scripted runtime compile.
- Changes to contracts require the mini-RFC process.

If session workflow semantics, countdown validation, transcript visibility, or expected test evidence is unclear, stop and ask for clarification. Do not encode an assumption in code or fixtures.

## Required outputs

- Pure `SharedSessionWorkflowV1` with exhaustive routing tests.
- Strict session message schema, parser, and countdown cross-field validation.
- Transcript-building context template and leakage/digest tests.
- Session branch of service create plus workflow dispatch.
- Walking-skeleton evidence for normal, retry, timeout, stop, and stale-result paths.

## Tasks

### Pure workflow

- [ ] **P6-01** Implement `SharedSessionWorkflowV1` in a new `coordination/session-workflow.ts`, replacing the Phase 5 throwing shell. Route: next participant = `participants[committedSessionTurnCount % participantCount]`; schedule `session_turn` with phase `sessioning` and expected artifact `session_message`. Countdown: complete when the latest committed message value is `1`; fail `MAX_TURNS_EXCEEDED` when scheduling would exceed `maxTurns`. Free chat: complete when every participant's most recent committed message carries `done: true` (unanimous across one full round), or when `nextTurnSequence > maxTurns`. On any session completion, the `complete` decision's `finalArtifactId` is the last committed session message. Both: fail `INVALID_STATE` for missing or inconsistent countdown `sharedState`, for non-session artifacts in a session run, or for a session run with committed review/proposal/final artifacts.
- [ ] **P6-02** Implement the workflow dispatch: given `run.policy.workflow`, select `VerifiedHandoffWorkflowV1` or `SharedSessionWorkflowV1`. The verified workflow's routing logic is not modified in any way.
- [ ] **P6-03** Add table tests for every routing branch and boundary: round-robin cycles over 2, 3, and 4 participants; countdown completion at 1; free-chat completion on a unanimous `done` round; partial `done` does not complete; a withdrawn signal reopens the run; no signals still completes at `maxTurns`; free-chat completion cannot happen before `participantCount` committed turns; countdown turn ceiling; malformed shared state; dispatcher selection by workflow id; deterministic ordering. No repository, clock, or runtime is allowed in these tests.

### Countdown protocol

- [ ] **P6-04** Implement the strict, bounded Zod schema for `SessionMessagePayload`: `schemaVersion: 1`, `type: "session_message"`, `content` trimmed and 1..500 characters, `done` optional boolean, free-chat only; object is strict. The countdown cross-field rule constrains countdown turns further.
- [ ] **P6-05** Enforce the parsing order from overview.md Section 11.4: output size, trim, at most one outer JSON fence, one `JSON.parse`, expected type and schema version, bounded schema, then the protocol-specific rule. Countdown: `content` parses as an integer equal to `run.sharedState.nextExpectedNumber`, and a `done` field present on a countdown message is rejected with `INVALID_AGENT_OUTPUT` and a retry-safe message such as `done is not allowed on countdown messages`; failure returns `Expected the next number <N>, received <X>`. Free chat: no further rule. This branch replaces the Phase 5 placeholder in `EXPECTED_ARTIFACT_TYPE_BY_TURN_KIND`.
- [ ] **P6-06** Test valid numbers; wrong numbers; non-integer content; oversize output; fenced JSON; prose around JSON; missing and unknown fields; forged provenance and Agent-supplied IDs. Add free-chat cases: valid free text, `done: true` accepted, non-boolean `done` rejected, `done` on a countdown message rejected, empty content, oversize content, fenced JSON, prose, forged provenance.

### Transcript context builder

- [ ] **P6-07** Implement the session turn templates, replacing the Phase 5 placeholders in `TASK_INSTRUCTIONS`, `OUTPUT_SHAPES`, `OUTPUT_LIMITS`, and `ROLE_VISIBILITY`: the existing four-section envelope, `[COMMITTED INPUT ARTIFACTS]` rendered as a chronological transcript where each line is `<AgentName>: <content>`, and the task instruction. Because `TASK_INSTRUCTIONS` is keyed by `CoordinationTurnKind` alone and `session_turn` carries both protocols, change the map's shape to express both (for example key it by workflow or protocol, or make it a lookup function) rather than a single `session_turn` entry. Countdown instruction: continue the countdown by publishing the next number exactly one lower than the last number in the transcript. Free-chat instruction: contribute the next message toward the shared objective based on the transcript, and set `done: true` only when you consider the shared objective fully met (advisory; the backend decides when the run completes). The free-chat output contract describes the optional `done` field. Reuse the existing deterministic truncation ladder (oldest entries truncated first) and the bounded retry-feedback placement. Also add the explicit `session_message` branch to `capPayload` instead of relying on the fallthrough.
- [ ] **P6-08** Enforce the prompt rule: the expected number never appears in any countdown prompt; the Agent derives the next number from the transcript alone. Free-chat prompts contain the objective and transcript only, with no hidden state.
- [ ] **P6-09** Test transcript ordering; oldest-first truncation; no expected-number leak in countdown prompts; no hidden state in free-chat prompts; no lease, token, event, auth, or unrelated-thread leakage; stable digest for identical input. Note: for session turns the transcript is cumulative by design (all committed messages), which is the shared-session semantics; superseded-history exclusion does not apply.

### Service orchestration (in memory)

- [ ] **P6-10** Extend the Phase 5 minimal session create in `service.ts` into the full session branch: accept the create union; require 2..6 distinct existing Agents; snapshot names; build participants with role `"participant"` in input order; merge policy with `sessionProtocol` (default `"countdown"`) and, for countdown, `sessionStartValue` (default 10, range 2..12) with `maxTurns >= sessionStartValue`; free-chat runs forbid `sessionStartValue` and default `maxTurns` to 6; initialize `phase: "sessioning"`, `revision: 0`, and, for countdown, `sharedState.nextExpectedNumber = sessionStartValue`; add the range validations the minimal create deferred (start-value bounds, free-chat turn bounds, name/objective bounds, timeout bounds) and run the create-time context probe with a session turn shape.
- [ ] **P6-11** Confirm the existing schedule → attempt → runtime → validate → lease commit loop drives session runs through the dispatch with no loop changes. Retry on a wrong or malformed message uses the same Agent and logical turn; a second invalid or timed-out attempt fails the run with `MAX_ATTEMPTS_EXCEEDED`; stop and late results behave exactly as for verified runs.
- [ ] **P6-12** Add walking-skeleton tests over the real components: normal 10-to-1 with round-robin order; wrong number → retry → success; wrong twice → fail; timeout → retry; stop during a deferred attempt; late result ignored; countdown turn ceiling; free-chat run completing at `maxTurns`; free-chat run completing on a unanimous `done` round; free-chat malformed message → retry → fail; dispatcher correctness; the verified workflow regression matrix remains green.

## Requirements and boundaries

- Workflow/protocol/context code is pure and has no global mutable state.
- Routing never depends on arbitrary Agent prose.
- The parser does not extract "best effort" JSON from surrounding commentary.
- Countdown prompts never state the expected number; the validator is the sole authority for what commits.
- Retry targets the same Agent and logical turn; the round-robin position derives from committed session turns only.
- Turn reassignment is cut; retry targets the same Agent. The free-chat unanimity rule is computed from committed artifacts only; a withdrawn signal reopens the run.
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

Phase 6 is complete only when:

- every session workflow, protocol, and context branch is tested;
- the real service completes a 10-to-1 run and the wrong-number retry path with fake dependencies;
- invalid output visibly retries once and exhaustion fails safely;
- stale/deferred output cannot progress a session run;
- no real persistence, HTTP server, or Agent is needed;
- all pre-existing server tests remain green;
- the final Docker Compose `npm run check` passes on the task branch.

## Handoff to Phase 7

Freeze session fixture behavior used by repository and API tests. Set `P7-01` as the next task and do not persist session state until Phase 7 race gates pass.
