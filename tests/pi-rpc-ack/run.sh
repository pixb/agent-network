#!/usr/bin/env bash
# pi runtime — 慢设备现场的 Docker E2E（一次性 hub + 真 daemon + stub pi）。
#
# 为什么需要这个套件（2026-11-04）：`src/runtime/pi-rpc/` 此前零测试，而它的硬编
# 15s ack 在「低端设备 + 本地大模型」现场是必杀条件 —— 实测 prompt 前的自动压缩
# = 420–540s（82K token 摘要，摘要请求关闭 prompt-cache 写入 ⇒ 全量 prefill，
# 201 tok/s），引擎冷启动 884s。用户已明确**不改模型配置**，所以解法只能在节点代码里，
# 也就必须有能复现现场的套件来钉住它。
#
# 全部一次性：hub 起在本容器 127.0.0.1:9200、自己的 sqlite 文件、自己注册的用户/网络/
# 节点令牌；不连生产 hub、不碰生产端口、不碰生产数据。
#
# 断言看的是 hub 侧的真实落点（task 状态 + 回复正文 + 用户收件箱），不是进程退出码。
set -uo pipefail

REPO=/repo
WORK=/work
HUB=http://127.0.0.1:9200
ALIAS=pi-slow-node
NET_ID=""
UTOK=""
NTOK=""
STUB="$REPO/agent-node/src/runtime/pi-rpc/test-support/stub-pi.mjs"
fail=0
ok() { echo "  ok: $1"; }
bad() { echo "  FAIL: $1" >&2; fail=1; }
die() { echo "FATAL: $1" >&2; exit 1; }
json() { python3 -c "$1" 2>/dev/null; }
mcp() { bun "$WORK/mcp.mjs" "$UTOK" "$1" "$2"; }
cleanup() {
  pkill -f "bin/commhub.ts" >/dev/null 2>&1 || true
  pkill -f "agent-node/src/cli.ts" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "── 0) 源码身份"
echo "  source commit: ${SOURCE_COMMIT:-unknown}"
[ -f "$STUB" ] || die "缺 stub pi: $STUB"

echo "── 1) 纯行为层：pi-rpc 单测 + 重放门"
cd "$REPO/agent-node"
if bun test src/runtime/pi-rpc src/vendor-error-replay-gate.test.ts >"/tmp/unit.log" 2>&1; then
  ok "pi-rpc 单测 + vendor 重放门全绿（$(grep -c '(pass)' "/tmp/unit.log") 项）"
else
  bad "单测失败"; tail -25 "/tmp/unit.log"
fi

echo "── 2) 生产 bundle（发布身份 = 这份源码）"
if bun run build >/tmp/build.log 2>&1; then
  [ -f dist/cli.js ] && ok "agent-node bundle 构建通过" || bad "bundle 里没有 dist/cli.js"
else
  bad "bundle 构建失败"; tail -15 /tmp/build.log
fi

echo "── 3) 一次性 hub"
mkdir -p "$WORK"
cat > "$WORK/mcp.mjs" <<'EOF'
// 最小 MCP-over-HTTP 客户端（与 anet_manual_node.sh 的 transport 同一形状）
const [token, tool, argsJson] = process.argv.slice(2);
const hub = process.env.MCP_HUB || "http://127.0.0.1:9200";
const res = await fetch(hub + "/mcp", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-03-26",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: tool, arguments: JSON.parse(argsJson || "{}") } }),
});
const text = await res.text();
const lines = text.split("\n").filter((l) => l.startsWith("data:"));
const msg = lines.length ? JSON.parse(lines.map((l) => l.slice(5).trim()).join("")) : JSON.parse(text);
if (msg.error) { console.error("mcp error: " + JSON.stringify(msg.error)); process.exit(2); }
const t = msg?.result?.content?.[0]?.text;
console.log(t ? t : JSON.stringify(msg?.result ?? {}));
EOF

