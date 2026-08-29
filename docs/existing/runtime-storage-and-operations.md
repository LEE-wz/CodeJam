# Runtime, storage, configuration, and operations

## Runtime profiles

| Profile | Control plane | Codex execution | State location |
| --- | --- | --- | --- |
| `npm run dev` | Host Node/tsx + Vite | Host Codex process (`local-process`) | Paths from `.env`; defaults resolve from repository root. |
| `npm run poc` | Host production Node build | Disposable container per turn | macOS `~/.volc-agent-launchpad`; Linux `.local`; overridable. |
| Docker Compose/ECS | Application container | Codex child process in same container | Bind mounts at `/app/data`, `/app/workspaces`, `/app/codex-home`. |

`RUNTIME_PROVIDER` controls the runner, independently of `NODE_ENV`. The local
POC script forces `container`; Docker Compose leaves the `.env` default
`local-process` because Codex is already installed in the application image.

## Persistent paths

```text
APP_DATA_DIR/
└── launchpad.json             Agent, Message, and AgentRun metadata

AGENT_WORKSPACE_ROOT/
├── .deleted/                  timestamped archived workspaces
└── <agent UUID>/
    ├── AGENTS.md              regenerated platform instructions
    ├── README.md              generated workspace explanation
    ├── .gitignore             generated ignore rules
    └── ...                    files created by user/Agent

CODEX_HOME/
├── config.toml                regenerated Ark provider configuration
└── ...                        Codex session/runtime state
```

The repository `.gitignore` and `.dockerignore` exclude live data, workspace,
Codex state, environment files, builds, Terraform state, and dependencies.
`data/launchpad.json` or `codex-home` files visible in a working tree are local
runtime state, not source-contract examples; do not document or commit their
contents.

## Environment variables

### Server and security

| Variable | Default | Used by |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Fastify bind address; affects production token rule. |
| `PORT` | `3001` | Fastify listen port. |
| `PUBLIC_PORT` | `3001` | Compose host port/scripts; not parsed by server. |
| `LOG_LEVEL` | `info` | Fastify logger level. |
| `NODE_ENV` | `development` | CORS/static serving and production token validation. |
| `APP_AUTH_TOKEN` | empty | Shared bearer gate. URL-safe, max 128 characters. |

### Ark/Codex

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARK_API_KEY` | empty | Model credential passed only to server/runtime. |
| `ARK_MODEL` | empty | Responses-capable Ark endpoint/model ID. |
| `ARK_BASE_URL` | Beijing v3 URL | Trailing slashes removed before use. |
| `CODEX_HOME` | `<repo>/codex-home` | Generated config and sessions. |
| `CODEX_BIN` | `codex` | Local-process executable. |
| `CODEX_SANDBOX_MODE` | `workspace-write` | `read-only`, `workspace-write`, or `danger-full-access`. |
| `CODEX_TIMEOUT_MS` | `600000` | Per-turn execution deadline; minimum 1000. |
| `CODEX_MAX_OUTPUT_BYTES` | `2097152` | Combined runner stdout/stderr cap; minimum 65536. |

### Storage and container runtime

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_DATA_DIR` | `<repo>/.data` | JSON database directory. |
| `AGENT_WORKSPACE_ROOT` | `<repo>/workspaces` | Persistent Agent directories. |
| `RUNTIME_PROVIDER` | `local-process` | Runner selection: `local-process` or `container`. |
| `CONTAINER_ENGINE` | `docker` | Engine CLI; may be `podman` or another executable. |
| `CONTAINER_RUNTIME_IMAGE` | `volc-agent-runtime:local` | Disposable Runtime image tag. |
| `CONTAINER_CPU_LIMIT` | `2` | Per-turn container CPU limit. |
| `CONTAINER_MEMORY_LIMIT` | `2g` | Per-turn container memory limit. |
| `CONTAINER_PIDS_LIMIT` | `256` | Per-turn process limit. |
| `CONTAINER_USER` | host UID:GID or `1000:1000` | Container user identity. |
| `RUNTIME_INSTANCE_ID` | `default` | Container naming/cleanup scope. |

