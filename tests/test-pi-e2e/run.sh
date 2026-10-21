#!/usr/bin/env bash
# RFC-043 M4/L2 — pi-cli full-chain E2E (all offline via stub provider):
#   1. stub model service (OpenAI-compatible, bun)
#   2. pi config: stub provider in ~/.pi/agent (same as M0 probe)
#   3. CommHub server (server/src/index.ts, 127.0.0.1:9200)
#   4. agent-node --runtime pi-cli (bucket "pi") — headless node
#   5. MCP send_task -> pi processes it (pi RPC -> stub -> replyText)
#   6. poll /api/tasks -> "replied" -> result == PI_E2E_OK
# Negative control: a node with a nonexistent model must fail via preflight
# (RFC-043 D5), NOT hang.
set -Eeuo pipefail
mkdir -p "${ARTIFACT_DIR:-/tmp/art}"
exec > >(tee "${ARTIFACT_DIR:-/tmp/art}/report-pi-e2e.txt") 2>&1

PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

http() { bun /e2e/http-cli.ts "$@"; }
jq() { bun /e2e/jq.ts "$@"; }
httpb() { http "$@" | cut -f2-; }

echo "=== M4/L2: pi-cli full-chain E2E (hub + agent-node + pi RPC, stub) ==="
echo "pi version: $(pi --version)"
echo "node version: $(node --version)"
echo "bun version: $(bun --version)"

# 1) stub 模型服务
STUB_PORT=32123 STUB_LOG=/tmp/stub.log bun /fixture/stub-server.ts &
STUB_PID=$!
sleep 1

# 2) pi 配置（stub provider）
mkdir -p "$HOME/.pi/agent"
cat > "$HOME/.pi/agent/models.json" <<'EOF'
{
  "providers": {
    "stub": {
      "baseUrl": "http://127.0.0.1:32123",
      "models": [ { "id": "stub-model", "api": "openai-completions" } ]
    }
  }
}
EOF
cat > "$HOME/.pi/agent/auth.json" <<'EOF'
{ "stub": { "type": "api_key", "key": "stub-key" } }
EOF

cleanup() {
  kill "${AGENT_PID:-}" 2>/dev/null || true
  kill "${BAD_PID:-}" 2>/dev/null || true
  kill "${HUB_PID:-}" 2>/dev/null || true
  kill "$STUB_PID" 2>/dev/null || true
}
trap cleanup EXIT