export COMMHUB_DB="$WORK/e2e.db" COMMHUB_UPLOADS_DIR="$WORK/uploads" HOST=127.0.0.1 PORT=9200
export ANET_HUB_SECRET_VAULT_KEY="$(python3 -c 'import secrets;print(secrets.token_hex(32))')"
mkdir -p "$COMMHUB_UPLOADS_DIR"
(cd "$REPO/server" && exec bun run bin/commhub.ts) >/tmp/hub.log 2>&1 &
code=000
for _ in $(seq 1 45); do sleep 2; code="$(curl -s -o /dev/null -w '%{http_code}' "$HUB/health")"; [ "$code" = 200 ] && break; done
[ "$code" = 200 ] && ok "hub /health = 200（一次性 sqlite：$COMMHUB_DB）" || { bad "hub 起不来（/health=$code）"; tail -20 /tmp/hub.log; exit 1; }

UTOK="$(curl -s -X POST "$HUB/api/auth/register" -H 'content-type: application/json' \
  -d '{"username":"pislow","password":"Pi-Slow-Test-123","email":"pi-slow@example.invalid"}' \
  | json "import sys,json;print(json.load(sys.stdin).get('token') or '')")"
[ -n "$UTOK" ] && ok "注册一次性用户（不打印令牌）" || die "注册失败"
NET_ID="$(curl -s -X POST "$HUB/api/networks" -H 'content-type: application/json' -H "Authorization: Bearer $UTOK" \
  -d '{"name":"pi-slow-net"}' | json "import sys,json;d=json.load(sys.stdin);print((d.get('network') or d).get('network_id') or '')")"
[ -n "$NET_ID" ] && ok "建网 $NET_ID" || die "建网失败"
# 铸节点令牌：payload 的键是 node_name（不是 alias），且这个端点本身就建/绑节点行
NODE_ID="n_$(python3 -c 'import secrets;print(secrets.token_hex(4))')"
NTOK="$(curl -s -X POST "$HUB/api/auth/node-token" -H 'content-type: application/json' -H "Authorization: Bearer $UTOK" \
  -d "{\"network_id\":\"$NET_ID\",\"node_name\":\"$ALIAS\",\"node_id\":\"$NODE_ID\"}" \
  | json "import sys,json;print(json.load(sys.stdin).get('token') or '')")"
[ -n "$NTOK" ] && ok "铸节点令牌 ntok_（不打印）" || die "铸节点令牌失败"
[ "${NTOK:0:5}" = "ntok_" ] && ok "节点令牌前缀 = ntok_" || bad "节点令牌前缀不是 ntok_：${NTOK:0:5}"

mkdir -p "$WORK/.anet/nodes/$ALIAS"
cat > "$WORK/.anet/nodes/$ALIAS/config.json" <<EOF
{"alias":"$ALIAS","hub":"$HUB","token":"$NTOK","network_id":"$NET_ID","node_id":"$NODE_ID","runtime":"pi-cli","session":"/tmp/stub-session.jsonl"}
EOF
chmod 600 "$WORK/.anet/nodes/$ALIAS/config.json"
mkdir -p "$HOME/.anet" && printf '{"hub":"%s","network_id":"%s"}\n' "$HUB" "$NET_ID" > "$HOME/.anet/config.json"

# stub `pi`：只实现 RPC 子集，行为由 env 脚本化（忠实顺序：compaction_start → 静默 →
# compaction_end → 才发 prompt 的 response，与真 pi 一致）
cat > /usr/local/bin/pi <<EOF
#!/usr/bin/env bash
exec bun "$STUB" "\$@"
EOF
chmod 755 /usr/local/bin/pi
printf '%s' '{"stub":"session-file"}' > /tmp/stub-session.jsonl

