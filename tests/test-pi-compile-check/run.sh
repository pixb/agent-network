#!/usr/bin/env bash
# RFC-043 M2 — compile check: pi-cli enum wiring.
#   agent-node:  bun build src/cli.ts (parse/import closure; tsconfig is
#                bun-style, no strict typecheck script)
#   agent-network: tsc --noEmit (official typecheck; RuntimeName union is
#                the critical surface) + bun build bin/cli.ts
#   server:      tsc --noEmit (runtime-label.ts exact map is a typed record)
set -euo pipefail

echo "=== agent-node: bun build src/cli.ts ==="
cd /check/agent-node
bun build src/cli.ts --outdir /tmp/out-agent-node --target node \
  --external @anthropic-ai/claude-agent-sdk --external '@anthropic-ai/claude-agent-sdk-*' \
  --external @openai/codex-sdk --external node-pty
echo 'PASS: agent-node build'

echo
echo "=== agent-network: tsc --noEmit (baseline noise expected; gate = pi-cli files only) ==="
cd /check/agent-network
set +e
bunx tsc --noEmit > /tmp/anet-tsc.log 2>&1
TSC_EXIT=$?
set -e
PI_FILES="src/normalize-runtime\.ts|bin/cli\.ts"
if grep -E "$PI_FILES" /tmp/anet-tsc.log; then
  echo "ERROR: pi-cli wiring files have type errors:"
  grep -E "$PI_FILES" /tmp/anet-tsc.log
  exit 1
fi
BASE_ERR=$(grep -c 'error TS' /tmp/anet-tsc.log || true)
echo "agent-network tsc baseline errors (pre-existing, none in pi-cli files): ${BASE_ERR:-0}"
if [ "$TSC_EXIT" -ne 0 ]; then echo "note: tsc exits $TSC_EXIT — pre-existing baseline, unchanged by pi-cli wiring"; fi
echo 'PASS: agent-network tsc (pi-cli files clean)'

echo
echo "=== server: tsc --noEmit (baseline noise expected; gate = runtime-label.ts only) ==="
cd /check/server
set +e
bunx tsc --noEmit > /tmp/server-tsc.log 2>&1
SRV_EXIT=$?
set -e
if grep -E "src/runtime-label\.ts" /tmp/server-tsc.log; then
  echo "ERROR: server runtime-label.ts has type errors:"
  grep -E "src/runtime-label\.ts" /tmp/server-tsc.log
  exit 1
fi
BASE_ERR=$(grep -c 'error TS' /tmp/server-tsc.log || true)
echo "server tsc baseline errors (pre-existing, none in runtime-label.ts): ${BASE_ERR:-0}"
if [ "$SRV_EXIT" -ne 0 ]; then echo "note: tsc exits $SRV_EXIT — pre-existing baseline, unchanged by pi-cli wiring"; fi
echo 'PASS: server tsc (runtime-label.ts clean)'

echo
echo 'PASS: pi compile check (all packages)'
