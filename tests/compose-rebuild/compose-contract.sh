#!/usr/bin/env bash
# 生产栈（hub + dashboard）可重建定义的契约测试。
#
# 背景：现网容器在跑，但它们引用的 compose 定义与 entrypoint 在磁盘和 git 里都
# 没有副本（deploy/compose/compose.yaml 缺失、entrypoint.sh 只在镜像里）。
# 这个测试钉住补齐后的定义，让「补了但写错」不会静默通过。
#
# 只读现网：不构建、不启动、不碰任何运行中的容器。
set -euo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"   # 脚本会 cd，之后 $0 不再指向自己
cd "$(dirname "$0")/../../deploy/compose"
fail=0
ran_lines=""   # 执行过的 chk/absent 声明行号（末尾去重比对）
chk() { ran_lines="$ran_lines ${BASH_LINENO[0]}"; if eval "$2"; then echo "  ok: $1"; else echo "  MISSING: $1" >&2; fail=1; fi; }
absent() { ran_lines="$ran_lines ${BASH_LINENO[0]}"; if ! eval "$2"; then echo "  ok: $1"; else echo "  FORBIDDEN: $1" >&2; fail=1; fi; }

echo "── 权威副本必须存在（这些此前都不在分支上）"
for f in compose.yaml Dockerfile.hub Dockerfile.dashboard entrypoint.sh .env.example hub.env.example README.md; do
  chk "$f 在仓库里" "git -C . ls-files --error-unmatch $f >/dev/null 2>&1 || test -f $f"
done
# 恢复来源要在 README 里写明：现网容器指向的定义曾经从分支上消失（3bf3150c6 不是 pixb 祖先）。
chk "README 写明恢复来源与提交号（不是凭记忆补的）" \
  "grep -q '3bf3150c6' README.md && grep -qiE '不是 pixb 的祖先|不是 pixb 祖先' README.md"
chk "README 写明 entrypoint 与镜像内副本逐字一致这条证据" \
  "grep -q 'entrypoint' README.md && grep -qiE '逐字一致' README.md"
if docker inspect anet-hub-1 >/dev/null 2>&1; then
  # 能碰到运行中的容器，就要求逐字一致：从镜像里取出的副本与仓库里的副本分叉，
  # 等于新构建跑的是另一套启动逻辑（fail-closed 那道门槛会默默变弱）。
  if docker exec anet-hub-1 cat /usr/local/bin/anet-hub-entrypoint 2>/dev/null | diff -q - entrypoint.sh >/dev/null 2>&1; then
    echo "  ok: entrypoint 与运行中镜像里那一份逐字一致"
  else
    echo "  FAIL: entrypoint 与运行中镜像里那一份不一致" >&2; fail=1
  fi
else
  echo "  skip: 本机碰不到 anet-hub-1，无法与镜像内副本比对（仅校验文件存在）"
fi

echo "── 基础镜像与依赖：可复现输入"
chk "hub 基础镜像钉 tag+digest（#1740 门；bun 钉 1.4.0 的理由在注释里）" \
  "grep -qE 'FROM oven/bun:[0-9.]+@sha256:[0-9a-f]{64}' Dockerfile.hub && grep -q '1.4.0' Dockerfile.hub"
chk "dashboard 基础镜像钉 tag+digest" \
  "grep -qE 'FROM node:[0-9.]+@sha256:[0-9a-f]{64}' Dockerfile.dashboard"
chk "hub 依赖安装参与 lockfile（bun install --frozen-lockfile，且 COPY 了 bun.lock）" \
  "grep -q -- '--frozen-lockfile' Dockerfile.hub && grep -q 'bun.lock' Dockerfile.hub"
chk "部署身份写进 label（pixb 提交，我们不发 npm）" \
  "grep -q 'org.opencontainers.image.revision' Dockerfile.hub && grep -q 'ARG SOURCE_REV' Dockerfile.hub"
chk "compose 把源码提交传进构建参数" "grep -q 'SOURCE_REV: \${ANET_SOURCE_REV:-unknown}' compose.yaml"
chk ".env.example 说明 ANET_SOURCE_REV 怎么传、怎么查" \
  "grep -q 'ANET_SOURCE_REV' .env.example && grep -q 'docker inspect' .env.example"
chk "dashboard 侧部署身份 = 钉住的 npm 版本（写进 label）" \
  "grep -q 'ARG DASH_VERSION' Dockerfile.dashboard && grep -q 'pinned_npm_version' Dockerfile.dashboard"
chk "dashboard 预置 ~/.anet/config.json（缺它每个 API 请求 500 ENOENT，2026-10-08 记过）" \
  "grep -q 'mkdir -p /home/node/.anet' Dockerfile.dashboard && grep -q 'config.json' Dockerfile.dashboard"
chk "非 root 运行（hub=bun，dashboard=node）" "grep -q '^USER bun' Dockerfile.hub && grep -q '^USER node' Dockerfile.dashboard"

