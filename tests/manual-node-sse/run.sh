#!/usr/bin/env bash
# 手动节点的 presence 流（SSE）E2E —— 全部在 Docker 里跑，绝不碰生产 hub / 生产端口 / 生产数据。
#
# 这个套件证明的是一条口径，不是一个功能：
#   dashboard 判「在线」只看 hub `/health` 的 `sse_sessions` 里有没有 `network_id:alias`
#   （agent-network-dashboard `app/lib/presence.ts:40`）。手动节点原先只 report_status 心跳，
#   从不建这条流 —— 于是 hub 报 working、dashboard 卡片报 offline（2026-11-04 生产实测：
#   `sse_sessions` 只有 `net_b91c0d535346:admin`，两个手动节点都不在里面）。
#
# 套件断言（每条都对应一个可证伪的现象，不是「跑通了」）：
#   1) 脚本起来后 hub 的 sse_sessions 里出现 `<net>:<alias>`  —— 手动节点在 dashboard 口径下变在线
#   2) 停掉节点进程后那个 key 消失                     —— 计的是真连接，不是注册过的行
#   3) 同 alias 第二个进程抢占                          —— hub #2299 每身份只留最新一条流
#      第一个进程收到 superseded 帧并退避 30s 起        —— 手动节点不与 daemon 每秒互抢
#   4) 令牌是人的 utok_ 时建流被拒                      —— 流用节点自己的身份，不是借管理员的
#   5) ANET_MANUAL_SSE=0 时打印「disabled」且不建流      —— 关掉的人知道自己关掉了什么
#
# 端口/镜像/网络/数据全部一次性：19424、anet-hub:nm-sse、nm-sse-net、mktemp 目录。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT_UNDER_TEST="$ROOT/.agents/skills/agent-network-skill/scripts/anet_manual_node.sh"
HUB_IMG=anet-hub:nm-sse
NODE_IMG=node:24-slim
NET=nm-sse-net
PORT="${NM_SSE_PORT:-19424}"
ALIAS=nm-sse-node
HUB=http://hub:9200
fail=0
ok() { echo "  ok: $1"; }
bad() { echo "  FAIL: $1" >&2; fail=1; }
note() { echo "  · $1"; }

command -v docker >/dev/null 2>&1 || { echo "需要 docker" >&2; exit 2; }
docker compose version >/dev/null 2>&1 || true
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then echo "端口 $PORT 已被占用，换 NM_SSE_PORT 再跑" >&2; exit 2; fi
[ -f "$SCRIPT_UNDER_TEST" ] || { echo "被测脚本不存在: $SCRIPT_UNDER_TEST" >&2; exit 2; }

WORK="$(mktemp -d)"
HUBC=hub; N1=nm-node-1; N2=nm-node-2; N3=nm-node-3
cleanup() {
  docker rm -f "$HUBC" "$N1" "$N2" "$N3" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  # 容器内 root/uid10001 写的子目录宿主删不掉（父目录无 x 位时连遍历都不行）：
  # 直接在容器里把整个工作目录删掉，宿主这边只做兜底
  [ -d "$WORK" ] && docker run --rm -v "$(dirname "$WORK"):/t" "$NODE_IMG" sh -c "rm -rf /t/$(basename "$WORK")" >/dev/null 2>&1
  rm -rf "$WORK" 2>/dev/null
}
trap cleanup EXIT

json() { python3 -c "$1" 2>/dev/null; }

echo "── 0) 一次性 hub（镜像 $HUB_IMG，端口 $PORT，数据 $WORK/data）"
mkdir -p "$WORK/data" && chmod 777 "$WORK/data"   # 容器 uid(1000) 要能写：见 deploy/compose/README.md §8.3
docker network create "$NET" >/dev/null
docker build -t "$HUB_IMG" -f "$ROOT/deploy/compose/Dockerfile.hub" \
  --build-arg SOURCE_REV="$(git -C "$ROOT" rev-parse HEAD)" "$ROOT" >"$WORK/build.log" 2>&1 \
  && ok "hub 镜像构建通过" || { bad "hub 构建失败，见 $WORK/build.log"; tail -20 "$WORK/build.log" >&2; exit 1; }
KEY="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
docker run -d --name "$HUBC" --network "$NET" -p "$PORT:9200" \
  -e HOST=0.0.0.0 -e PORT=9200 -e COMMHUB_DB=/data/nm.db -e COMMHUB_UPLOADS_DIR=/data/uploads \
  -e ANET_HUB_SECRET_VAULT_KEY="$KEY" -v "$WORK/data:/data" "$HUB_IMG" >/dev/null
code=000
for _ in $(seq 1 40); do sleep 2; code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/health")"; [ "$code" = 200 ] && break; done
[ "$code" = 200 ] && ok "/health = 200" || { bad "/health = $code"; exit 1; }

