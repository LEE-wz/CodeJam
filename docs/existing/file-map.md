# File and change map

## Repository tree

```text
CodeJam/
├── apps/
│   ├── server/                     Fastify control plane and runtime adapters
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts            Live composition/process entry point
│   │       ├── app.ts              HTTP/auth/static/error boundary
│   │       ├── agent-service.ts    Agent/Run application behavior
│   │       ├── config.ts           Environment schema + Codex config writer
│   │       ├── store.ts            Version-1 JSON persistence
│   │       ├── workspace.ts        Agent directory lifecycle
│   │       ├── types.ts            Baseline domain/runtime contracts
│   │       ├── errors.ts           Baseline service error types
│   │       ├── runner-factory.ts   Runtime-provider selection
│   │       ├── codex-runner.ts     Direct Codex process adapter
│   │       ├── container-codex-runner.ts
│   │       │                       Disposable Docker/Podman adapter
│   │       ├── coordination/       Dormant verified-handoff extension scaffold
│   │       │   ├── types.ts        Coordination domain model/default policy
│   │       │   ├── contracts.ts    Ports for all missing/concrete adapters
│   │       │   ├── errors.ts       Stable structured error type
│   │       │   ├── routes.ts       Optional route registration
│   │       │   └── service.ts      Background orchestration loop
│   │       └── *.test.ts           Vitest unit/boundary tests
│   └── web/                        React/Vite browser client
│       ├── index.html              Browser HTML entry
│       ├── vite.config.ts          Dev server/API proxy
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── main.tsx            React mount entry
│           ├── App.tsx             All current UI/state/behavior
│           ├── api.ts              Fetch client and in-memory bearer token
│           ├── types.ts            Browser response types
│           └── styles.css          Complete UI and responsive styling
├── scripts/
│   ├── bootstrap-local.sh          Create .env/state directories for Compose
│   ├── start-local-poc.sh          One-line local disposable-runtime flow
│   ├── deploy-existing-ecs.sh      Compose deploy/update on Linux ECS
│   └── deploy-volcengine.sh        Terraform wrapper and secret handoff
├── deploy/volcengine/
│   ├── versions.tf                 Terraform/provider pins
│   ├── variables.tf                Infrastructure/secret input contract
│   ├── main.tf                     Network, security group, ECS, EIP, user data
│   ├── outputs.tf                  Instance ID, public IP, application URL
│   ├── cloud-init.yaml.tftpl       Host bootstrap and repository deployment
│   ├── terraform.tfvars.example    Non-secret operator template
│   └── .terraform.lock.hcl         Provider checksums
├── docs/
│   ├── existing/                   This implementation index
│   ├── ARCHITECTURE.md              High-level supplied overview
│   ├── LOCAL_POC.md                 Local Docker/Podman operator guide
│   ├── DEPLOYMENT.md                ECS and Terraform operator guide
│   ├── HACKATHON_EXTENSION_GUIDE.md Hackathon scope/track requirements
│   ├── hackathon-v2-*.xml           Source fragments for challenge material
│   └── assets/                      README screenshots
├── Dockerfile                       Complete production application image
├── Dockerfile.runtime               Disposable local Agent Runtime image
├── docker-compose.yml               Complete application deployment
├── package.json                     npm workspace scripts and Node version
├── package-lock.json                Exact npm dependency graph
├── tsconfig.base.json               Strict shared server TypeScript options
├── .env.example                     Runtime configuration template
├── .gitignore / .dockerignore       Source/build/context boundaries
├── README.md                         User-facing project quick start
├── SECURITY.md                       Threat limitations and safe-use guidance
├── CONTRIBUTING.md                   Validation/contribution expectations
└── LICENSE                           MIT license
```

Runtime-only, ignored locations such as `.env`, `.local/`, `.data/`, `data/`,
`workspaces/`, `codex-home/`, build `dist/`, `node_modules/`, and Terraform
state are not source files. Preserve them unless the user explicitly requests
state cleanup.

## “Where do I make this change?”