dispatch() { # $1=content
  local raw
  raw="$(mcp send_task "$(python3 -c "import json,sys;print(json.dumps({'network_id':'$NET_ID','alias':'$ALIAS','task':sys.argv[1],'ttl_seconds':600}))" "$1")" 2>>/tmp/dispatch.log)"
  printf '%s\n' "$raw" >> /tmp/dispatch.log
  printf '%s\n' "$raw" | json "import sys,json;d=json.load(sys.stdin);print(d.get('task_id') or d.get('message_id') or d.get('task',{}).get('task_id') or '')"
}
dispatch_diag() { echo "  · dispatch 原始响应见 /tmp/dispatch.log（容器随会话销毁）"; [ -f /tmp/dispatch.log ] && tail -3 /tmp/dispatch.log | sed 's/^/    /'; }
task_field() { mcp get_task "{\"task_id\":\"$1\"}" | json "import sys,json;d=json.load(sys.stdin);t=d.get('task') or d;print(t.get('$2') or '')"; }
DAEMON_PID=""
run_daemon() { # $1=log  $2=agent-node 树根（默认新代码）
  local tree="${2:-$REPO/agent-node}"
  ( cd "$WORK" && exec bun "$tree/src/cli.ts" --alias "$ALIAS" --runtime pi-cli --hub "$HUB" --log-level debug ) >"$1" 2>&1 &
  DAEMON_PID=$!
  sleep 12
}
stop_daemon() {
  # 镜像里没有 pkill（实测），所以按 PID 杀 + 确认真的没了。
  # 多个 daemon 并存会让「哪个 daemon 领了这个任务」变成随机的 ——
  # 断言就会打在还没有产出日志的日志文件上（本次调试实测到的假失败）。
  if [ -n "${DAEMON_PID:-}" ]; then
    kill -9 "$DAEMON_PID" >/dev/null 2>&1 || true
  fi
  if command -v pkill >/dev/null 2>&1; then pkill -9 -f "agent-node/src/cli.ts" >/dev/null 2>&1 || true; fi
  for _ in $(seq 1 20); do
    pgrep -f "agent-node/src/cli.ts" >/dev/null 2>&1 || break
    sleep 1
  done
  DAEMON_PID=""
  sleep 2
}

echo "── 4) 基线（修复前的源码，同一 stub 时序）：15s 硬编 ack 对上一次 20s 的压缩"
[ -f /baseline/agent-node/src/cli.ts ] || die "缺基线源码 /baseline/agent-node —— 先跑 tests/pi-rpc-ack/make-baseline.sh"
grep -q "message: prompt }, 15000" /baseline/agent-node/src/runtime/pi-rpc/runtime.ts \
  && ok "基线源码确实是修复前的（prompt 的 ack 硬编 15000）" \
  || bad "基线源码不是修复前那份（没有硬编 15000）—— 基线断言无意义"
export STUB_MODE=slow_ack_compaction STUB_COMPACT_MS=20000
export PI_SESSION_ROLLOVER_BYTES=0
rm -f /tmp/daemon-baseline.log
run_daemon /tmp/daemon-baseline.log /baseline/agent-node
TID="$(dispatch "基线：跑一个压缩 20s 的任务")"
[ -n "$TID" ] && ok "派活成功 task=${TID:0:8}…" || { dispatch_diag; die "派活失败"; }
st=""; res=""
for _ in $(seq 1 30); do sleep 3; st="$(task_field "$TID" status)"; res="$(task_field "$TID" result)"; case "$st" in replied|failed|expired|delivered) break;; esac; done
echo "  · hub 侧 status=$st result=${res:0:80}"
[ "$st" = "replied" ] && printf '%s' "$res" | grep -q "COMPACTED-REPLY" && bad "基线把压缩任务跑成了（说明基线不是修复前源码）" \
  || ok "基线没有产出本轮正文（15s 的 ack 被 20s 的压缩撞死）"
printf '%s' "$res" | grep -qiE "timeout|超时|未完成|失败" && ok "失败原因进了 hub 正文（运维不用翻日志）" \
  || bad "基线失败原因没进 hub 正文（result=${res:0:120}）"
grep -qE "timeout waiting pi response" /tmp/daemon-baseline.log \
  && ok "基线失败就是那句 timeout waiting pi response for prompt（现场日志里的原句）" \
  || bad "基线日志里没有这句超时（形状不对）"
grep -q "timeout waiting pi response" /tmp/daemon-baseline.log \
  && ! grep -q "本轮压缩" /tmp/daemon-baseline.log \
  && ok "基线看不见压缩成本（旧代码没有压缩计量 ⇒ 运维只能猜）" \
  || bad "基线也报了压缩（说明基线不是修复前那份）"
stop_daemon

