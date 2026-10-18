# agent-network 2.3.0-preview.182

从 `a54c6290`（上一版 `2.3.0-preview.181` 的 release 提交）之后累积的 preview，
与 `agent-node 2.5.0-preview.147` 成对发布。

## 本版内容（相对 2.3.0-preview.181）

产品代码只有一处（`agent-network/src` + `bin`）：

- **OpenCode V1 pin 表镜像同步到 1.19.3**（`src/opencode-versions.ts`）。这份表与
  `agent-node/src/runtime/opencode-versions.ts` **逐字节一致**，由
  `src/opencode-versions-parity.test.ts` 守住；两包的 pin 必须同版本，所以本版与
  `agent-node 2.5.0-preview.147` **必须一起升**。过渡窗口保留全部历史 pin
  `[1.19.3, 1.19.0, 1.18.35, 1.18.34, 1.18.1]`。
- **RFC-029 release pair**（`src/opencode-agent-node-pair.ts`）随本次发版前移：
  `PAIRED_AGENT_NETWORK_VERSION=2.3.0-preview.182`、
  `PAIRED_AGENT_NODE_VERSION=2.5.0-preview.147`。这个常量必须等于两个包的
  `package.json` 版本（单元断言），而上一版 `2.3.0-preview.181` 的 release 提交漏跑了
  `scripts/sync-pinned-versions.sh`，把该断言留在红的状态；本版按 SOP 跑全同步脚本，
  红转绿。
- `bin/cli.ts` 仅一处注释里的示例版本号更新（`checkOpencodePin()` 的注释，无行为变化）。

其余改动为测试与文档（含部署 compose 套件、测试报告）。**没有 hub 协议或 REST 变更**，
所以不涉及 `commhub-server` / dashboard 发版。

## 行为提示

- 拿到 pin 表的 `anet opencode ...` 路径本版起认 `1.19.3`；旧 pin（`1.18.34` 及更早）仍
  在接受窗口内，不会因为升级 CLI 而被就地拒绝。
- `1.19.1` / `1.19.2` 从未做过 pin，仍在拒绝列表。

## 验证

- 单元门 `tests/test725-agent-node-unit-ci`：**3029 pass / 3 skip / 0 fail**。
- 真实包门 `tests/test386-opencode-agent-node-gate`（`opencode-ai@1.19.3` 取自 npm）：
  **OVERALL PASS**。
- 逐面 vetting（`v1.19.0...v1.19.3`，10 提交 / 87 文件，五面 0 改动）见
  `docs/tests/report-opencode-v1-1.19.3-vetting.txt`。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.182
```

## Upgrade

```bash
anet upgrade --preview
# 或指定版本（两包一起）
npm install -g @sleep2agi/agent-network@2.3.0-preview.182 @sleep2agi/agent-node@2.5.0-preview.147
```

> 🔴 本版只动 `agent-network` + `agent-node` 这一对；hub（`commhub-server`）与 dashboard
> 不需跟随。

## 确认版本

```bash
anet --version   # anet v2.3.0-preview.182
```

## promote 时的 must_contain

`"version": "2.3.0-preview.182"`