| Desired change | Primary files | Also inspect/update |
| --- | --- | --- |
| Add/change an Agent field | server `types.ts`, `agent-service.ts`, web `types.ts`, `App.tsx` | `store.ts` migration/backward compatibility, API tests, forms. |
| Change Agent lifecycle rules | `agent-service.ts` | `types.ts`, lifecycle tests, button/composer rules in `App.tsx`. |
| Add a baseline REST endpoint | `app.ts` | service method, Zod schema, `api.ts`, web types/UI, boundary tests. |
| Add cross-cutting HTTP middleware | `app.ts` | `config.ts`, `.env.example`, security docs/tests. |
| Change JSON persistence | `store.ts`, `types.ts` | initialization/recovery in `agent-service.ts`, migration/tests. |
| Change generated workspace files | `workspace.ts` | create/update/delete tests and user docs. |
| Instrument the whole Run lifecycle | `agent-service.ts` | persistent model/store, API, UI, both runner adapters. |
| Change Codex invocation/event parsing | `codex-runner.ts` | `container-codex-runner.ts`, both runner tests, pinned Codex version. |
| Add a runtime provider | `types.ts`, new adapter, `runner-factory.ts` | `config.ts`, `.env.example`, `/api/system`, UI banner, scripts/images. |
| Change local container isolation | `container-codex-runner.ts`, `Dockerfile.runtime` | `start-local-poc.sh`, config schema, tests, security docs. |
| Change ECS/application-container runtime | `Dockerfile`, `docker-compose.yml` | deploy script, `.env.example`, deployment docs. |
| Add a frontend feature | `App.tsx`, `api.ts`, `types.ts`, `styles.css` | corresponding server endpoint/model and responsive layouts. |
| Activate coordination | concrete files under `coordination/`, `index.ts` | database migration, Agent reservations, app/API tests, full web feature. |
| Change infrastructure | `deploy/volcengine/*.tf` | tfvars example, cloud-init, deploy script, `docs/DEPLOYMENT.md`. |
| Add a config variable | `config.ts`, `.env.example` | scripts/Compose/Terraform, `/api/system` if safe, docs/tests. |
| Change build commands/dependencies | workspace `package.json` files | root scripts, lockfile, Dockerfiles, Node compatibility. |

## High-conflict files

Future teams should coordinate edits to these files because they concentrate
many responsibilities:

- `apps/server/src/index.ts`: every production service must be composed here.
- `apps/server/src/app.ts`: all baseline routes and cross-cutting HTTP behavior.
- `apps/server/src/agent-service.ts`: lifecycle and execution transactions.
- `apps/server/src/types.ts`: version-1 storage and runner contracts.
- `apps/web/src/App.tsx`: all current UI behavior.
- `apps/web/src/api.ts` and `types.ts`: every browser/server contract addition.
- `.env.example`: canonical configuration surface.
- `data/launchpad.json` at runtime: a whole-file store; never hand-edit while
  the server is running.

## Dependency direction

The live backend dependency direction is:

```text
index (composition)
├── app → AgentService public methods
└── AgentService
    ├── JsonStore
    ├── WorkspaceManager
    ├── AgentRunner interface
    └── config helpers
        └── CodexRunner or ContainerCodexRunner selected by factory
```

The coordination package is designed around inward-facing contracts:

```text
routes → CoordinationServiceContract ← CoordinationService
                                      → repository/workflow/context/
                                        protocol/runtime/directory ports
```

Keep concrete infrastructure at the edges and compose it in `index.ts`. This
preserves the existing ability to test services with fakes.

## Existing documentation roles

- Root `README.md`: fastest supported user/operator journey.
- `docs/ARCHITECTURE.md`: brief supplied architecture and track seams.
- `docs/LOCAL_POC.md`: engine setup, persistence, rootless Podman, troubleshooting.
- `docs/DEPLOYMENT.md`: existing ECS and full Terraform operation.
- `docs/HACKATHON_EXTENSION_GUIDE.md`: challenge scope, tracks, acceptance.
- `SECURITY.md`: security posture and known limitations.
- `docs/hackathon-v2-*.xml`: structured source content for event/challenge docs;
  they do not affect application runtime.
- `docs/development/overview.md`: currently untracked future coordination plan;
  it does not affect the build or runtime.
