#!/usr/bin/env bash
# 纸面重建演练的「真跑」那一半：从仓库定义构建 hub 镜像并让它真的起来。
#
# 为什么要有这个脚本：AGENTS.md 要求关键链路在隔离环境做实际重建演练，未经演练
# 不得宣称「可恢复」。本脚本刻意**不碰生产**：
#   - 镜像标签用 anet-hub:drill，不覆盖现网在用的 anet-hub:compose；
#   - 端口用 19323，不抢 9200；
#   - 数据库用一次性目录与一次性 vault 密钥，不读 data/、不读 data/hub.env。
#
# 演练过的三件事（2026-11-04 实测）：
#   1. `bun install --frozen-lockfile` 能从 lockfile 复现依赖树；
#   2. entrypoint 对缺失 vault 密钥 fail-closed（不带密钥必须拒绝启动）；
#   3. 起来后 /health = 200 且容器 health=healthy。
#
# 顺带量出一条真实要求（第一遍就跑挂了才发现的）：bind mount 的数据目录必须
# 能被容器 uid(1000) 写。`docker run -v /tmp/x:/data` 自动建的目录是 root owned，
# 服务会在 bun:sqlite 建库时抛异常，日志里只看到 `new Database`，看不出是权限问题。
set -euo pipefail
cd "$(dirname "$0")/../../"
fail=0
TAG=anet-hub:drill
PORT=${DRILL_PORT:-19323}
NAME=anet-hub-drill
WORK="$(mktemp -d /tmp/anet-drill.XXXXXX)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; chmod -R 777 "$WORK" 2>/dev/null || true; rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT
[ -f deploy/compose/Dockerfile.hub ] || { echo "缺 deploy/compose/Dockerfile.hub" >&2; exit 1; }

echo "── 1) 构建（标签用 :drill，绝不覆盖现网的 anet-hub:compose）"
docker build -t "$TAG" --build-arg SOURCE_REV="$(git rev-parse HEAD)" \
  -f deploy/compose/Dockerfile.hub . > "$WORK/build.log" 2>&1 \
  && echo "  ok: 构建通过（lockfile 精确安装 + 源码拷贝）" \
  || { echo "  FAIL: 构建失败，见 $WORK/build.log" >&2; tail -20 "$WORK/build.log" >&2; exit 1; }
echo "  ok: label 记录源码提交 = $(docker inspect "$TAG" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"

echo "── 2) 缺 vault 主密钥必须拒绝启动（fail-closed，不许裸起）"
out="$(docker run --rm --entrypoint /usr/local/bin/anet-hub-entrypoint "$TAG" bun -e "1" 2>&1 || true)"
grep -q "ANET_HUB_SECRET_VAULT_KEY 未设置" <<<"$out" \
  && echo "  ok: 缺密钥被拒" \
  || { echo "  FAIL: 缺密钥没被拒：$out" >&2; fail=1; }

echo "── 3) 起来并真答 /health（一次性目录 + 一次性密钥，绝不读 data/）"
mkdir -p "$WORK/data" && chmod 777 "$WORK/data"   # 容器 uid 1000 要能写：见头部说明
docker run -d --name "$NAME" \
  -e HOST=0.0.0.0 -e PORT=9200 \
  -e ANET_HUB_SECRET_VAULT_KEY="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')" \
  -e COMMHUB_DB=/data/drill.db -e COMMHUB_UPLOADS_DIR=/data/uploads \
  -v "$WORK/data:/data" -p "$PORT:9200" "$TAG" >/dev/null
code=000
for _ in $(seq 1 40); do sleep 2; code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/health")"; [ "$code" = "200" ] && break; done
[ "$code" = "200" ] && echo "  ok: /health = 200" || { echo "  FAIL: /health = $code" >&2; fail=1; }
# 探针本身也要判得对：compose 定义的 healthcheck 必须把容器判成 healthy
state=none
for _ in $(seq 1 20); do sleep 3; state="$(docker inspect "$NAME" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"; [ "$state" = "healthy" ] && break; done
[ "$state" = "healthy" ] && echo "  ok: 镜像自带 healthcheck 判为 healthy" \
  || { echo "  FAIL: healthcheck 状态 = $state" >&2; fail=1; }
ver="$(curl -s --max-time 3 "http://127.0.0.1:$PORT/health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
echo "  ok: 自报版本 = ${ver:-未知}（这是镜像里源码的版本，不是现网版本）"

[ "$fail" = 0 ] && echo "hub 重建演练: PASS" || { echo "hub 重建演练: FAIL"; exit 1; }
