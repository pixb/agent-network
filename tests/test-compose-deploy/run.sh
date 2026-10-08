#!/usr/bin/env bash
# test-compose-deploy —— deploy/compose/ 生产套件的 E2E + 迁移演练
#
# 被测对象：compose.yaml / 两个 Dockerfile / entrypoint fail-closed / data 目录可整体搬迁。
# 隔离方式：专用 project 名 + 专用端口(19200/13000) + mktemp 数据目录 ——
#          不碰生产 9200/3000，不碰生产 data/，可在生产机上与真部署并行跑。
# 执行：bash tests/test-compose-deploy/run.sh   （需要宿主机 docker + compose v2）
set -euo pipefail

echo "# test-compose-deploy"
echo "date=$(date -Iseconds)"
echo "source_commit=$(git -C "$(cd "$(dirname "$0")/../.." && pwd)" rev-parse --short HEAD 2>/dev/null || echo unknown)"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# ---- 前置：缺执行器就是显式 SKIP（带 marker，和真绿可区分），不假装通过 ----
if ! command -v docker >/dev/null 2>&1; then
  echo "SKIP_NO_DOCKER (compose 套件以宿主 docker 为执行器)"
  exit 0
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "SKIP_NO_COMPOSE (需要 compose v2 插件)"
  exit 0
fi
if [ ! -S /var/run/docker.sock ]; then
  echo "SKIP_NO_DOCKER_SOCK (容器内无 sock；请在宿主机执行)"
  exit 0
fi
echo "docker=$(docker version --format '{{.Server.Version}}')"

compose() { docker compose -f deploy/compose/compose.yaml -p anet-test-compose "$@"; }

# ---- 隔离环境 ----
for p in 19200 13000; do
  if command -v ss >/dev/null 2>&1 && ss -tln 2>/dev/null | grep -q ":${p}[[:space:]]"; then
    echo "🔴 测试端口 $p 已被占用，拒绝跑（避免和既有服务混在一起得出假结论）"
    exit 1
  fi
done

WORK="$(mktemp -d /tmp/test-compose-deploy.XXXXXX)"
export HUB_PORT=19200 DASH_PORT=13000
export COMPOSE_DATA_DIR="$WORK/data"
mkdir -p "$COMPOSE_DATA_DIR"
printf 'ANET_HUB_SECRET_VAULT_KEY=%s\n' "$(openssl rand -hex 32)" >"$COMPOSE_DATA_DIR/hub.env"
chmod 600 "$COMPOSE_DATA_DIR/hub.env"

cleanup() {
  compose down --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

wait_hub() { # $1=base url  $2=what
  local i h=""
  for i in $(seq 1 60); do
    h="$(curl -fsS "$1/health" 2>/dev/null || true)"
    case "$h" in *'"ok":true'*) printf '%s' "$h"; return 0;; esac
    sleep 1
  done
  echo "🔴 $2 /health 60s 未就绪。容器状态：" >&2
  compose ps >&2 || true
  compose logs --tail 40 hub >&2 || true
  return 1
}

# ---- L1 compose 语法 ----
docker compose -f deploy/compose/compose.yaml config --quiet
echo "L1_PASS compose config"

# ---- L2 构建（源码 build） ----
compose build
echo "L2_PASS build"

# ---- L3 起 + hub 就绪 + 版本自报 == 源码版本 ----
compose up -d
H="$(wait_hub http://127.0.0.1:19200 hub)"
VER="$(printf '%s' "$H" | python3 -c 'import json,sys;print(json.load(sys.stdin)["version"])')"
PKG_VER="$(python3 -c 'import json;print(json.load(open("server/package.json"))["version"])')"
[ "$VER" = "$PKG_VER" ] || { echo "🔴 version 自报=$VER 源码=$PKG_VER"; exit 1; }
echo "L3_PASS hub healthy version=$VER"

# ---- L4 dashboard 被 depends_on 挡到 hub 健康之后且 /login 200 ----
code=""
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:13000/login || true)"
  [ "$code" = "200" ] && break
  sleep 1
done
[ "$code" = "200" ] || { echo "🔴 dashboard /login=$code（期望 200）"; exit 1; }
echo "L4_PASS dashboard /login 200"

# ---- L5 播种：注册用户（首用户=bootstrap admin）→ utok → 建 atok ----
REG="$(curl -fsS -X POST http://127.0.0.1:19200/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"composeadmin","password":"compose-e2e-2026"}')"
UID1="$(printf '%s' "$REG" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["ok"],d;print(d["user"]["user_id"])')"
TOKEN1="$(printf '%s' "$REG" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')"
# utok 能换回本人（证明 token 链路活）
ME="$(curl -fsS http://127.0.0.1:19200/api/auth/me -H "Authorization: Bearer $TOKEN1")"
printf '%s' "$ME" | grep -q "$UID1" || { echo "🔴 /api/auth/me 没认出播种用户: $ME"; exit 1; }
# MCP 走 atok（规划者侧真实用法）：POST /api/auth/tokens 用 utok 签发
ATOK="$(curl -fsS -X POST http://127.0.0.1:19200/api/auth/tokens \
  -H "Authorization: Bearer $TOKEN1" -H 'Content-Type: application/json' \
  -d '{"name":"compose-e2e"}' \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d.get("ok"),d;print(d["token"])')"