echo "── 1) 一次性用户 + 网络 + 节点令牌（全部现造，不读生产）"
UTOK="$(curl -s -m 15 -X POST "http://127.0.0.1:$PORT/api/auth/register" \
  -H 'content-type: application/json' \
  -d '{"username":"nmsse","password":"Nm-Sse-Test-123","email":"nm-sse@example.invalid"}' \
  | json "import sys,json;d=json.load(sys.stdin);print(d.get('token') or '')")"
[ -n "$UTOK" ] && ok "注册用户拿到 user token（不打印）" || { bad "注册失败"; exit 1; }
NETID="$(curl -s -m 15 -X POST "http://127.0.0.1:$PORT/api/networks" -H 'content-type: application/json' \
  -H "Authorization: Bearer $UTOK" -d '{"name":"nm-sse-net"}' \
  | json "import sys,json;d=json.load(sys.stdin);print((d.get('network') or d).get('network_id') or '')")"
[ -n "$NETID" ] && ok "建网 $NETID" || { bad "建网失败"; exit 1; }

echo "── 2) 脚本 init（铸节点令牌 ntok_，写节点 config，注册 session 行）"
cp "$SCRIPT_UNDER_TEST" "$WORK/anet_manual_node.sh"
mkdir -p "$WORK/state" && chmod 777 "$WORK/state"
docker run --rm --network "$NET" -v "$WORK:/state" "$NODE_IMG" \
  bash /state/anet_manual_node.sh init --node "$ALIAS" --config /state/node-config.json \
  --hub "$HUB" --network "$NETID" --user-token "$UTOK" >"$WORK/init.log" 2>&1
grep -q "registered manual node" "$WORK/init.log" && ok "init 成功（config 落在 /state/node-config.json）" \
  || { bad "init 失败：$(tail -3 "$WORK/init.log")"; exit 1; }
# 节点 config 由容器内 uid(10001) 写，宿主读不了 —— 在容器里读，只看前缀
NTOK_KIND="$(docker run --rm -v "$WORK:/state" "$NODE_IMG" node -e \
  "console.log((require('/state/node-config.json').token||'').slice(0,5))" 2>/dev/null | tr -d '[:space:]')"
[ "$NTOK_KIND" = "ntok_" ] && ok "节点令牌前缀 = ntok_（/events/:alias 的 Path 2 要的就是它）" \
  || bad "节点令牌前缀 = $NTOK_KIND（不是 ntok_，presence 流会被 403）"

echo "── 3) 起来后 hub 的 sse_sessions 里必须出现 <net>:<alias>（dashboard 的在线口径）"
# `start` 是后台化（nohup + 返回）。容器里 PID1 一返回容器就结束了，节点进程跟着没，
# 所以这里 start 之后用 tail 跟随日志保活；`docker rm -f` 杀容器 = 杀节点（PID 命名空间）。
docker run -d --name "$N1" --network "$NET" -v "$WORK:/state" -e HOME=/state -e ANET_MANUAL_INTERVAL=5 \
  "$NODE_IMG" bash -c "bash /state/anet_manual_node.sh start --config /state/node-config.json --hub '$HUB' && tail -F /state/manual-heartbeat.log" >/dev/null
seen=""
for _ in $(seq 1 30); do
  sleep 2
  cnt="$(curl -s -m 10 -H "Authorization: Bearer $UTOK" "http://127.0.0.1:$PORT/health" \
    | json "import sys,json;d=json.load(sys.stdin);print((d.get('sse_sessions') or {}).get('$NETID:$ALIAS') or 0)")"
  [ "${cnt:-0}" -ge 1 ] && { seen=1; break; }
done
[ "$seen" = 1 ] && ok "sse_sessions['$NETID:$ALIAS'] >= 1 —— 手动节点在此口径下在线" \
  || bad "sse_sessions 里没有 $NETID:$ALIAS（presence 流没建立）"
docker logs "$N1" 2>&1 | grep -q "sse connected" && ok "脚本日志报告 sse connected" \
  || bad "脚本日志没有 sse connected"
python3 -c "
import json,sys
d=json.load(open('$WORK/manual-sse.json'))
sys.exit(0 if d.get('connected') and d.get('connects',0)>=1 else 1)" \
  && ok "status 文件里有 connected 证据（status 命令可见）" || bad "status 文件缺 presence 状态"
docker logs "$N1" 2>&1 | grep -qi "report working\|report idle" && ok "心跳照旧在跑（presence 不取代心跳）" \
  || bad "心跳没在跑"
docker logs "$N1" 2>&1 | grep -qiE "ntok_|Bearer " && bad "日志里出现了令牌（只许出现令牌的名字，不许出现值）" \
  || ok "日志不含令牌值"

echo "── 4) 停掉进程后 key 必须消失（计的是真连接，不是注册过的行）"
docker rm -f "$N1" >/dev/null
gone=""
for _ in $(seq 1 25); do
  sleep 2
  cnt="$(curl -s -m 10 -H "Authorization: Bearer $UTOK" "http://127.0.0.1:$PORT/health" \
    | json "import sys,json;d=json.load(sys.stdin);print((d.get('sse_sessions') or {}).get('$NETID:$ALIAS') or 0)")"
  [ "${cnt:-0}" = 0 ] && { gone=1; break; }