Build/start scripts additionally consume `LOCAL_POC_DATA_ROOT`, runtime base
image and apt mirror/package variables, Terraform credentials, and
`LAUNCHPAD_ENV_FILE`. `.env.example` is the canonical editable template.

## Local POC script

`scripts/start-local-poc.sh` is the most complete local entry point:

1. Requires Ark values and Node 22+.
2. Detects a working Docker CLI, starts Colima if available/needed, or uses
   Podman (including its macOS machine).
3. Installs npm dependencies only when `node_modules` is absent.
4. Selects persistent directories and a deterministic instance ID.
5. Builds `Dockerfile.runtime` with Codex CLI 0.111.0.
6. Preflights bind-mount write access using the configured container user.
7. Tests Codex's Linux Landlock sandbox. If unavailable, it warns and changes
   only the inner Codex mode to `danger-full-access`; the disposable outer
   container remains the boundary.
8. Builds web/server, starts the production server, and removes leftover
   Runtime containers for this instance on exit.

Each actual turn uses a new `docker/podman run --rm` invocation. Workspace and
Codex sessions survive because they are bind-mounted.

## Docker images and Compose

`Dockerfile.runtime` is the disposable turn image. It installs configurable
apt tools plus Codex and defaults to `/workspace`.

`Dockerfile` is a multi-stage complete-application image:

- build stage installs monorepo dependencies and builds web then server;
- runtime stage installs Git, ripgrep, certificates, and Codex 0.111.0;
- only production dependencies and compiled artifacts are copied;
- the process runs as Node's unprivileged `node` user;
- port 3001 and `/api/health` define runtime health.

`docker-compose.yml` builds that image, loads the chosen env file, forces
production paths, exposes `PUBLIC_PORT`, and bind-mounts state. It drops all
capabilities, enables `no-new-privileges`, uses an init, and limits the complete
application container to 2 CPUs, 4 GiB, and 512 PIDs.

`scripts/deploy-existing-ecs.sh` validates Docker 24+/Compose, creates and fixes
ownership of state directories, starts Compose, then tests Landlock inside the
application container. If unavailable it recreates with Codex
`danger-full-access` inside the outer Docker boundary.

## Volcengine Terraform path

`deploy/volcengine` provisions:

- one VPC (`172.20.0.0/16`) and subnet (`172.20.1.0/24`);
- a security group with restricted HTTP and SSH CIDRs and unrestricted egress;
- one post-paid ECS instance, system volume, and EIP;
- cloud-init that installs Docker, clones a public repository ref, writes the
  production environment, fixes volume ownership, and runs the existing-ECS
  deployment script.

The web CIDR is explicitly forbidden from being `0.0.0.0/0`. The Terraform
deployment script exports Ark and auth values into sensitive Terraform
variables. As the security docs note, the POC still places the Ark key in
Terraform state/user data; a real deployment needs managed secrets and remote
encrypted state.

## Security and trust boundaries

Controls already present:

- bearer token comparison uses equal-length buffers and `timingSafeEqual`;
- sensitive request headers are redacted from Fastify logs;
- runner commands are spawned with argv, not a shell;
- local containers mount only workspace and Codex home;
- output/time/resource limits and cancellation are implemented;
- remote production bind requires a non-placeholder 24+ character token;
- Terraform restricts inbound web CIDR.

Known baseline limitations:

- no identity, RBAC, ownership, tenant isolation, audit trail, CSRF protection,
  HTTPS termination, or managed secrets;
- broad runtime outbound network access;
- prompt-directed command and file execution by design;
- shared Codex home across Agents;
- no separate per-Agent container in the application-container/ECS profile;
- ordinary containers are not hardened multi-tenant isolation.
