#!/bin/bash
# Hub 容器 entrypoint —— 与 deploy/hub/hub-daemon.sh 的预检 3 同一精神：
# 缺 vault 主密钥 → fail-closed 拒绝启动。
#
# 为什么不让它裸起：带着空密钥起来，既有密文会静默解不开 —— 比起不来更难查
# （hub-daemon.sh 设计约束 1）。
#
# 恢复指引也要说清楚：ANET_HUB_SECRET_VAULT_KEY 必须是**原值**（从加密备份或
# owner 安全交付）。现场新生成一个 64 hex 解不开历史密文 —— 那不是恢复。
set -euo pipefail

if [ -z "${ANET_HUB_SECRET_VAULT_KEY:-}" ]; then
  echo "[anet-hub-entrypoint] 🔴 ANET_HUB_SECRET_VAULT_KEY 未设置，拒绝启动。" >&2
  echo "[anet-hub-entrypoint]    密钥文件应位于 data/hub.env（见 deploy/compose/hub.env.example）。" >&2
  echo "[anet-hub-entrypoint]    从加密备份恢复**原值**；新生成的值解不开既有密文。" >&2
  sleep 5
  exit 1
fi

exec "$@"