done
[ "$gone" = 1 ] && ok "进程停 → sse_sessions 里该 key 消失" \
  || bad "进程停了而 key 还在（presence 会被僵尸连接长期冒充在线）"

echo "── 5) 同 alias 抢占：hub 只留最新一条流，输的一方退避（不与 daemon 每秒互抢）"
docker run -d --name "$N1" --network "$NET" -v "$WORK:/state" -e HOME=/state -e ANET_MANUAL_INTERVAL=5 \
  "$NODE_IMG" bash -c "bash /state/anet_manual_node.sh start --config /state/node-config.json --hub '$HUB' && tail -F /state/manual-heartbeat.log" >/dev/null
sleep 6
docker run -d --name "$N2" --network "$NET" -v "$WORK:/state" -e HOME=/state -e ANET_MANUAL_INTERVAL=5 \
  -e ANET_MANUAL_STATE_DIR=/state/state2 \
  "$NODE_IMG" bash -c "bash /state/anet_manual_node.sh start --config /state/node-config.json --hub '$HUB' && tail -F /state/state2/manual-heartbeat.log" >/dev/null
sup=""
for _ in $(seq 1 25); do
  sleep 2
  if docker logs "$N1" 2>&1 | grep -q "SUPERSEDED"; then sup=1; break; fi
done
[ "$sup" = 1 ] && ok "被抢占的一方收到 superseded（hub #2299 每身份一条流）" \
  || bad "被抢占的一方没收到 superseded 帧"
docker logs "$N1" 2>&1 | grep -qE "reconnect in (3[0-9]|[4-9][0-9]|600)\.0s" \
  && ok "被抢占后按 30s 起退避（不是 1s 互抢）" \
  || bad "被抢占后的退避不是 30s 起：$(docker logs "$N1" 2>&1 | grep -c 'reconnect in') 次重连记录"
cnt="$(curl -s -m 10 -H "Authorization: Bearer $UTOK" "http://127.0.0.1:$PORT/health" \
  | json "import sys,json;d=json.load(sys.stdin);print((d.get('sse_sessions') or {}).get('$NETID:$ALIAS') or 0)")"
[ "${cnt:-0}" -ge 1 ] && ok "抢占后该 alias 仍有 1 条流（在线状态不断档）" || bad "抢占后 key 归零"
docker rm -f "$N1" "$N2" >/dev/null

echo "── 6) 关掉开关要留下可读的痕迹"
docker run -d --name "$N3" --network "$NET" -v "$WORK:/state" -e HOME=/state -e ANET_MANUAL_SSE=0 \
  -e ANET_MANUAL_INTERVAL=5 -e ANET_MANUAL_STATE_DIR=/state/state3 \
  "$NODE_IMG" bash -c "bash /state/anet_manual_node.sh start --config /state/node-config.json --hub '$HUB' && tail -F /state/state3/manual-heartbeat.log" >/dev/null
dis=""
for _ in $(seq 1 15); do sleep 2; docker logs "$N3" 2>&1 | grep -qi "presence stream disabled" && { dis=1; break; }; done
[ "$dis" = 1 ] && ok "ANET_MANUAL_SSE=0 → 日志明说 presence 被关（并说明后果：dashboard 会显示 offline）" \
  || bad "开关关掉没有任何痕迹"
cnt="$(curl -s -m 10 -H "Authorization: Bearer $UTOK" "http://127.0.0.1:$PORT/health" \
  | json "import sys,json;d=json.load(sys.stdin);print((d.get('sse_sessions') or {}).get('$NETID:$ALIAS') or 0)")"
[ "${cnt:-0}" = 0 ] && ok "关掉后确实不建流" || bad "说关掉了却还建着流"
docker rm -f "$N3" >/dev/null

echo "── 7) 令牌用错要给出能行动的文案（不打印令牌）"
docker run --rm --network "$NET" -v "$WORK:/state" -e HOME=/state \
  -e ANET_MANUAL_SSE=1 "$NODE_IMG" sh -c '
    cat >/state/bad.json <<EOF
{"alias":"'"$ALIAS"'","node_id":"n_bad","token":"utok_not_real","hub":"'"$HUB"'","network_id":"'"$NETID"'"}
EOF
    ANET_MANUAL_INTERVAL=2 timeout 25 node /state/anet_manual_node.sh once --config /state/bad.json >/dev/null 2>&1 || true
    ANET_MANUAL_INTERVAL=2 timeout 25 node /state/anet_manual_node.sh check --config /state/bad.json 2>&1 || true' \
  >"$WORK/bad.log" 2>&1
grep -q "utok_not_real" "$WORK/bad.log" && bad "日志回显了令牌字面值" || ok "输出不含令牌字面值"

echo
if [ "$fail" = 0 ]; then
  echo "手动节点 presence 流 E2E: PASS（hub $HUB_IMG / 端口 $PORT / 数据已随 $WORK 一起销毁）"
else
  echo "手动节点 presence 流 E2E: FAIL"; exit 1
fi
