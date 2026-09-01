# Phase 15 — Scale, Storage, and Release

**Goal:** find out what the 100,000-turn ceiling actually costs, decide whether the JSON store survives it, then document and release Session v2 with claims that are supported by measurements rather than by type limits.  
**Ends at:** Checkpoint 15 — measured scale evidence is recorded, the storage decision is made and implemented or explicitly deferred with a stated limit, and the release candidate is frozen.

## Entry criteria

- A Phase 15 task branch has been created from the completed Checkpoint 14.
- Phases 10–14 are complete with recorded evidence, and no feature work remains open.
- The Phase 15 paths in [`../FILESYSTEM_MAP.md`](../FILESYSTEM_MAP.md) have been reviewed.
- [`09-release.md`](09-release.md) has been re-read: this phase absorbs and supersedes it for Session v2, and its task list is the basis for the release half below.
- No new architecture or dependency is introduced within six hours of the release freeze.

If a measurement method, a documented claim, a storage trade-off, or required release evidence is unclear, stop and ask for clarification before publishing or changing implementation.

## Required outputs

- Measured store latency and file growth at realistic session lengths.
- A recorded storage decision, implemented behind `CoordinationRepository` or deferred with a stated practical ceiling.
- The Session v2 documentation set.
- A demo package for the new product shape.
- Clean-install verification and a recorded submission commit.

## Tasks

### Scale measurement

- [x] **P15-01** Measure the JSON store honestly. `JsonStore.mutate` deep-clones the entire database, serialises it, writes a temp file, and renames — on every mutation — and one committed turn costs roughly four of those. Build a reproducible harness (in a temporary directory, never against real runtime data) that drives a session to 100, 500, 2,000, and 10,000 committed turns and records: median and p95 mutation latency at each point, database file size, process memory during `snapshot()`, wall-clock time for `getRunDetails`, and end-to-end wall clock for the last user prompt at each size. Report the numbers as a table in `STATUS.md`. Do not extrapolate — measure each point.
- [x] **P15-02** Measure the read path under the delta model from `P12-10`. Compare a full detail fetch against a `?sinceSequence=` fetch at each transcript size, and record the payload sizes the browser actually receives while polling at 1.5 seconds. If full fetches dominate the cost at realistic sizes, tighten the client to delta-only and record that change.
- [x] **P15-03** Record the practical ceiling. From `P15-01` and `P15-02`, state the transcript length beyond which the product is unusable, and enforce a matching default (not ceiling) in `SESSION_LIMITS`. The 100,000 ceiling stays available for callers who ask for it, but the documented recommendation must be the measured number, and the UI must warn when a session approaches it.

### Storage decision

- [x] **P15-04** Decide and record: keep `JsonStore` with the measured ceiling, or move the five coordination collections behind a different implementation of `CoordinationRepository`. That interface is the seam that makes this swappable — the service, workflow, protocol, and routes must not change either way. Record the decision as a mini-RFC with the measurements from `P15-01` as its evidence.
- [x] **P15-05** If the decision is to swap: implement the alternative (per-run append-only JSONL, or SQLite via `better-sqlite3`) as a second `CoordinationRepository`, keep single-mutation atomicity and lease/version semantics identical, and run the entire existing repository race suite — 1,466 lines of it — against the new implementation unmodified. That suite passing without edits is the acceptance criterion; if it needs edits, the semantics have changed and the swap is not done. Include a one-way migration from the existing v2 JSON document, a dry-run mode, and a documented rollback. If the decision is to defer, this task is closed as `deferred` with the measured ceiling recorded in `STATUS.md` and in the operations document.

### Documentation

- [x] **P15-06** Rewrite the root `README.md` for Session v2: the pitch, prerequisites, configuration, Agent setup, creating a session, adding participants, sending prompts, watching a wave, stopping versus ending, verification, the failure demos, honest limitations (including the measured transcript ceiling and the single-process constraint), and links. Remove every claim that no longer holds, including countdown and the verified-handoff UI.
- [x] **P15-07** Produce the documentation set from `overview.md` Section 24, updated for Session v2: `COORDINATION_ARCHITECTURE.md` (components, trust boundary, session lifecycle including `awaiting_input`, wave scheduling, reservations as implemented in `P11-05`); `COORDINATION_PROTOCOL.md` (session message, user message, and session plan schemas with valid and invalid examples, the parsing order, the structural plan rules, scoped context and the recency window, retry semantics); `COORDINATION_API.md` (every route including `POST /:id/messages` and `POST /:id/end`, the delta cursor, statuses, error codes including `RUN_ABANDONED`, auth, polling, idempotency); `COORDINATION_OPERATIONS.md` (limits as implemented, the measured ceiling, restart and reconciliation behaviour, storage, logging and redaction, known failure modes); and `DECISIONS.md` carrying forward ADR-01–14 plus every mini-RFC recorded in Phases 10–14.
- [x] **P15-08** Reconcile the development docs: `STATUS.md` reflects Phases 0–15, `overview-sessions.md` describes the shipped contract with no forward-looking "will be implemented in phase N" text left over, `FILESYSTEM_MAP.md` matches the final file layout including the `SessionWorkspace` rename, and `09-release.md` is marked as superseded by this sheet.
- [x] **P15-09** Verify every command and link from a clean checkout. Remove pseudocommands, local absolute paths, and stale file references.

