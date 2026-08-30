set -eu

tar -C /source --exclude='apps/*/node_modules' --exclude='apps/*/dist' -cf - \
  package.json package-lock.json tsconfig.base.json apps | tar --no-same-owner -C /workspace -xf -
npm ci --include=dev >/dev/null 2>&1
npm run build >/dev/null 2>&1
mkdir -p /workspace/gateway-data /workspace/gateway-workspaces /workspace/gateway-codex
mkdir -p /workspace/server-data /workspace/server-workspaces /workspace/server-codex

APP_DATA_DIR=/workspace/gateway-data AGENT_WORKSPACE_ROOT=/workspace/gateway-workspaces \
  CODEX_HOME=/workspace/gateway-codex NODE_ENV=production \
  node /probe/phase3-smoke.mjs gateway

APP_DATA_DIR=/workspace/server-data AGENT_WORKSPACE_ROOT=/workspace/server-workspaces \
  CODEX_HOME=/workspace/server-codex HOST=127.0.0.1 PORT=3999 NODE_ENV=production \
  node apps/server/dist/index.js >/workspace/phase3-server.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true' EXIT

node /probe/phase3-smoke.mjs rehearsals
