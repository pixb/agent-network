#!/usr/bin/env bash
# 生产栈（hub + dashboard）可重建定义的契约测试。
#
# 背景：现网容器在跑，但它们引用的 compose 定义与 entrypoint 在磁盘和 git 里都
# 没有副本（deploy/compose/compose.yaml 缺失、entrypoint.sh 只在镜像里）。
# 这个测试钉住补齐后的定义，让「补了但写错」不会静默通过。
#
# 只读现网：不构建、不启动、不碰任何运行中的容器。
set -euo pipefail
cd "$(dirname "$0")/../../deploy/compose"
fail=0
chk() { if eval "$2"; then echo "  ok: $1"; else echo "  MISSING: $1" >&2; fail=1; fi; }
absent() { if ! eval "$2"; then echo "  ok: $1"; else echo "  FORBIDDEN: $1" >&2; fail=1; fi; }

echo "── 权威副本必须存在（这三样此前都没有）"
for f in compose.yaml Dockerfile.hub entrypoint.sh .env.example hub.env.example dashboard.env.example README.md; do
  chk "$f 在仓库里" "git -C . ls-files --error-unmatch $f >/dev/null 2>&1 || test -f $f"
done
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

echo "── hub 镜像定义：可复现输入 + 运行形状"
chk "依赖安装参与 lockfile（bun install --frozen-lockfile，且 COPY 了 bun.lock）" \
  "grep -q -- '--frozen-lockfile' Dockerfile.hub && grep -q 'bun.lock' Dockerfile.hub"
chk "部署身份写进 label（pixb 提交，我们不发 npm）" \
  "grep -q 'org.opencontainers.image.revision' Dockerfile.hub && grep -q 'SOURCE_REV' Dockerfile.hub"
chk "非 root 运行" "grep -q '^USER bun' Dockerfile.hub"
chk "探针用 bun 发（容器里没有 curl，用 curl 的探针永远 unhealthy）" \
  "grep -q 'CMD bun -e' Dockerfile.hub || grep -q '\"bun\", \"-e\"' Dockerfile.hub"
chk "compose 侧 healthcheck 与镜像一致（5s/5s/20s/30 次，实测现网形状）" \
  "grep -q 'interval: 5s' compose.yaml && grep -q 'retries: 30' compose.yaml"

echo "── 数据边界"
chk "hub 有 ./data → /data 的 bind mount（生产 SQLite 不在镜像层里）" \
  "grep -q 'COMPOSE_DATA_DIR' compose.yaml && grep -q ':/data' compose.yaml"
chk "COMMHUB_DB 落在挂载点里（/data/commhub.db）" \
  "grep -q 'COMMHUB_DB: /data/commhub.db' compose.yaml"
chk "data/ 被 gitignore 排除（clone 不带生产数据）" \
  "git -C ../.. check-ignore -q deploy/compose/data/commhub.db"
chk "密钥走 env_file 且文件在 data/ 里（不进 compose.yaml、不进 git）" \
  "grep -q 'data/hub.env' compose.yaml"
chk "hub.env.example 写明必须恢复原值（新生成解不开旧密文）" \
  "grep -q '原值' hub.env.example"
absent "compose.yaml / 模板不含真实密钥值" \
  "grep -qE 'ANET_HUB_SECRET_VAULT_KEY=[0-9a-f]{16,}' compose.yaml"
chk ".dockerignore 把 node_modules 与 data/ 排除在构建上下文外" \
  "grep -q 'node_modules' ../../.dockerignore && grep -q 'deploy/compose/data' ../../.dockerignore"

echo "── 端口与拓扑：以实测为准"
chk "dashboard 宿主端口默认 3200（现网实测 3200→3000，不是 :3000/:3001）" \
  "grep -q 'DASH_PORT:-3200' compose.yaml && grep -q 'DASH_PORT=3200' .env.example"
chk "hub 宿主端口默认 9200" "grep -q 'HUB_PORT:-9200' compose.yaml"
chk "dashboard 依赖 hub 健康（现网 label: depends_on hub service_healthy）" \
  "grep -q 'condition: service_healthy' compose.yaml"
chk "README 记录实测拓扑（容器名/端口/挂载/镜像来源）" \
  "grep -q 'anet-dashboard-1' README.md && grep -q '3200' README.md && grep -q './data → /data' README.md"
chk "README 说明 dashboard 镜像在另一个仓库构建（跨仓库 build 会搅提交历史）" \
  "grep -q 'agent-network-dashboard' README.md"
chk "README 说明分支模型（pixb 生产 / 不发 npm / 部署身份=源码提交）" \
  "grep -qiE '不发 npm' README.md && grep -q '部署身份 = 源码提交' README.md"

chk "README 写明数据目录权限要求（容器 uid 1000 要能写，docker 自动建的是 root owned）" \
  "grep -q 'chmod 777 data' README.md && grep -q 'uid 1000' README.md"
chk "演练脚本存在，且用 throwaway 标签/端口（不覆盖现网镜像、不抢 9200）" \
  "grep -q 'anet-hub:drill' ../../tests/compose-rebuild/rebuild-drill.sh && grep -q '19323' ../../tests/compose-rebuild/rebuild-drill.sh"
absent "演练脚本不碰现网镜像标签 anet-hub:compose（覆盖它 = 下次 up 就把现网换掉）" \
  "grep -qE 'docker (build|tag).*-t anet-hub:compose' ../../tests/compose-rebuild/rebuild-drill.sh"
# 只扫非注释行：演练脚本头部写着一行「不读 data/hub.env」的说明，
# 扫全文会把这条声明当成违规（与 dashboard 侧探针检查同一类假阳性）。
absent "演练脚本不读 data/hub.env（密钥来头就是生产值，演练不拿它）" \
  "grep -vE '^[[:space:]]*#' ../../tests/compose-rebuild/rebuild-drill.sh | grep -q 'data/hub.env'"

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
[ "$fail" = 0 ] && echo "生产栈可重建契约: PASS" || { echo "生产栈可重建契约: FAIL"; exit 1; }