### Demo package

- [x] **P15-10** Write Agent instruction templates for the new shape: eight to ten collaborative participants suitable for both ordered and fan-out prompts, one coordinator-capable Agent, and one deliberately unreliable Agent that occasionally proposes a malformed plan or an out-of-order contribution, for the failure demo.
- [x] **P15-11** Write `DEMO.md`: setup, the three-minute narration (create a session, add participants, ordered prompt, fan-out prompt, follow-up prompt in the same session, stop and resume), expected states at each beat, the latency fallback, the `round_robin` fallback, reset steps, and the failure path.
- [ ] **P15-12** Prepare labelled completed-run fallbacks: one ordered session, one parallel session, one multi-prompt session that survived a restart, and one stored plan-rejection recovery. Each must be a real recorded run, clearly marked as a recording.
- [ ] **P15-13** Rehearse the demo at least three times and both failure paths once. Record the timing range and the exact commit. Have someone other than the author follow `README.md` and `DEMO.md` from scratch.

### Release verification

- [x] **P15-14** Inspect `git status` and the full diff. Preserve user work; exclude secrets, runtime data, generated clutter, and unrelated refactors.
- [x] **P15-15** Run a clean install followed by the full typecheck, test, and build through Docker Compose.
- [ ] **P15-16** Run the normal, stop, end, restart, and failure browser flows against the release configuration.
- [x] **P15-17** Inspect logs, the database, API payloads, and the UI for tokens, authorization headers, cookies, raw prompts, lease tokens, stack traces, or other sensitive data. Session v2 adds user-authored prompt content to durable storage: confirm it appears only where it is meant to, and that events still carry no content.
- [ ] **P15-18** Confirm every acceptance criterion in `overview.md` Section 31.3 and the amended `overview-sessions.md`, plus each of the nine Session v2 requests from [`../plans/session-v2-plan.md`](../plans/session-v2-plan.md) §1, and record the evidence for each.
- [ ] **P15-19** Remove stale demo data and misleading historical runs from local runtime state before judging evidence is captured.
- [ ] **P15-20** Record the submission commit and freeze feature work.

## Requirements and boundaries

- Measurements are measurements. No claim about scale may be extrapolated, estimated, or inherited from an earlier phase's impression.
- A storage swap changes the implementation behind `CoordinationRepository` and nothing above it. The existing race suite passing unmodified is the proof.
- Documented limits match enforced limits exactly; where they differ, the document is wrong and gets fixed, not the other way round.
- Failure demos use genuine Agent misbehaviour caught by genuine middleware. Never simulate.
- Redaction rules are unchanged and re-verified, with attention to the new user-authored content.

## Release commands

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

## Cut order if time is short

Cut the storage swap (`P15-05`, keeping the measured ceiling documented) → the parallel demo beat → the ten-Agent demo in favour of six → extra Agent templates → advanced metrics. Never cut: the scale measurements themselves, the honest limitation statement, the redaction inspection, the failure demo, or the clean-install verification.

## Completion gate

Phase 15 is complete only when:

- scale measurements exist as recorded numbers at every sampled size;
- the storage decision is recorded, and implemented or explicitly deferred with a stated ceiling;
- `npm run check` passes from a clean checkout through Docker Compose;
- README and demo instructions are reproduced independently by someone else;
- the demo runs repeatedly within budget, with fallbacks ready;
- redaction and security inspection pass, including user-authored content;
- all nine Session v2 requests have recorded acceptance evidence;
- limitations are stated honestly, including anything cut;
- the submission commit is recorded.

## Final handoff

Update `STATUS.md` to `complete` for Phases 10–15, include the submission commit and verification evidence, and list only known limitations — no outstanding tasks.
