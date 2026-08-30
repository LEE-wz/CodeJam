set -e
tar -C /source --exclude='apps/*/node_modules' --exclude='apps/*/dist' -cf - \
  package.json package-lock.json tsconfig.base.json apps | tar --no-same-owner -C /workspace -xf -
npm ci --include=dev >/dev/null 2>&1
npm run build >/dev/null 2>&1
mkdir -p /workspace/tmp-data /workspace/tmp-ws /workspace/tmp-codex

start_server() {
  APP_DATA_DIR=/workspace/tmp-data AGENT_WORKSPACE_ROOT=/workspace/tmp-ws \
  CODEX_HOME=/workspace/tmp-codex HOST=127.0.0.1 PORT=3999 \
  APP_AUTH_TOKEN=phase2-smoke-token NODE_ENV=production \
  node apps/server/dist/index.js >>/workspace/server.log 2>&1 &
  SERVER_PID=$!
}

start_server
node /probe/phase2-smoke.mjs first
kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true

echo
echo "=== restarting the server over the same database ==="
start_server
node /probe/phase2-smoke.mjs restart
kill $SERVER_PID 2>/dev/null || true
