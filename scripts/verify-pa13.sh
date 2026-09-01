#!/usr/bin/env bash
# Auction Phase 13 (PA13-09 .. PA13-19) verification.
# Run from the repository root on a host with Docker and a reachable registry.
set -euo pipefail

# Deliberately NOT exported. An exported LAUNCHPAD_ENV_FILE survives into the
# caller's shell if this script is sourced, and every later `docker compose up`
# in that shell then starts the server with no .env — which crash-loops on the
# APP_AUTH_TOKEN check. Pass it per command instead.
ENV_FILE="${LAUNCHPAD_ENV_FILE:-/dev/null}"

if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
  echo "Do not source this script — run it: ./scripts/verify-pa13.sh" >&2
  return 1 2>/dev/null || exit 1
fi

echo "== 1/3  Build the Compose image =="
LAUNCHPAD_ENV_FILE="$ENV_FILE" docker compose build launchpad

echo
echo "== 2/3  Standard scoped Docker Compose 'npm run check' (the gate) =="
LAUNCHPAD_ENV_FILE="$ENV_FILE" docker compose run --rm --no-deps --user root \
  -v "$PWD:/source:ro" \
  -v /workspace \
  -w /workspace \
  launchpad sh -lc "tar -C /source \
    --exclude='apps/*/node_modules' --exclude='apps/*/dist' \
    -cf - package.json package-lock.json tsconfig.base.json apps \
    | tar --no-same-owner -C /workspace -xf - \
    && npm ci --include=dev && npm run check"

echo
echo "== 3/3  Race and supervisor suites, ten consecutive passes (PA13-15) =="
LAUNCHPAD_ENV_FILE="$ENV_FILE" docker compose run --rm --no-deps --user root \
  -v "$PWD:/source:ro" \
  -v /workspace \
  -w /workspace \
  launchpad sh -lc "tar -C /source \
    --exclude='apps/*/node_modules' --exclude='apps/*/dist' \
    -cf - package.json package-lock.json tsconfig.base.json apps \
    | tar --no-same-owner -C /workspace -xf - \
    && npm ci --include=dev \
    && for i in \$(seq 1 10); do \
         echo \"--- race pass \$i ---\"; \
         npx vitest run --root apps/server \
           src/coordination/wave-repository.test.ts \
           src/coordination/repository.test.ts \
           src/coordination/lifecycle-reconciliation.test.ts \
           src/coordination/wave-supervisor.test.ts \
           src/thread-isolation.test.ts || exit 1; \
       done"

echo
echo "All Phase 13 checks passed."
echo "Expected: 31 server files / 573 tests, 4 web files / 57 tests, exit 0."