echo "── 运行形状：以实测为准"
chk "hub 宿主端口默认 9200" "grep -q 'HUB_PORT:-9200' compose.yaml"
chk "dashboard 宿主端口 = 变量（现网 .env 设 3200→3000；:3000 上是 gitea，不是 dashboard）" \
  "grep -q 'DASH_PORT:-3000' compose.yaml && grep -qi 'DASH_PORT' .env.example"
chk "compose 项目名可覆盖（默认 anet = 现网容器名 anet-hub-1/anet-dashboard-1）" \
  "grep -q 'COMPOSE_PROJECT_NAME' compose.yaml && grep -q 'COMPOSE_PROJECT_NAME' .env.example"
chk "init: true（start.js 只转发 SIGINT，SIGTERM 需 init 代转）" "grep -q 'init: true' compose.yaml"
chk "hub env_file required: false（缺密钥文件也要能起容器）" "grep -q 'required: false' compose.yaml"
# 依赖方向必须按实测写，不能按直觉写。本机 inspect 逐字量过：
#   anet-dashboard-1 → depends_on = hub:service_healthy:false
#   anet-hub-1       → depends_on = （空）
# 即 dashboard 等 hub 健康才起，hub 不等 dashboard。写成反向的话，dashboard 挂掉时
# hub 会拒绝启动 —— 而 dashboard 挂了不影响 hub 收发消息，等于把单向故障变成全站故障。
HUB_BLK="awk '/^  hub:/{f=1} /^  dashboard:/{f=0} f' compose.yaml"
DASH_BLK="awk '/^  dashboard:/{f=1} f' compose.yaml"
chk "depends_on 方向 = dashboard 依赖 hub:service_healthy（实测方向）" \
  "$DASH_BLK | grep -q 'depends_on' && $DASH_BLK | grep -qE '^ *hub:'"
chk "依赖条件是 service_healthy（要 /health 真通过，不是进程起了就算）" \
  "$DASH_BLK | grep -q 'condition: service_healthy'"
chk "hub 无 depends_on（实测 label 为空；hub 不等 dashboard）" "! $HUB_BLK | grep -q 'depends_on'"
# 探针：flow 序列把 "bun" 与 "-e" 分成两行，`grep 'bun -e'` 恒假；
# 容器里没有 curl，写成 curl 的探针永远 unhealthy（依赖门就把 dashboard 锁死了）。
chk "hub 探针用 bun 发（容器内无 curl）" "$HUB_BLK | grep -q -- '"bun"' && $HUB_BLK | grep -q -- '"-e"' && $HUB_BLK | grep -q '/health'"
# 以 -- 结束选项解析：模式本身以 - 开头时，grep 会把它当选项（实测报
# 「option requires an argument -- 'e'」，检查静默失效）。
chk "dashboard 探针探 /login（公开 200；/ 与 /api/* 未登录时 307，探它们会把服务判成不健康）" \
  "$DASH_BLK | grep -q '"node"' && $DASH_BLK | grep -q '/login'"
chk "定义里不出现 curl 探针" "! grep -q '"curl"' compose.yaml"
chk "compose 侧 healthcheck 参数与现网一致（5s/5s/20s/30 次）" \
  "grep -q 'interval: 5s' compose.yaml && grep -q 'retries: 30' compose.yaml"
chk "README 记录实测拓扑（容器名/宿主端口/数据挂载）" \
  "grep -q 'anet-dashboard-1' README.md && grep -q '3200' README.md && grep -q 'COMPOSE_DATA_DIR' README.md"
chk "README 写明 dashboard 的两条镜像路径不可同时跑（本套件桥接 :3200 与 dashboard 仓库 host :3001）" \
  "grep -q 'Dockerfile.source' README.md && grep -qiE '不能同时跑|不可同时跑' README.md"
chk "README 写明分支模型（pixb 生产 / 不发 npm / 部署身份=源码提交）" \
  "grep -qi '不发 npm' README.md && grep -q '部署身份' README.md"
chk "README 写明数据目录权限要求（容器 uid 1000 要能写，docker 自动建的是 root owned）" \
  "grep -q 'chmod 777 data' README.md && grep -q 'uid(1000)' README.md"

echo "── 数据边界"
chk "hub 有 ./data → /data 的 bind mount（生产 SQLite 不在镜像层里）" \
  "grep -q 'COMPOSE_DATA_DIR' compose.yaml && grep -q ':/data' compose.yaml"
chk "COMMHUB_DB 落在挂载点里（/data/commhub.db）" \
  "grep -q 'COMMHUB_DB: /data/commhub.db' compose.yaml"
chk "data/ 被 gitignore 排除（clone 不带生产数据）" \
  "git -C ../.. check-ignore -q deploy/compose/data/commhub.db"
