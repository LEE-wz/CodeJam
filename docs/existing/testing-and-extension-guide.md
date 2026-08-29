# Testing and extension guide

## Build and validation commands

From the repository root:

```bash
npm install
npm run typecheck
npm test
npm run build
```

`npm run check` runs typecheck, server tests, and the full build. Infrastructure
changes should also run:

```bash
terraform fmt -check -recursive deploy/volcengine
docker compose config
```

The repository requires Node 22+. Tests use Vitest and currently exist only in
the server workspace. Server compilation excludes `*.test.ts`; Vitest compiles
tests separately.

## Current automated coverage

| Test file | Covered behavior |
| --- | --- |
| `agent-service.test.ts` | CRUD/start/stop/delete, persisted conversation/thread, atomic one-Run admission, busy-start race. |
| `app.test.ts` | Shared-token protection, malformed JSON 400, oversized body 413. |
| `store.test.ts` | Failed persistence is not published in memory and mutation queue recovers. |
| `codex-runner.test.ts` | New/resumed CLI argv and JSON event extraction. |
| `container-codex-runner.test.ts` | Container argv/mounts/limits, secret absent from argv, Podman user namespace, resume. |
| `coordination/routes.test.ts` | Optional route auth/validation/create/start/events with fake service. |
| `coordination/service.test.ts` | Agent snapshots, role sequence, invalid-output retry, stop/duplicate-loop handling with fakes. |

## Important uncovered behavior

Baseline gaps:

- no frontend component or browser-flow tests;
- no real Codex/Ark integration test;
- no timeout, cancellation, output-overflow, force-kill, or spawn-error runner
  test;
- no restart-recovery test;
- no workspace generated-file/archive failure tests;
- limited endpoint coverage for CRUD, polling, and error states;
- no production static-serving test;
- no configuration boundary tests for remote production auth;
- no Docker/Podman/Compose smoke test in the normal test command.

Coordination gaps are broader: tests use fakes because concrete persistence,
workflow/context/protocol/runtime adapters and production composition do not yet
exist. See [Coordination scaffold](coordination-scaffold.md).

## Extension seams for hackathon features

### Trace and audit (“Glass Box”)

Best insertion points:

- wrap state transitions and runner calls in `AgentService.executeRun()`;
- extend `AgentRun` or add a versioned event/span collection in storage;
- enhance `parseCodexEventLine()` only for events actually emitted by the
  pinned Codex CLI;
- add trace endpoints in `app.ts` and timeline/tree UI in the web app;
- redact before persistence, not only at display time.

Maintain stable Agent/Run/trace/span IDs and cover success plus failure. The
current Run stores only final output/usage, so command-level evidence requires a
new event path rather than reconstructing it later.

### Identity and authorization (“Bouncer”)

Best insertion points:

- replace/augment the shared-token hook in `app.ts` with an authenticated
  principal on the request;
- add owner/human/Agent-principal fields with an explicit database migration;
- enforce ownership inside services/repositories, not in React;
- scope `getRun`, messages, workspaces, and all mutations;
- store safe allow/deny decisions server-side.

Do not interpret `APP_AUTH_TOKEN` as a user ID. Current IDs and routes have no
tenant boundary.

### Safety and sandboxing (“Kill Switch”)

Best insertion points:

- extend or wrap `AgentRunner` for threat-specific policy and evidence;
- add config and container controls in `container-codex-runner.ts`;
- change `Dockerfile.runtime`/startup preflight if the boundary needs extra
  tooling;
- persist explicit blocked/terminated/cleaned states through `AgentService`;
- display the control that stopped execution in React.

The supplied CPU/memory/PID/capability limits and Landlock fallback are
baseline behavior and do not themselves satisfy the hackathon track.

### Multi-Agent verified handoffs

Use the existing coordination interfaces rather than adding orchestration to
React or directly nesting calls in `AgentService`. Concrete repository/runtime
work must coordinate Agent availability and cancellation with the baseline
service so a participating Agent cannot accept an unrelated Playground Run.

## Change checklist

For any feature that changes behavior:

1. Identify its trust/state boundary and the live composition entry point.
2. Update server domain types and add a migration when persisted shape changes.
3. Put admission/enforcement in the backend or runtime, not only the browser.
4. Add service/adapter tests for the positive and failure/denial path.
5. Update route validation, response types, web API client, and UI together.
6. Update `.env.example`, scripts, Docker/Terraform, and safe `/api/system`
   fields when configuration changes.
7. Preserve shared-token redaction and never send credentials to the browser.
8. Run `npm run check` and relevant infrastructure validation.
9. Update the root operator docs and this implementation index if component
   ownership, behavior, or entry points changed.

## Persistence-change guidance

The current database declares `version: 1` and `JsonStore.initialize()` rejects
unsupported versions. Adding fields that are assumed to exist without a
migration can break existing POC state. For material schema changes:

- define the new version and explicit migration from v1;
- validate all top-level collections, not just `agents`;
- migrate before service recovery logic runs;
- preserve atomic temp-file rename behavior;
- test old-file upgrade, malformed input, persistence failure, and restart;
- do not make multiple server processes share this implementation.

## Runtime-change guidance

Both runtime providers should continue to produce equivalent `RunnerResult`
semantics. When altering Codex arguments or output parsing:

- update both direct and container argv tests;
- keep secrets out of argv/loggable structures;
- retain timeout/output/cancellation cleanup;
- check new behavior against the pinned Codex version in both Dockerfiles;
- decide whether a Codex home change affects cross-Agent/session isolation;
- verify local Docker and Podman when engine arguments change.

## Baseline acceptance smoke test

After a substantial extension, confirm that supplied behavior still works:

1. Start through the documented local POC path.
2. Create an Agent and inspect its generated workspace files.
3. Submit a prompt and observe queued/running/completed polling.
4. Send a second prompt and verify the same Codex thread resumes.
5. Try a concurrent prompt and verify it is rejected.
6. Stop an active Agent and verify cancellation settles.
7. Restart the server during a Run and verify recovery marks it cancelled.
8. Edit Agent instructions and verify `AGENTS.md` regeneration.
9. Delete the Agent and verify metadata removal plus workspace archival.
10. Confirm no Ark key/token appears in browser responses, logs, argv, or
    committed files.
