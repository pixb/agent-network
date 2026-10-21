#!/usr/bin/env bash
# M0 探针 runner — 生成 pi 配置（stub provider），起 bun stub，跑 RPC 协议走查。
set -Eeuo pipefail
mkdir -p "${ARTIFACT_DIR:-/tmp/art}"
exec > >(tee "${ARTIFACT_DIR:-/tmp/art}/report-m0-pi-rpc-probe.txt") 2>&1

echo "=== M0 probe: pi RPC protocol walkthrough (offline stub) ==="
echo "pi version: $(pi --version)"
echo "node version: $(node --version)"
echo "bun version: $(bun --version)"

# --- pi 配置：自定义 stub provider（OpenAI-compatible, 指向本地 stub）---
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

# --- 启动 stub（OpenAI-compatible chat-completions, bun）---
STUB_PORT=32123 STUB_LOG=/tmp/stub.log bun /fixture/stub-server.ts &
STUB_PID=$!
trap 'kill "$STUB_PID" 2>/dev/null || true' EXIT
sleep 1

# --- 跑探针 ---
timeout 180s bun /fixture/probe.ts
echo 'PASS: M0 pi rpc probe'

echo
echo "=== M1: pi-rpc adapter integration tests (real pi + stub) ==="
bun test /fixture/pi-rpc-unit.test.ts
echo 'PASS: M1 pi-rpc adapter integration'

echo
echo "=== M3: pi-rpc safety hardening (D3 tools / D5 preflight / D7 rescue) ==="
bun test /fixture/pi-rpc-m3.test.ts
echo 'PASS: M3 pi-rpc safety hardening'

echo
echo "=== M4/L3: real ollama smoke (host.docker.internal:11434, qwen2.5:14b) ==="
bun test /fixture/pi-ollama-smoke.test.ts
echo 'PASS: M4/L3 real-model smoke (or skipped offline)'
