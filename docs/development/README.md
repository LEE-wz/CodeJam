# Relay Development Runbook

This directory turns [`overview.md`](./overview.md) into an operational runbook. The overview remains the product and contract authority; the phase sheets explain what to do next, [`FILESYSTEM_MAP.md`](./FILESYSTEM_MAP.md) limits file access to the relevant workstream, and [`STATUS.md`](./STATUS.md) records what is actually true in the repository.

## Mandatory development rules

These rules apply to every Relay task, including documentation-only work:

1. **Create a branch before development.** Start from the intended integration base, confirm the current branch, and create a task branch before editing any file. Never implement directly on `main` or the shared integration branch.
2. **Use the filesystem map before accessing files.** Read [`FILESYSTEM_MAP.md`](./FILESYSTEM_MAP.md), identify the current phase/task, and inspect only the listed paths plus direct dependencies required to complete it. Do not scan unrelated folders “just in case.”
3. **Follow the current phase guide strictly.** Work only on tasks allowed by the phase recorded in `STATUS.md`. Later-phase work requires an explicit, recorded exception.
4. **Clarify doubt before proceeding.** If the plan, contract, task boundary, target files, expected behavior, or completion evidence is unclear, stop and ask the user or responsible team owner. Record the answer in the appropriate decision/status file. Do not silently choose an assumption.
5. **Use Docker Compose for all testing and verification.** Do not use host-installed Node/npm as verification evidence. Run tests, typechecks, builds, smoke checks, and `npm run check` through Docker Compose.
6. **Run the full check after every implementation.** Before declaring any development task complete, run `npm run check` through Docker Compose and ensure it passes. A focused test may be run first, but it never replaces the full check.

The standard full verification command is:

```bash
docker compose build launchpad
docker compose run --rm --no-deps --user root \
  -v "$PWD:/source:ro" \
  -v /workspace \
  -w /workspace \
  launchpad sh -lc "tar -C /source \
    --exclude='apps/*/node_modules' --exclude='apps/*/dist' \
    -cf - package.json package-lock.json tsconfig.base.json apps \
    | tar --no-same-owner -C /workspace -xf - \
    && npm ci --include=dev && npm run check"
```

This uses the Compose service's Node 22 image, mounts the checkout read-only, and copies only the root npm/TypeScript contracts and `apps/` source into a fresh anonymous container workspace. Dependencies and builds are excluded, ownership metadata is not preserved, and secrets/runtime data are never included. `--include=dev` overrides the production service environment for verification dependencies. Installation and build output remain inside the disposable container volume, so verification cannot change host ownership or consume stale host caches. If this command cannot run, the task is not complete; record the exact blocker in `STATUS.md`.

## Start here every time

1. Read [`STATUS.md`](./STATUS.md). Its **Resume here** section is the current checkpoint.
2. Confirm the intended base branch is current, then create and switch to a task branch.
3. Open the linked phase sheet and read its objective, entry criteria, tasks, and completion gate.
4. Use [`FILESYSTEM_MAP.md`](./FILESYSTEM_MAP.md) to identify the minimum allowed file set for the task.
5. If anything is unclear, ask and record the answer before editing.
6. Inspect the named files, implement the smallest unchecked task, and add its tests.
7. Run focused checks through Docker Compose, then run the standard Docker Compose `npm run check` command and require a pass.
8. Update `STATUS.md` in the same change. Record branch, commit, evidence, newly completed task IDs, and exact next action.

Do not advance a phase because code exists. Advance only when every required gate has evidence. Work from a later phase may be merged early, but it remains “implemented ahead of gate” until all earlier gates pass.

## Source-of-truth order

When documents appear to disagree, use this order:

1. Sections 4 and 6–11 of [`overview.md`](./overview.md) for frozen scope, decisions, types, APIs, interfaces, persistence, and workflow semantics.
2. An approved ADR or mini-RFC recorded in [`ASSUMPTIONS_AND_DECISIONS.md`](./ASSUMPTIONS_AND_DECISIONS.md).
3. The applicable phase sheet for execution order and required evidence.
4. [`STATUS.md`](./STATUS.md) for current repository state, not product semantics.

Do not silently edit frozen contracts to fit an implementation. Record a mini-RFC with the current contract, blocker, proposed change, affected files/workstreams, and required migration/tests.

## Phase map

| Phase | Instruction sheet | Outcome | Completion checkpoint |
|---:|---|---|---|
| 0 | [`phases/00-contract-freeze.md`](./phases/00-contract-freeze.md) | Verified baseline, frozen contracts, shared fixtures and fakes | Checkpoint 0: contracts compile |
| 1 | [`phases/01-walking-skeleton.md`](./phases/01-walking-skeleton.md) | Full workflow semantics proven in memory | Checkpoint 1: in-memory walking skeleton |
| 2 | [`phases/02-durable-backend.md`](./phases/02-durable-backend.md) | Atomic persistence, leases, events, and HTTP lifecycle | Checkpoint 2: durable backend with fake runtime |
| 3 | [`phases/03-real-runtime.md`](./phases/03-real-runtime.md) | Real Agent execution, cancellation, reservations, and timing | Checkpoint 3: real Agent execution |
| 4 | [`phases/04-ui-evidence.md`](./phases/04-ui-evidence.md) | Usable configuration, polling, evidence timeline, and artifacts | Checkpoint 4: end-to-end UI |
| 5 | [`phases/05-release.md`](./phases/05-release.md) | Clean, documented, rehearsed submission candidate | Checkpoint 5: release candidate |

The gates are sequential even when implementation is parallel. Phase 2 must not connect real Agents until lease/race tests pass. Phase 3 must not expand features if real execution is unstable.

## Task and status conventions

Task IDs are stable references such as `P2-07`. Use these statuses in `STATUS.md`:

- `not_started`: no relevant implementation is known.
- `in_progress`: implementation or verification is incomplete.
- `implemented_unverified`: code exists, but the required phase checks have not passed.
- `blocked`: progress requires a named environment change or decision.
- `complete`: implementation and specified evidence both exist.
- `deferred`: deliberately moved out of MVP with an explanation.

A task is only `complete` when its code, tests, documentation impact, and verification evidence are all recorded.

No task may be marked `complete` if the final Docker Compose `npm run check` failed, was skipped, or ran only on the host.

## Required status update

After every meaningful work session, update:

- audit timestamp and commit;
- working branch and base commit;
- current phase and gate;
- completed task IDs with evidence;
- Docker Compose commands used and the final `npm run check` result;
- failed checks and the exact reason;
- deviations from the frozen plan;
- the next one to three executable actions;
- risks or decisions discovered.

Never store secrets, raw prompts, lease tokens, authorization headers, or real user data in these documents.