echo "── 4b) 救援：ack 预算仍短于压缩，但证据窗把任务救回来（同一 stub 时序）"
export STUB_MODE=slow_ack_compaction STUB_COMPACT_MS=20000
export PI_PROMPT_ACK_TIMEOUT_MS=1500 PI_LATE_ACK_MS=30000 PI_LATE_SETTLE_GRACE_MS=90000 PI_SESSION_ROLLOVER_BYTES=0
rm -f /tmp/daemon-rescue.log
run_daemon /tmp/daemon-rescue.log
TIDB="$(dispatch "救援：同一个压缩 20s 的任务")"
[ -n "$TIDB" ] && ok "派活成功 task=${TIDB:0:8}…" || { dispatch_diag; die "派活失败"; }
stb=""; resb=""
for _ in $(seq 1 30); do sleep 3; stb="$(task_field "$TIDB" status)"; resb="$(task_field "$TIDB" result)"; case "$stb" in replied|failed|expired|delivered) break;; esac; done
echo "  · hub 侧 status=$stb result=${resb:0:80}"
[ "$stb" = "replied" ] && printf '%s' "$resb" | grep -q "COMPACTED-REPLY" \
  && ok "ack 超时不再等于任务失败：同一个任务交付了（基线那条必死）" \
  || bad "救援失败：status=$stb result=${resb:0:120}"
grep -q "ack 迟到" /tmp/daemon-rescue.log \
  && ok "ack 超时先取证再决定（没有立刻重发 —— 重发会让 pi 把同一任务跑两遍）" \
  || bad "日志里没有「ack 迟到」的取证记录"
# 断言用的字符串必须是代码真会打的日志句：
# 「…⇒ 视为已接受，继续等本轮，不重发」里有「不重发」三个字，按「重发」grep 会自打脸。
grep -q "重发恰好一次" /tmp/daemon-rescue.log && bad "有证据的情况下发生了重发（同一任务会跑两遍）" \
  || ok "本轮零次重复提交（证据窗里没有任何重发）"
stop_daemon

echo "── 5) 修好：ack 预算盖过压缩 ⇒ 任务完成，压缩成本可观测"
export STUB_MODE=slow_ack_compaction STUB_COMPACT_MS=20000
export PI_PROMPT_ACK_TIMEOUT_MS=40000 PI_LATE_ACK_MS=5000 PI_BUSY_POLICY=queue PI_TIMEOUT_MS=120000 PI_SESSION_ROLLOVER_BYTES=0
rm -f /tmp/daemon-new.log
run_daemon /tmp/daemon-new.log
TID2="$(dispatch "修好：跑同一个慢任务")"
[ -n "$TID2" ] && ok "派活成功 task=${TID2:0:8}…" || { dispatch_diag; die "派活失败"; }
st2=""; res2=""
for _ in $(seq 1 30); do sleep 4; st2="$(task_field "$TID2" status)"; res2="$(task_field "$TID2" result)"; case "$st2" in replied|failed|expired|delivered) break;; esac; done
echo "  · hub 侧 status=$st2"
[ "$st2" = "replied" ] && ok "压缩 20s 的任务在修好语义下正常交付" \
  || bad "任务没交付（status=$st2），结果正文：${res2:0:120}"
printf '%s' "$res2" | grep -q "COMPACTED-REPLY" && ok "回复正文就是这一轮产出（归属没串台）" || bad "回复正文不含本轮产出"
grep -q "本轮压缩 1 次" /tmp/daemon-new.log \
  && ok "压缩成本从事件流里实测并写进日志（82000 token 那一级），不靠猜" \
  || bad "日志里没有压缩成本记录"
grep -q "prompt ack " /tmp/daemon-new.log && ok "每轮记录 ack 延迟与 disposition（旋钮该设多大靠这个数）" || bad "没有 ack 延迟记录"
visible="$(curl -s -H "Authorization: Bearer $UTOK" "$HUB/api/messages?alias=pislow&network_id=$NET_ID&limit=200" \
  | json "import sys,json;d=json.load(sys.stdin);rows=d.get('messages') or d.get('rows') or d.get('inbox') or [];print(sum(1 for r in rows if 'COMPACTED-REPLY' in json.dumps(r)))")"
[ "${visible:-0}" -ge 1 ] && ok "交付进了指挥室按 alias 读到的收件流（Dashboard Messages 页可见）" \
  || bad "指挥室看不到这次交付（alias 查询里没有这次正文）"
stop_daemon

