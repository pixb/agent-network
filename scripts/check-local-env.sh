#!/usr/bin/env bash
# check-local-env.sh — 本机工作站健康探针（只读、秒级，不是产品测试）
#
# 抓的是「环境坏了却看着像代码坏了」这一类静默退化。最近一次真实事故
# （2026-11-23，home 从 /vol1/1000/pix 切回 /home/pix 之后）：
#   python3 因 RUNPATH 悬空起不来 → .agents/skills/agent-network-skill 的
#   eval 套件报 "12 errored"，看起来像 skill 坏了，实际每个 case 都在 shell 出去调 python3。
#   同一批遗留还有 ~/.npmrc 的 prefix 指向不存在的旧目录（npm i -g 会装到 PATH 之外）。
#
# 判据、实测数字与修复办法见 docs/runbooks/relocated-home-recovery.md。
#
# 用法: bash scripts/check-local-env.sh        # 退出码 0 = 健康
set -u

fails=0
ok()   { printf '  ok    %s\n' "$*"; }
warn() { printf '  warn  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }

REAL_HOME="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)"
[ -n "${REAL_HOME:-}" ] || REAL_HOME="${HOME:-}"

echo "local env check — HOME=$HOME"

# 1) $HOME 与 passwd 一致（home 搬家的第一现场）
if [ "${HOME:-}" = "$REAL_HOME" ]; then
  ok "\$HOME == passwd home ($REAL_HOME)"
else
  real_p="$(cd "${HOME:-/}" 2>/dev/null && pwd -P)"
  passwd_p="$(cd "$REAL_HOME" 2>/dev/null && pwd -P)"
  if [ -n "$real_p" ] && [ "$real_p" = "$passwd_p" ]; then
    ok "\$HOME 与 passwd home 是同一目录（不同写法）"
  else
    bad "\$HOME=$HOME 与 passwd home=$REAL_HOME 不一致 —— 解释器/工具里烘死的路径会全部错位"
  fi
fi

# 2) python3 真的能跑（不是「文件在」而是「进程起得来」）
if python3 -V >/dev/null 2>&1; then
  ok "python3 -V -> $(python3 -V 2>&1 | head -1)"
else
  bad "python3 起不来: $(python3 -V 2>&1 | head -1)"
  echo '        诊断: readelf -d "$(readlink -f "$(command -v python3)")" | grep -i runpath'
  echo '        修法: docs/runbooks/relocated-home-recovery.md'
fi

# 3) 解释器前缀必须落在 $HOME 下（系统解释器 /usr 也接受）
py="$(command -v python3 2>/dev/null || true)"
if [ -n "$py" ]; then
  case "$py" in
    "$REAL_HOME"/*) ok "python3 位于 \$HOME 下 ($py)" ;;
    /usr/bin/*|/bin/*) ok "python3 是系统解释器 ($py)" ;;
    *) warn "python3 来自意外位置: $py" ;;
  esac
fi

# 4) 编译扩展能加载（缺库时这里先炸，比上层误报早得多）
if python3 -c 'import ssl, sqlite3, ctypes, zlib, hashlib' >/dev/null 2>&1; then
  ok "编译扩展可加载 (ssl/sqlite3/ctypes/zlib/hashlib)"
else
  bad "编译扩展加载失败: $(python3 -c 'import ssl, sqlite3, ctypes' 2>&1 | tail -1)"
fi

# 5) pyenv 解释器里不应残留旧前缀（搬家后最典型的形态）
if [ -n "$py" ] && [[ "$py" == "$REAL_HOME"/.pyenv/* ]]; then
  prefix="$(python3 -c 'import sys; print(sys.prefix)' 2>/dev/null || true)"
  if [ -n "$prefix" ] && [[ "$prefix" == "$REAL_HOME"/* ]]; then
    ok "解释器前缀在 \$HOME 下 ($prefix)"
  else
    bad "解释器前缀不在 \$HOME 下: ${prefix:-<unknown>}"
  fi
  stale="$(python3 - <<'PY' 2>/dev/null || true
import os, subprocess, sys
prefix = sys.prefix
exe = os.path.join(prefix, "bin", "python3")
try:
    out = subprocess.run(["readelf", "-d", exe], capture_output=True, text=True).stdout
except Exception:
    print(""); raise SystemExit
for line in out.splitlines():
    if "runpath" in line.lower() or "rpath" in line.lower():
        if "/vol1/1000/pix" in line:
            print("stale-prefix-in-runpath"); raise SystemExit
print("")
PY
)"
  if [ -z "$stale" ]; then
    ok "RUNPATH 未引用已知的旧前缀"
  else
    bad "RUNPATH 仍引用旧前缀 —— 见 docs/runbooks/relocated-home-recovery.md"
  fi
fi

# 6) npm 全局 prefix 必须指向真实 home（否则 npm i -g 装到 PATH 之外）
if command -v npm >/dev/null 2>&1; then
  npm_prefix="$(npm config get prefix 2>/dev/null || true)"
  if [ "$npm_prefix" = "$REAL_HOME/.npm-global" ]; then
    ok "npm prefix == \$HOME/.npm-global"
  elif [ -z "$npm_prefix" ]; then
    warn "读不到 npm prefix"
  else
    bad "npm prefix=$npm_prefix，期望 $REAL_HOME/.npm-global（检查 ~/.npmrc）"
  fi
else
  warn "未安装 npm，跳过"
fi

if [ "$fails" -eq 0 ]; then
  echo 'local env: OK'
  exit 0
fi
echo "local env: $fails 项失败 —— 先按 docs/runbooks/relocated-home-recovery.md 处理，再判断代码问题"
exit 1
