# Phase 5 — Documentation, Demo, and Release Candidate

**Goal:** produce a clean, reproducible, honestly scoped submission whose normal and failure claims are supported by tests and rehearsed evidence.  
**Ends at:** Checkpoint 5 — submission candidate frozen except for release-blocking fixes.

## Entry criteria

- A Phase 5 task branch has been created from the completed UI checkpoint.
- The Phase 5 paths in [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) have been reviewed; implementation files are opened only to verify documented behavior.
- Phases 0–4 are complete with recorded evidence.
- Core UI and contracts are frozen.
- Normal and failure fixtures plus at least one completed real run are available.
- No new architecture or dependency is introduced within six hours of submission.

If release scope, command behavior, documented claims, or required evidence is unclear, stop and ask for clarification before publishing or changing implementation.

## Required outputs

- User-facing README quick start and Relay links.
- Architecture, protocol, API, operations, decisions, and demo documents from overview Section 24.
- Seeded objective and three role instruction templates.
- Three-minute live script and completed-run fallback.
- Clean-install/repository-wide verification record and submission commit.

## Tasks

### Product documentation

- [ ] **P5-01** Update root README with Relay pitch, prerequisites, configuration, three-Agent setup, normal flow, verification, failure demo, limitations, and links.
- [ ] **P5-02** Create `COORDINATION_ARCHITECTURE.md`: components, trust boundary, state machine, persistence, runtime, reservations.
- [ ] **P5-03** Create `COORDINATION_PROTOCOL.md`: schemas/examples, validation order, scoped context, retry versus revision, invalid example/error.
- [ ] **P5-04** Create `COORDINATION_API.md`: routes, payloads, statuses/errors, auth, polling, idempotency.
- [ ] **P5-05** Create `COORDINATION_OPERATIONS.md`: limits, restart/stop, storage, logging/redaction, recovery, known failures.
- [ ] **P5-06** Create `DECISIONS.md` with ADR-01–14 and rejected alternatives.
- [ ] **P5-07** Verify every command and link from a clean checkout; remove pseudocommands and local absolute paths.

### Demo package

- [ ] **P5-08** Add three fresh-Agent instruction templates and one short seeded objective with required sections.
- [ ] **P5-09** Write `DEMO.md` with setup, expected states, three-minute narration, reset steps, failure/revision path, and contingency.
- [ ] **P5-10** Prepare a clearly labeled completed-run fallback and deterministic failure/rejection evidence.
- [ ] **P5-11** Rehearse the normal demo multiple times and failure/revision once; record timing range and exact commit.
- [ ] **P5-12** Have someone other than the author follow README and demo instructions from scratch.

### Release verification

- [ ] **P5-13** Inspect `git status` and diff; preserve user work and exclude secrets, runtime data, generated clutter, and unrelated refactors.
- [ ] **P5-14** Run a clean install followed by full typecheck, test, and build.
- [ ] **P5-15** Run normal and stop/failure browser flows with the release configuration.
- [ ] **P5-16** Inspect logs, database, API payloads, and UI for tokens, authorization/cookies, raw prompts, leases, stack traces, or sensitive data.
- [ ] **P5-17** Confirm every product acceptance criterion in overview Section 31.3 and record evidence.
- [ ] **P5-18** Record/tag the submission commit and freeze feature work.

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

Cut animation/filtering/export, configurable policy controls, extra objectives, advanced metrics, expanded run lists, and live failure injection—in that order. Never cut typed validation, deterministic routing, rejection/revision, bounded limits, active leases, scoped context, durable events, regression tests, or the core create/start/detail/stop path.

## Completion gate

Phase 5 is complete only when:

- `npm run check` passes from a clean checkout;
- README/setup/demo commands are independently reproduced;
- a real normal run is repeatedly successful within the demo budget;
- failure/revision evidence and completed fallback are ready;
- security/redaction inspection passes;
- non-goals and limitations are stated honestly;
- the exact submission commit is recorded and all overview product acceptance criteria pass.
- the final Docker Compose `npm run check` passes on the release task branch.

## Final handoff

Update `STATUS.md` to `complete`, include the submission commit and verification evidence, and list only known limitations—no outstanding MVP tasks.