echo "── 6) 会话滚存：上下文到阈值就换新 session（不动用户模型配置的正面杠杆）"
python3 -c "open('/tmp/stub-session.jsonl','w').write('x'*4000)"
rm -f /tmp/stub-newsession.log /tmp/daemon-roll.log
export STUB_MODE=normal STUB_CALL_LOG=/tmp/stub-newsession.log STUB_SESSION_FILE=/tmp/stub-session.jsonl STUB_NEW_SESSION_ID=sess-rolled-1
export PI_SESSION_ROLLOVER_BYTES=1000 PI_PROMPT_ACK_TIMEOUT_MS=40000 PI_TIMEOUT_MS=120000
run_daemon /tmp/daemon-roll.log
TID3="$(dispatch "滚存：会话文件已到阈值")"
[ -n "$TID3" ] && ok "派活成功 task=${TID3:0:8}…" || { dispatch_diag; die "派活失败"; }
st3=""
for _ in $(seq 1 25); do sleep 4; st3="$(task_field "$TID3" status)"; case "$st3" in replied|failed|expired|delivered) break;; esac; done
[ "$st3" = "replied" ] && ok "滚存路径上任务照常交付（status=$st3）" || bad "滚存路径任务失败（status=$st3）"
[ -f /tmp/stub-newsession.log ] && grep -q '"command":"new_session"' /tmp/stub-newsession.log \
  && ok "真的调用了 new_session（stub 侧的调用记录为证）" || bad "阈值到了却没调用 new_session"
grep -q "会话滚存" /tmp/daemon-roll.log && ok "日志写明为什么滚存（阈值与会话文件大小）" || bad "滚存没有可读日志"
grep -q "会话已滚存" /tmp/daemon-roll.log && ok "滚存后写回新 sessionId（config.session 不再是旧会话）" || bad "没有滚存成功记录"
grep -q "携带" /tmp/daemon-roll.log && ok "跨任务记忆显式携带（收尾文本），不是靠摘要隐式背着跑" || bad "收尾携带没记录"
grep -q "sess-rolled-1" "$WORK/.anet/nodes/$ALIAS/config.json" \
  && ok "写回落到磁盘上的节点配置（重启后仍用新会话）" || bad "config.session 没有写回"

# 第二个任务：滚存之后的收尾携带必须有内容（记忆断在明处，不靠 82K 摘要隐式背着跑）
TID4="$(dispatch "滚存后的第二个任务")"
st4=""
for _ in $(seq 1 25); do sleep 4; st4="$(task_field "$TID4" status)"; case "$st4" in replied|failed|expired|delivered) break;; esac; done
[ "$st4" = "replied" ] && ok "滚存后的第二个任务照常交付" || bad "滚存后第二个任务失败（status=$st4）"
grep -qE "携带 [1-9][0-9]* 字符" /tmp/daemon-roll.log \
  && ok "第二轮起带上了上一轮收尾（跨任务记忆显式携带，不是 0 字符）" \
  || bad "第二轮收尾携带为 0（滚存等于断记忆）"
grep -q "前一轮收尾" /tmp/daemon-roll.log || true
stop_daemon

echo "── 诊断：daemon 日志里到底有什么（调试用，不影响判定）"
for f in /tmp/daemon-old.log /tmp/daemon-late.log /tmp/daemon-new.log /tmp/daemon-roll.log; do
  [ -f "$f" ] || continue
  echo "  $f: $(( $(wc -l < "$f") )) 行，[pi] 行 $(grep -c "\[pi\]" "$f" 2>/dev/null || echo 0)"
  grep "\[pi\]" "$f" 2>/dev/null | tail -4 | sed 's/^/    /'
done
echo "  daemon 日志落点探测："
ls -la "$WORK/.anet/nodes/$ALIAS/" 2>/dev/null | sed 's/^/    /'
find "$WORK" -name "*.log" -newer "$WORK/mcp.mjs" 2>/dev/null | head -5 | sed 's/^/    /'

echo
if [ "$fail" = 0 ]; then
  echo "pi-rpc-ack E2E: PASS（hub=一次性 sqlite $COMMHUB_DB；生产 hub / 端口 / 数据全程未触碰）"
else
  echo "pi-rpc-ack E2E: FAIL"; exit 1
fi