case "$ATOK" in atok_*) ;; *) echo "🔴 建出来的不是 atok: ${ATOK:0:8}..."; exit 1;; esac
NTOK="$(printf '%s' "$REG" | python3 -c 'import json,sys;print(json.load(sys.stdin)["network_token"])')"
case "$NTOK" in ntok_*) ;; *) echo "🔴 注册响应里没有 ntok"; exit 1;; esac
echo "L5_PASS seed user=$UID1 utok+atok+ntok work"

# ---- L6 MCP：initialize + tools/list（双侧 token），核心工具与需求池工具都在 ----
export ATOK NTOK
python3 - <<'PY'
import json, os, urllib.request, sys

BASE = "http://127.0.0.1:19200/mcp"
BASE_H = {"Content-Type": "application/json",
          "Accept": "application/json, text/event-stream"}

def rpc(payload, bearer, session=None):
    h = dict(BASE_H)
    h["Authorization"] = "Bearer " + bearer
    if session:
        h["Mcp-Session-Id"] = session
    req = urllib.request.Request(BASE, data=json.dumps(payload).encode(), headers=h)
    resp = urllib.request.urlopen(req, timeout=15)
    sid = resp.headers.get("mcp-session-id")
    body = resp.read().decode()
    data = None
    for line in body.splitlines():
        if line.startswith("data:"):
            data = json.loads(line[5:].strip())
    if data is None and body.strip():
        try: data = json.loads(body)
        except Exception: pass
    return data, sid

def tool_names(bearer):
    init, sid = rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "test-compose-deploy", "version": "0"}}}, bearer)
    assert init and "result" in init, f"initialize failed: {init}"
    try:
        rpc({"jsonrpc": "2.0", "method": "notifications/initialized"}, bearer, sid)
    except Exception:
        pass
    tools, _ = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, bearer, sid)
    return {t["name"] for t in tools["result"]["tools"]}

# 规划者侧（atok）：派发/验收/需求池
names_atok = tool_names(os.environ["ATOK"])
must_atok = {"send_task", "get_task", "list_tasks",
             "requirements_create", "requirements_list"}
missing = must_atok - names_atok
assert not missing, f"atok missing tools: {missing}"
# 工人侧（ntok）：心跳/回单
names_ntok = tool_names(os.environ["NTOK"])
must_ntok = {"report_status", "report_completion", "get_inbox", "ack_inbox"}
missing = must_ntok - names_ntok
assert not missing, f"ntok missing tools: {missing}"
print(f"L6_PASS mcp atok={len(names_atok)} ntok={len(names_ntok)} (requirements_* + worker tools in list)")
PY

# ---- L7 迁移演练：stop → tar data/ → 搬到新目录 → up → 登录同一用户 ----
compose stop >/dev/null
tar -C "$COMPOSE_DATA_DIR" -cf "$WORK/data.tar" .
RESTORE="$WORK/restore/data"
mkdir -p "$RESTORE"
tar -C "$RESTORE" -xf "$WORK/data.tar"
export COMPOSE_DATA_DIR="$RESTORE"
compose up -d
H2="$(wait_hub http://127.0.0.1:19200 hub-after-restore)"
VER2="$(printf '%s' "$H2" | python3 -c 'import json,sys;print(json.load(sys.stdin)["version"])')"
[ "$VER2" = "$PKG_VER" ] || { echo "🔴 restore 后 version=$VER2"; exit 1; }
LOGIN="$(curl -fsS -X POST http://127.0.0.1:19200/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"composeadmin","password":"compose-e2e-2026"}')"
UID2="$(printf '%s' "$LOGIN" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["ok"],d;print(d["user"]["user_id"])')"
[ "$UID2" = "$UID1" ] || { echo "🔴 restore 后 user_id 变了：$UID1 → $UID2"; exit 1; }
echo "L7_PASS migration restore (tar data/ → 新目录 → 同一用户登录)"

# ---- L8 entrypoint fail-closed：抽掉 vault 密钥必须拒启 ----
compose stop hub >/dev/null
mv "$COMPOSE_DATA_DIR/hub.env" "$COMPOSE_DATA_DIR/hub.env.away"
compose up -d hub
sleep 8   # entrypoint 拒启前 sleep 5，留出窗口（restart: unless-stopped 会反复重试，日志会累积）
LOGS="$(compose logs hub 2>/dev/null | tail -30 || true)"
HEALTH="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$(compose ps -q hub)" 2>/dev/null || echo missing)"
if printf '%s' "$LOGS" | grep -q "拒绝启动" && [ "$HEALTH" != "healthy" ]; then
  echo "L8_PASS vault fail-closed (拒绝启动, health=$HEALTH)"
else
  echo "🔴 L8 fail-closed 失败: health=$HEALTH"
  printf '%s\n' "$LOGS" >&2
  exit 1
fi
mv "$COMPOSE_DATA_DIR/hub.env.away" "$COMPOSE_DATA_DIR/hub.env"

echo "ALL_PASS test-compose-deploy"
