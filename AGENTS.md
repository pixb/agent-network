# Agent Network — Codex 规则

## 测试规则

- **分层测试，从简单到复杂**：环境→认证→单点通信→完整流程→多用户→安全
- **前一层不过就不跑后面的**：被依赖的原子能力必须先验证可靠
- **所有测试在 Docker 里跑**：不碰本地环境，不改生产
- **tmux 在测试里一律 `-L`/`-S` 私有 server + `env -u TMUX -u TMUX_PANE`；永远不 `kill-server`**（#505：子 agent 在 pane 里跑 `TMUX_TMPDIR=$d tmux kill-server`，继承的 `$TMUX` 优先于 `TMUX_TMPDIR`，打掉默认 server，71 个节点一起掉）。起真 tmux 会话的测试只在 Docker 里跑；产品代码只经 `agent-network/src/tmux.ts` 调 tmux（`tmux-ratchet.test.ts` 拦新增的裸调用）。
- **测试结果保存**：docs/tests/report-testN.txt
- **每个测试套件独立 Dockerfile**：可并行构建和运行
- **Docker 权限**：用 `sg docker -c '...'` 执行 docker 命令

## 开发规则

- **不频繁发 npm preview**：本地源码开发，大版本完成时统一发
- **不在 `main` 上提交任何东西**：`main` 只用来同步上游，见下面的「分支与仓库」。
- **npm 发布只走 GitHub Actions 的 release 流程**：本机只开发、构建、打包、测试，不向 npm 发布任何包或 executable；且只发 preview 通道，`latest` 升迁是单独一步。
- **不改本地全局 npm 包**：只改 git 仓库源码
- **Docker 先验证**：所有改动 Docker E2E 通过后再合并
- **向后兼容**：旧 atok_ token 仍然有效

## 分支与仓库

本仓库是官方仓库的**独立副本**，不是官方的开发分支。分工只有一条线：

| 分支 | 作用 | 规则 |
|---|---|---|
| `main` | **只做 `upstream/main` 的镜像** | 🔴 不在上面提交任何东西 |
| `pixb` | 我们唯一的开发 / 运行分支 | 我们所有提交都进这里 |

- **两个远端**：`origin` = 我们自己的仓库（`github.com/pixb/agent-network`）；`upstream` = 官方仓库（`github.com/sleep2agi/agent-network`）。上游**没有** `pixb` 分支。
- **同步上游**（`main` 唯一的工作）：
  ```bash
  git fetch upstream
  git checkout main
  git merge --ff-only upstream/main
  git push origin main
  ```
  `--ff-only`：上游走了非快进历史就该停下来看清楚，不要用 merge commit 把本方的提交混进 `main`。
- **所有本方提交进 `pixb`**：功能、修复、测试报告、**release 准备**（版本号同步 `scripts/sync-pinned-versions.sh`、发布说明 `docs/tests/release-v*.md`、docs-site 版本断言）全部提交在 `pixb`，推到 `origin/pixb`。
- **不进上游**：不向 `upstream` 提 PR、不推送任何分支到 `upstream`。
- **`pixb` 要定期吸收上游**，否则会悄悄落后于官方：
  ```bash
  git fetch upstream && git checkout pixb && git merge upstream/main
  ```
- 🔴 **文档里的「release 变更必须先合入 `main`，再从该 `main` 发布」是上游仓库的发版规程，对本仓库不适用** —— 本仓库的 `main` 上永远不会出现我们的改动，所以照那条走会得到「发出去的还是官方旧提交」。本仓库要发布本方改动时，先确认走哪条发布路径（`pixb` 自身的构建/发布流程，或另立一条），不要默认 `release.yml --ref main` 能拿到 `pixb` 的内容。

## 可重建与灾难恢复规则

验收标准不是“代码是否提交”，而是：**任一服务器被清空后，只依靠 GitHub 仓库以及仓库明确引用的备份和密钥来源，能否从空机恢复出当前运行的软件与关键流程。** 凡是恢复步骤依赖“某个人记得”或机器上未入库的 `/home/...` 文件，均视为缺口。

- **生产启动文件必须入库**：生产依赖的启动器、进程编排、构建/部署/回滚脚本必须在 `deploy/`、`ops/` 或其他明确的仓库路径中有权威副本；服务器上的文件只是部署副本，不得成为唯一副本。
- **关键流程与代码同步更新**：端口、反向代理、隧道、服务拓扑、安装目录、环境变量名称及来源、升级、验证、回滚等流程发生变化时，必须在同一个变更中更新 Git 文档。会话记录和个人记忆不能作为长期事实源。
- **锁定可复现输入**：源码、数据库 schema/migration、依赖 lockfile、配置模板和权威制品/版本 SHA 应入库。配置模板只记录变量名和占位符，不得提交 token、密码或其他密钥值。
- **区分软件与数据**：Git 仓库负责复现软件、结构和流程，不承诺包含生产数据库内容。文档必须明确哪些数据来自加密备份、哪些需重新注册或初始化，以及备份位置、保留和恢复方法；不得让使用者误以为 clone 后自动拥有生产数据。
- **变更必须回答六个恢复问题**：常驻服务如何启动且脚本位于哪里；反代/隧道/端口映射写在哪里；环境变量和密钥从何处安全获取；如何换版本并验证真实生效；如何回滚；哪些状态只能从数据备份恢复。
- **定期做纸面重建演练**：只查看仓库，从空机器开始写出直到服务可用的完整步骤；写不出的步骤即为待修缺口。关键链路还应在 Docker 或隔离环境做实际重建演练，并把结果保存到 `docs/tests/`。未经演练，不得宣称“可恢复”。
- **只补事实，不顺手改生产**：盘点发现缺口时先记录并评审，再用窄变更补齐仓库内容；不得借文档盘点擅自修改生产配置、重构运行链路或移动数据。

## 项目结构

- `server/src/` — CommHub Server (Bun + SQLite)
- `agent-network/bin/cli.ts` — anet CLI (完整命令清单以 [`docs-site/docs/guide/cli.md`](./docs-site/docs/guide/cli.md) 为准；数字会漂，不硬编)
- `agent-node/src/cli.ts` — Agent 运行时
  - **stable `@latest` runtime**（以 npm `--help` 为准，勿背版本号）：`claude-agent-sdk` / `codex-sdk` / `grok-build-acp`
  - **`@preview` 额外**（2026-08-20 实测 `agent-node@2.5.0-preview.32`）：`claude-code-cli` / `codex-app-server` / `grok-build-cli` / `opencode-cli`
  - `anet grok attach` 在 `@preview` CLI 有命令；`@latest` 返回 `Unknown: grok`。Hub 不得把死 TUI 报成 idle（见 #1005）
- `tests/testN-xxx/` — 独立 Docker 测试套件 (每个有 Dockerfile + run.sh)
- `docs/` — 设计文档 + 测试报告

## 通信

通过 CommHub MCP 工具通信。收到任务直接执行，完成后回复结果。
