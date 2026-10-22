# agent-node 2.5.0-preview.147

接在 `2.5.0-preview.146` 之后。本版把 **OpenCode V1 的 release pin 从
`opencode-ai@1.18.34` 提到 `1.19.3`**，并修好冷启动根源（launch root）下 OpenCode Zen
免费模型的目录缓存。与 `agent-network 2.3.0-preview.182` 成对发布。

## 本版内容（相对 2.5.0-preview.146）

产品代码只有三处（`agent-node/src`）：

- **OpenCode V1 pin 1.18.34 → 1.19.3**（`runtime/opencode-versions.ts`）。过渡窗口
  `acceptedVersions` 保留全部历史 pin：
  `[1.19.3, 1.19.0, 1.18.35, 1.18.34, 1.18.1]`。仍持有旧精确安装的宿主继续能起，
  并被提示升级；`1.19.1` / `1.19.2` **不在**接受列表（从未做过 pin）。
- **OpenCode Zen 模型目录预热**（`runtime/opencode-acp/child-env.ts`）。Zen 免费档只在
  本地缓存的模型目录（`.cache/opencode/models.json`）里判定某模型是否免费；全新 launch
  root 没有这份缓存，于是免费模型请求会在 OpenCode 自己去拉目录**之前**被拒
  （`free tier can only be used from within OpenCode`）。现在从操作者自己的缓存里把这份
  **静态、非机密**的目录种子复制进 launch root。尽力而为：源不存在时直接跳过，绝不因此
  让启动失败。
- `runtime/opencode-acp/binary.ts` 注释里的示例版本号随之更新（无行为变化）。

## 适用范围

- 🔴 **升级 1.19.3 的宿主上，`opencode-ai` 二进制由 `agent-node` 自己按 pin 安装/校验**，
  `opencode --version` 仍打印裸 semver（`1.19.3`），pin 校验逻辑未变。
- `1.19.3` 的安全面已逐面核对（相对 `1.19.0`）：`v1.19.0...v1.19.3` 共 10 个提交、
  87 个文件，**五个安全面 0 改动** —— ①环境开关（仅 `OPENCODE_DISABLE_SHARE` 随会话分享
  功能下线而移除）②配置路径 / managed config / instruction 发现 ③permission 模块
  ④内建工具集 ⑤serve/attach 参数与会话 REST 路由（`openapi.json` 仅新增可选字段）。
  因此既有的逐项 deny 清单可直接沿用，无需重做。详见
  `docs/tests/report-opencode-v1-1.19.3-vetting.txt`。
- 配置**不需要改**：没有删除或改名的配置键。

## 验证

- `tests/test725-agent-node-unit-ci`（单元门，提交 `4f794216`）：**3029 pass / 3 skip /
  0 fail**，与提 pin 之前的基线计数完全一致。
- `tests/test386-opencode-agent-node-gate`（真实 `opencode-ai@1.19.3` 从 npm 安装）：
  **OVERALL PASS** —— 身份门、`1.19.3` 无过渡提示直接起、`1.18.35` 仍起并拿到升级提示、
  `1.18.2` 被拒并给出装 `1.19.3` 的提示。
- `tests/test227-opencode-tui-copresence`：33 pass / 2 fail；两条失败在**提 pin 之前的
  基线提交上同样复现**（Node 18 的 undici 用例 + 一条 5s deadline 用例），与本次 pin
  无关。见 `docs/tests/report-test227-opencode-v1-1.19.3.txt`。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.147
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.182 @sleep2agi/agent-node@2.5.0-preview.147
```

节点要重启到新构建上才生效。hub 不用改。

- 🔴 **两个包要一起升**（`agent-network@2.3.0-preview.182 ↔ agent-node@2.5.0-preview.147`）：
  `agent-network` 侧的 pin 表是 `agent-node` 侧的镜像，两边必须同版本。

## promote 时的 must_contain

`"version": "2.5.0-preview.147"`