# 3) CommHub
echo "--- hub ---"
cd /e2e
COMMHUB_SERVER=1 bun /check/server/src/index.ts > /tmp/hub.log 2>&1 &
HUB_PID=$!
for _ in $(seq 1 120); do
  CODE=$(http GET http://127.0.0.1:9200/health | cut -f1 || true)
  [ "$CODE" = "200" ] && break
  sleep 0.25
done
CODE=$(http GET http://127.0.0.1:9200/health | cut -f1 || true)
[ "$CODE" = "200" ] && pass "CommHub started" || { fail "CommHub start"; tail -20 /tmp/hub.log; exit 1; }

# hub 认证引导（V3 auth: register→token；已存在则 login→token）
echo "--- hub auth bootstrap ---"
TOKEN=""
for _ in 1 2 3 4 5; do
  REG=$(httpb POST http://127.0.0.1:9200/api/auth/register \
    '{"username":"e2e-bootstrap","password":"bootstrap-pass-123"}' || true)
  TOKEN=$(echo "$REG" | jq "token" || true)
  if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    LOGIN=$(httpb POST http://127.0.0.1:9200/api/auth/login \
      '{"username":"e2e-bootstrap","password":"bootstrap-pass-123"}' || true)
    TOKEN=$(echo "$LOGIN" | jq "token" || true)
  fi
  [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] && break
  sleep 1
done
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] && pass "hub auth bootstrap" || { fail "hub auth bootstrap"; tail -20 /tmp/hub.log; exit 1; }
export HUB_TOKEN="$TOKEN"

# network（V3 auth: 注册时自动建 1 个 network；node create 的 ntok 归属该 network，
# send_task 的 network_id 必须与其一致，否则 alias_not_found — M4 实测）
NETWORK_ID=$(echo "$REG" | jq "network_id" || true)
if [ -z "$NETWORK_ID" ] || [ "$NETWORK_ID" = "null" ]; then
  ME=$(httpb GET http://127.0.0.1:9200/api/auth/me || true)
  NETWORK_ID=$(echo "$ME" | jq "networks[0].network_id" || true)
fi
[ -n "$NETWORK_ID" ] && [ "$NETWORK_ID" != "null" ] && pass "network ready" || { fail "network bootstrap"; }

# anet login（让 node create 可用）
bun /check/agent-network/bin/cli.ts login \
  --hub http://127.0.0.1:9200 --username e2e-bootstrap --password bootstrap-pass-123 \
  > /tmp/anet-login.log 2>&1 || { echo "anet login log:"; tail -10 /tmp/anet-login.log; }
grep -qiE "logged in|ok|成功" /tmp/anet-login.log && pass "anet login" || echo "  note: anet login output: $(head -2 /tmp/anet-login.log)"

# 4) agent-node --runtime pi-cli 节点（用 anet 官方流程生成 config，含 hub token）
echo "--- node create ---"
cd /e2e
bun /check/agent-network/bin/cli.ts node create pi-e2e \
  --runtime pi-cli --model stub/stub-model \
  --no-interactive > /tmp/anet-create.log 2>&1 \
  || { echo "anet create log:"; tail -20 /tmp/anet-create.log; }
ls -la /e2e/.anet/nodes/pi-e2e/config.json 2>/dev/null \
  && pass "anet node create wrote config" \
  || fail "anet node create failed"
cd /e2e/.anet/nodes/pi-e2e
bun /check/agent-node/src/cli.ts --alias pi-e2e \
  --config /e2e/.anet/nodes/pi-e2e/config.json \
  --model stub/stub-model --hub http://127.0.0.1:9200 \
  > /tmp/agent-node.log 2>&1 &
AGENT_PID=$!
sleep 8

STATUS_BODY=$(httpb GET http://127.0.0.1:9200/api/status || true)
echo "$STATUS_BODY" | grep -q 'pi-e2e' \
  && pass "pi-cli node registered" || { fail "node register"; tail -20 /tmp/agent-node.log; exit 1; }

# 5) MCP send_task
echo "--- send task ---"
MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
http POST http://127.0.0.1:9200/mcp "$MCP_INIT" > /dev/null 2>&1 || true

TASK_RESP=$(httpb POST http://127.0.0.1:9200/mcp \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_task","arguments":{"alias":"pi-e2e","task":"Reply with exactly PI_E2E_OK","from_session":"e2e-bootstrap","network_id":"'"$NETWORK_ID"'"}}}' || true)
echo "$TASK_RESP" | grep -q 'ok' && pass "task sent" || { fail "task send: ${TASK_RESP:0:300}"; exit 1; }
echo "  resp head: $(echo "$TASK_RESP" | head -c 400)"

DATA_LINE=$(echo "$TASK_RESP" | grep '^data: ' | tail -1 | sed 's/^data: //' || true)
CONTENT_TEXT=$(echo "$DATA_LINE" | jq "result.content[0].text" || true)
TASK_ID=$(echo "$CONTENT_TEXT" | jq "message_id" || true)
[ -n "$TASK_ID" ] && pass "message_id=$TASK_ID" || { fail "no message_id"; exit 1; }

# 6) 轮询结果
echo "--- poll result ---"
RESULT=""
for i in $(seq 1 60); do
  sleep 1
  STATUS_BODY=$(httpb GET "http://127.0.0.1:9200/api/tasks?task_id=$TASK_ID" || true)
  if echo "$STATUS_BODY" | grep -q '"replied"'; then
    RESULT=$(echo "$STATUS_BODY" | jq "tasks[0].result" || true)
    pass "pi-cli processed task (${i}s)"
    break
  fi
  if [ $i -eq 60 ]; then
    echo "agent-node log tail:"; tail -25 /tmp/agent-node.log
    fail "pi-cli did not reply within 60s"
  fi
done
echo "  Result: $RESULT"
echo "$RESULT" | grep -q 'PI_E2E_OK' && pass "pi returned correct answer" || fail "answer mismatch"

# 7) 负控制：nonexistent model → preflight 拦截（不挂起）
echo "--- negative: bad model preflight ---"
cd /e2e
bun /check/agent-network/bin/cli.ts node create pi-bad \
  --runtime pi-cli --model no-such/stub-model \
  --no-interactive > /tmp/anet-create-bad.log 2>&1 || true
cd /e2e/.anet/nodes/pi-bad
bun /check/agent-node/src/cli.ts --alias pi-bad \
  --config /e2e/.anet/nodes/pi-bad/config.json \
  --model no-such/stub-model --hub http://127.0.0.1:9200 \
  > /tmp/agent-bad.log 2>&1 &
BAD_PID=$!
sleep 6
BAD_TASK=$(httpb POST http://127.0.0.1:9200/mcp \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"send_task","arguments":{"alias":"pi-bad","task":"Reply with exactly NOPE","from_session":"e2e-bootstrap","network_id":"'"$NETWORK_ID"'"}}}' || true)
echo "$BAD_TASK" | grep -q 'ok' && pass "bad-model task sent" || { fail "bad-model task send"; }
sleep 5
kill "$BAD_PID" 2>/dev/null || true
grep -qiE 'preflight|pi auth|invalid|not_ready' /tmp/agent-bad.log \
  && pass "bad model rejected by preflight (no hang)" \
  || { echo "agent-bad log tail:"; tail -20 /tmp/agent-bad.log; fail "bad model not rejected by preflight"; }

echo
echo "=== L2 result: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