chk "密钥走 env_file 且文件在 data/ 里（不进 compose.yaml、不进 git）" "grep -q 'data/hub.env' compose.yaml"
# dashboard 的变量在 compose.yaml 里内联给（COMMHUB_URL=http://hub:9200）。
# 同目录不得留第二份 dashboard env 样例：那份写的是桥接形状下并不存在的变量，
# 且 dashboard 根本不读它 —— 两处并存必然漂移。
absent "无 dashboard.env.example 漂移（dashboard env 在 compose.yaml 内联）" "test -e dashboard.env.example"
chk "compose 内联 dashboard 的 COMMHUB_URL（内部服务名，非 IP）" "grep -q 'COMMHUB_URL: http://hub:9200' compose.yaml"
chk "hub.env.example 写明必须恢复原值（新生成解不开旧密文）" \
  "grep -q '原值' hub.env.example"
absent "compose.yaml / 模板不含真实密钥值" \
  "grep -qE 'ANET_HUB_SECRET_VAULT_KEY=[0-9a-f]{16,}' compose.yaml"
chk ".dockerignore 把 node_modules 与 data/ 排除在构建上下文外" \
  "grep -q 'node_modules' ../../.dockerignore && grep -q 'deploy/compose/data' ../../.dockerignore"

echo "── 套件级 E2E：README 指向的那套必须存在且能在本机跑"
E2E="../../tests/test-compose-deploy/run.sh"
chk "tests/test-compose-deploy/run.sh 存在" "test -f $E2E"
if [ -f "$E2E" ]; then
  # 写死 13000 的套件在本机跑不了（13000 是 grafana），只能拒绝运行；端口必须可覆盖。
  chk "E2E 端口可覆盖且默认值不变（HUB_PORT:-19200 / DASH_PORT:-13000）" \
    "grep -q 'HUB_PORT:-19200' $E2E && grep -q 'DASH_PORT:-13000' $E2E"
  # 顺序必须「先赋值、后检查」：颠倒时变量为空，检查形同虚设（实测踩过）。
  el=$(grep -n 'export HUB_PORT=' "$E2E" | head -1 | cut -d: -f1)
  cl=$(grep -n 'for p in "$HUB_PORT"' "$E2E" | head -1 | cut -d: -f1)
  chk "E2E 端口 export 在检查循环之前（export=第${el:-无}行，check=第${cl:-无}行）" \
    "[ -n \"$el\" ] && [ -n \"$cl\" ] && [ \"$el\" -lt \"$cl\" ]"
fi

echo "── compose.yaml 能被解析（在临时副本里跑，不碰工作目录）"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/data"
cp compose.yaml "$tmp/"
printf 'ANET_HUB_SECRET_VAULT_KEY=<placeholder>\n' > "$tmp/data/hub.env"
printf 'COMMHUB_URL=http://hub:9200\n' > "$tmp/dashboard.env"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  out="$(cd "$tmp" && docker compose config 2>&1 >/dev/null)" && rc=0 || rc=1
  if [ "$rc" = 0 ]; then echo "  ok: docker compose config 解析通过"
  else echo "  FAIL: docker compose config 解析失败: $out" >&2; fail=1; fi
  # 自检：证明上面那条检查对「重复键」真的有牙（compose-go 实测会报
  # mapping key "restart" already defined at line 4），不是只证明文件能跑。
  probe="$tmp/probe"; mkdir -p "$probe"
  printf 'services:\n  probe:\n    image: x\n    restart: always\n    restart: never\n' > "$probe/compose.yaml"
  if (cd "$probe" && docker compose config >/dev/null 2>&1); then
    echo "  FAIL: 故意写重键的样张被接受 → 解析检查没有牙" >&2; fail=1
  else
    echo "  ok: 重复键会被解析层抓到（样张实测被拒）"
  fi
else
  python3 -c "import yaml; yaml.safe_load(open('compose.yaml'))" \
    && echo "  ok: YAML 语法合法（本机无 docker，未做 compose 语义校验）" \
    || { echo "  FAIL: YAML 语法非法" >&2; fail=1; }
fi
# 自检（本轮踩过两次）：`chk "描述" \` 与它的参数行是一对；中间插进别的内容会被 bash 续行
# 拼接拆开，chk 收到的是字符串 "chk"，检查静默失效 —— 输出全绿而什么都没测。
# 声明条数必须等于真正执行过的条数。
declared="$(grep -c '^[[:space:]]*\(chk\|absent\) "' "$SELF" || true)"
executed="$(for n in $ran_lines; do echo "$n"; done | sort -u | grep -c '^[0-9]')";
if [ "${declared:-0}" != "${executed:-0}" ]; then
  echo "  FAIL: 声明 $declared 条检查，真正执行过的声明行只有 $executed 条（chk 被拆开 = 假绿）" >&2
  echo "  FAIL: 声明 $declared 条检查，真正执行过的声明行只有 $executed 条（chk 被拆开 = 假绿）" >&2
  fail=1
else
  echo "  ok: 声明的 $declared 条检查全部真正执行（无拆开的 chk 假绿）"
fi
[ "$fail" = 0 ] && echo "生产栈可重建契约: PASS" || { echo "生产栈可重建契约: FAIL"; exit 1; }
