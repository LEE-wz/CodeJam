# Phase 9 — Documentation, Demo, and Release Candidate

**Goal:** produce a clean, reproducible, honestly scoped submission whose normal and failure claims for both workflows (verified handoff and shared session) are supported by tests and rehearsed evidence.  
**Ends at:** Checkpoint 9 — submission candidate frozen except for release-blocking fixes.

## Entry criteria

- A Phase 9 task branch has been created from the completed session-UI checkpoint.
- The Phase 9 paths in [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) have been reviewed; implementation files are opened only to verify documented behavior.
- Phases 0–8 are complete with recorded evidence.
- Core UI and contracts are frozen, including the session additions.
- Normal and failure fixtures for both workflows plus at least one completed real run of each are available.
- No new architecture or dependency is introduced within six hours of submission.

If release scope, command behavior, documented claims, or required evidence is unclear, stop and ask for clarification before publishing or changing implementation.

## Required outputs

- User-facing README quick start covering both workflows.
- Architecture, protocol, API, operations, decisions, and demo documents from overview Section 24, extended with the session contract from overview-sessions.md.
- Seeded objectives and instruction templates for both workflows, including the mischievous session Agent.
- Three-minute live script with latency fallback and completed-run fallbacks.
- Clean-install/repository-wide verification record and submission commit.

## Tasks

### Product documentation

- [ ] **P9-01** Update root README with the Relay pitch, prerequisites, configuration, Agent setup for both workflows, both normal flows, verification, both failure demos, limitations, and links.
- [ ] **P9-02** Create `COORDINATION_ARCHITECTURE.md`: components, trust boundary, state machine, persistence, runtime, reservations, plus the second workflow and the shared-state model.
- [ ] **P9-03** Create `COORDINATION_PROTOCOL.md`: schemas/examples, validation order, scoped context, retry versus revision, invalid examples, plus the session message schema (including the advisory `done` signal and its countdown rejection), countdown rules, the free-chat completion rules (unanimous `done`, `maxTurns`, user stop), the final-artifact-pointer rule, and the never-state-the-expected-number prompt rule.
- [ ] **P9-04** Create `COORDINATION_API.md`: routes, payloads, statuses/errors, auth, polling, idempotency, plus the session create variant and its validation table.
- [ ] **P9-05** Create `COORDINATION_OPERATIONS.md`: limits, restart/stop, storage, logging/redaction, recovery, known failures, plus session-specific limits.
- [ ] **P9-06** Create `DECISIONS.md` with ADR-01–14, rejected alternatives, and the session mini-RFC record.
- [ ] **P9-07** Verify every command and link from a clean checkout; remove pseudocommands and local absolute paths.

### Demo package

- [ ] **P9-08** Add three fresh-Agent instruction templates and one short seeded objective with required sections for the verified workflow.
- [ ] **P9-09** Add session instruction templates: two or three counting Agents, one mischievous Agent that occasionally subtracts two instead of one, one seeded countdown objective, and one free-chat demo objective with plain collaborative Agents.
- [ ] **P9-10** Write `DEMO.md` with setup, expected states, a three-minute narration covering both workflows, the latency fallback, reset steps, the failure paths, and contingency.
- [ ] **P9-11** Prepare clearly labeled completed-run fallbacks: one verified run, one completed 10-to-1 session run, one stored wrong-number session run, and one completed free-chat session run (prefer one that ended on a unanimous `done` round).
- [ ] **P9-12** Rehearse the countdown demo multiple times, the free-chat session once, and both failure paths once; record timing ranges and the exact commit.
- [ ] **P9-13** Have someone other than the author follow README and demo instructions from scratch.

### Release verification

- [ ] **P9-14** Inspect `git status` and diff; preserve user work and exclude secrets, runtime data, generated clutter, and unrelated refactors.
- [ ] **P9-15** Run a clean install followed by full typecheck, test, and build.
- [ ] **P9-16** Run normal and stop/failure browser flows with the release configuration for both workflows.
- [ ] **P9-17** Inspect logs, database, API payloads, and UI for tokens, authorization/cookies, raw prompts, leases, stack traces, or sensitive data.
- [ ] **P9-18** Confirm every product acceptance criterion in overview Section 31.3 and every session criterion in overview-sessions.md, and record evidence.
- [ ] **P9-19** Remove the misleading "Test Relay" run (objective "Count down from 10 to 0") from local demo data before judging evidence is captured, per overview-sessions.md Section 10.
- [ ] **P9-20** Record/tag the submission commit and freeze feature work.

## Release commands

From a clean checkout, use Docker Compose for installation, testing, building, and runtime verification:

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
docker compose up --build -d launchpad
docker compose ps
```

If deployment artifacts are in submission scope, also run the repository's documented Terraform and Docker Compose validation commands.

## Cut order if time is short

Cut animation/filtering/export, configurable policy controls, extra objectives, advanced metrics, expanded run lists, and live failure injection—in that order. Then cut session-only stretch: participant drag reordering and turn reassignment. Never cut countdown validation, the free-chat protocol, round-robin routing, lease enforcement, the transcript view, bounded limits, scoped context, durable events, regression tests, or the core create/start/detail/stop paths of either workflow.

## Completion gate

Phase 9 is complete only when:

- `npm run check` passes from a clean checkout;
- README/setup/demo commands are independently reproduced;
- a real normal session run is repeatedly successful within the demo budget and the verified workflow still works;
- failure evidence and completed fallbacks for both workflows are ready;
- security/redaction inspection passes;
- non-goals and limitations of both workflows are stated honestly;
- the exact submission commit is recorded and all product acceptance criteria pass;
- the final Docker Compose `npm run check` passes on the release task branch.

## Final handoff

Update `STATUS.md` to `complete`, include the submission commit and verification evidence, and list only known limitations—no outstanding MVP tasks.
