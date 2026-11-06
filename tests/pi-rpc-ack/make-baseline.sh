#!/usr/bin/env bash
# 造「基线源码」：本次修复**之前**那份 agent-node，打进 E2E 镜像。
#
# 为什么需要它（2026-11-06）：修复后的代码里，15s 的 ack 预算已经被
# 地板（不低于 15s）+ 证据（compaction_start）+ 宽限兜住，**旧语义在新代码里
# 根本复现不出来**。要让「基线必死」这条断言有意义，只能跑修复前的源码。
# 用 git 的历史版本做基线，比在新代码里加一个「legacy 开关」诚实：
# 后者会让测试钉住一个生产里不该存在的路径。
#
# 用法：./make-baseline.sh [rev]   # rev 默认 = HEAD（修复未提交时即修复前）
set -euo pipefail
cd "$(dirname "$0")/../.."
REV="${1:-$(git rev-parse HEAD)}"
OUT="tests/pi-rpc-ack/baseline-agent-node.tar"
git archive --format=tar -o "$OUT" "$REV" agent-node
echo "baseline: $REV -> $OUT ($(du -h "$OUT" | cut -f1))"
tar -tf "$OUT" | grep -c "agent-node/" | sed 's/^/  文件数: /'
tar -xO -f "$OUT" agent-node/src/runtime/pi-rpc/runtime.ts | grep -n "15000" | head -3 | sed 's/^/  基线里的硬编: /'
