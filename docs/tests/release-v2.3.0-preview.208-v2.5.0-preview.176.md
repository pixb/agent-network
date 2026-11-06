# @sleep2agi/agent-network 2.3.0-preview.208 / @sleep2agi/agent-node 2.5.0-preview.176

成对发布（**本地成对 tgz，不发 npm**）。pair 常量 = `.208` / `.176`，出自同一棵树。

## Why

RFC-043 的 pi-cli 运行时在 2026-10-29 的 rebase 中被丢掉（只搬走 tip 修复），
`anet node create --runtime pi-cli` 报 `unsupported runtime "pi-cli"`。
pi 实现恢复进 `pixb` 后，npm 上没有任何 agent-node 版本带 pi 运行时
（实测 `.147/.148/.154/.159/.165/.175` 全都没有），所以必须自己出成对包。

残缺树打的 `2.3.0-preview.200` / `2.5.0-preview.165` 已删除。

## What's in the pair

- `agent-network/src/normalize-runtime.ts`：`canonicalizeRuntime` 有 `pi`/`pi-cli` 分支（缺它就是你看到的报错）
- `agent-node/src/runtime/pi-rpc/`：client / events / preflight / runtime
- `agent-node/src/cli.ts`：`"pi-cli": "pi"` 映射 + RPC 会话 + preflight
- 三份 runtime 集合一致：CLI `SUPPORTED_RUNTIME_NAMES` / daemon `VALID_RUNTIMES` / hub `RUNTIMES`
- server 门断言「恰好八个」+ `toContain("pi-cli")`
- goals bucket `pi`（`goals scheduler: enabled (runtime=pi)`）
- `clone-node` 的 `transcript_when_present` 分支

## Verification（本机，2026-11-03）

```text
normalize-runtime.test.ts                 45 pass / 0 fail
create-node-validate.test.ts              47 pass / 0 fail   （「恰好八个」+ toContain("pi-cli")）
runtime-set-parity.test.ts                 3 pass / 0 fail   （#1298 三份集合等价）
clone-node.test.ts                         7 pass / 0 fail   （需 COMMHUB_DB=/tmp/test-$$.db）
agent-network tsc --noEmit                exit 0
agent-node bun build / agent-network bun build   通过
scripts/sync-pinned-versions.sh           dry-run → --apply（package.json + lock + pair 常量）
scripts/check-doc-version-claims.py       通过
checkRuntimeDependency 探针               agent-node --help 声明 pi-cli
端到端（私有 prefix 装 .208 + ANET_AGENT_NODE_BIN 指向本地 .176）：
  create --runtime pi-cli --pi-unsafe-tools  → 建成
  node start                                 → 已注册到 CommHub / SSE connected / goals scheduler: enabled (runtime=pi)
  MCP send_task "只回复一句话：PI_E2E_OK"    → status=replied, result="[pi-verify] PI_E2E_OK"
```

pi 侧模型来源：`~/.pi/agent/models.json` provider `local` = `swift-1.5-iq3_xxs` @ `http://192.168.1.21:8080/v1`。

## What it does not do

- **不发 npm**。对外 npm 产物只从 `main` 发布（AGENTS 规则）；这组是 `pixb` 的本地成对包。
  npm 上的 `agent-node` 至今没有任何版本带 pi 运行时，所以 `node start --runtime pi-cli`
  在纯 npm 安装下会被 candidate 守卫拒（"the candidate agent-node does not advertise pi-cli"）。
  用本组必须显式给出本地 agent-node：`ANET_AGENT_NODE_BIN=<abs>/agent-node/dist/cli.js`，
  或把 `.176` 装进 anet 能解析到的位置。
- 不修 `tests/test-pi-compile-check` 的 Dockerfile（本机 npmmirror 不可达 +
  `bun add -g` 在 `/check` 生成 lock 把目录变 workspace）。见
  `docs/tests/report-pi-restore-merge-20261103.txt` 缺口 A。

## 🔴 同名号有两套字节（2026-11-06 追加）

`2.3.0-preview.208` / `2.5.0-preview.176` 这组版本号被**复用过**：本文件描述的是 2026-11-03
打的那一对；2026-11-06 又用同一组版本号打了一对（含 pi 低端设备修复）。分辨只看制品里的
`build-info.json`，不看版本号：

| 打包日期 | build-info.commit | dirty | 在哪 |
|---|---|---|---|
| 2026-11-03 | `45f54ba9…` | **true** | `archive/20261103-pixb/`（回滚身份；dirty ⇒ 那套字节不能只靠这个 commit 复现） |
| 2026-11-06 | `3adac29e…` | false | `/vol2/1000/Download/agent-network-tgz/`（现用，含 pi 修复） |

装完必须核对：`cat <prefix>/lib/node_modules/@sleep2agi/agent-node/build-info.json`。
安装顺序、哈希与验证判据见 [report-pair-pack-20261106.txt](./report-pair-pack-20261106.txt)。

## Install（本地成对）

```bash
npm i -g --prefix <prefix> /vol2/1000/Download/agent-network-tgz/sleep2agi-agent-network-2.3.0-preview.208.tgz
# agent-node 由 anet 经 npx 懒取；本地验证用：
export ANET_AGENT_NODE_BIN=<abs>/agent-node/dist/cli.js
```
