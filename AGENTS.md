# Agent Network — Codex 规则

## 测试规则

- **分层测试，从简单到复杂**：环境→认证→单点通信→完整流程→多用户→安全
- **前一层不过就不跑后面的**：被依赖的原子能力必须先验证可靠
- **所有测试在 Docker 里跑**：不碰本地环境，不改生产（`tests/**` 那批；`server/src/*.test.ts` 的定向本地跑见 [docs/runbooks/local-iteration.md](docs/runbooks/local-iteration.md)）
- **tmux 在测试里一律 `-L`/`-S` 私有 server + `env -u TMUX -u TMUX_PANE`；永远不 `kill-server`**（#505：子 agent 在 pane 里跑 `TMUX_TMPDIR=$d tmux kill-server`，继承的 `$TMUX` 优先于 `TMUX_TMPDIR`，打掉默认 server，71 个节点一起掉）。起真 tmux 会话的测试只在 Docker 里跑；产品代码只经 `agent-network/src/tmux.ts` 调 tmux（`tmux-ratchet.test.ts` 拦新增的裸调用）。
- **断言的字符串必须是代码真会打的句子**：`grep 重发` 会命中日志里的「…不重发」，
  「观察窗」这个词代码里根本没有（2026-11-06 实测到两条自打脸的绿）。写断言前先
  `grep -n "opts.log?.(\|opts.warn?.(" <被测文件>` 取现成的句子。
- **E2E 里的常驻进程按 PID 管**：测试镜像里常常没有 procps（`oven/bun` 基底实测无 pkill），
  `pkill` 静默失效 ⇒ 多个 daemon 并存 ⇒ 「谁领了这个任务」变随机 ⇒ 断言打在还没产日志的文件上。
  用 `DAEMON_PID=$!` + `kill -9` + 轮询确认。
- **基线用 git 历史里的源码，不在新代码里加 legacy 开关**：修复后的代码经常让「旧语义必死」
  变得不可达（pi 的 15s ack 被地板 + 证据 + 宽限兜住）。要断言基线，就把修复前的树打进镜像
  并行跑（`tests/pi-rpc-ack/make-baseline.sh`）。
- **测试结果保存**：docs/tests/report-testN.txt
- **每个测试套件独立 Dockerfile**：可并行构建和运行
- **Docker 权限**：用 `sg docker -c '...'` 执行 docker 命令

## 开发规则

- **不发 npm：生产从 `pixb` 本地构建部署**。`pixb` 是我们自己的生产分支（2026-11-04 定义），
  生产机器从 pixb 源码构建；部署身份 = **pixb 的源码提交**，不是 npm 版本号。
  验证生效只问常驻进程实际加载的是哪份代码（compose：镜像 label
  `org.opencontainers.image.revision`；pm2：`pm2 describe` 的 script path）。
  现网已实测过反例：pm2 online + `/login`=200，而 script path 还指着上一版运行时目录。
- **需要对外发布时才发 npm，且只从 main 发**：功能分支可构建、打包和测试，但不得向 npm
  发布包或 executable；release 变更必须先合入 `main`，再从该 `main` 精确提交发布。
  日常交付不走这条路。
- **不依赖 registry 启动**：常驻服务的启动与构建都不得在运行时去 npm registry 取包。
  2026-07-29 版本被钉到尚未发布的号上，npx 每次 ETARGET 即退，pm2 无退避重启 34494 次
  整夜锤 registry（见 `deploy/dashboard/dash-start.sh` 头部注释）；npx 还会把生产服务跑在
  `~/.npm/_npx/<hash>/` 里，一条 `npm cache clean` 就能删掉线上运行目录。
- **不频繁发 npm preview**：本地源码开发，大版本完成时统一发
- **不改本地全局 npm 包**：只改 git 仓库源码
- **Docker 先验证**：所有改动 Docker E2E 通过后再合并
- **向后兼容**：旧 atok_ token 仍然有效

## 分支规则

- **只有两个长期分支**：`main` 只作为**上游同步分支**（`upstream/main` 的镜像）；`pixb` 是我们的
  **生产分支**，只在本地部署（2026-11-04 定义：生产从 pixb 构建，不发 npm）
- **main 不写业务提交**：同步只做 `git fetch upstream main` + `git branch -f main upstream/main`（fast-forward），随后 `git push origin main`
- **上游更新只能经 main 进入 pixb**：`git checkout pixb && git merge main` —— 用 **merge**。后期上游有更新时只走这一条
- **禁止把 pixb rebase / reset 到上游**：2026-10-29 那次 rebase 只搬走了 tip 修复，丢掉 RFC-043 的 3 个核心提交，症状是 `anet node create --runtime pi-cli` 报 `unsupported runtime "pi-cli"`（白名单里有、`canonicalizeRuntime` 里没有）。恢复过程与验证见 `docs/tests/report-pi-restore-merge-20261103.txt`
- **pi 的时间预算是一张表，不是 if**：握手 / prompt ack / ack 后观察窗 / 迟到收尾宽限 / idle
  五个旋钮，env > flags > 默认，夹进 15s–24h，启动横幅点名每个值的来源（照 grok 的
  `runtime/grok-build-acp/timeout-resolve.ts` 做法）。改默认值只改
  `agent-node/src/runtime/pi-rpc/timeout-resolve.ts`，运维口径看
  [docs-site/docs/guide/pi-slow-local-model.md](docs-site/docs/guide/pi-slow-local-model.md)。
  失败码 `pi_prompt_ack_timeout` / `pi_prompt_rejected` / `pi_handshake_timeout` /
  `pi_runtime_busy` 必须同时进 `vendor-error.ts` 的 `NON_REPLAYABLE_RUNTIME_CODES`
  （探针：`vendor-error-replay-gate.test.ts`）。
- **新增 runtime 是一张表，不是一串 if**：`agent-network/src/normalize-runtime.ts` 的 `SUPPORTED_RUNTIME_NAMES` + `canonicalizeRuntime`、daemon 的 `VALID_RUNTIMES`、hub 的 `server/src/create-node-validate.ts` 的 `RUNTIMES` 必须同时改；探针是 `agent-node/src/runtime/runtime-set-parity.test.ts`（#1298 跨包等价门）和 `create-node-validate.test.ts` 的「恰好 N 个」断言
- **成对包必须同树构建**：`anet` 与 `agent-node` 的 `PAIRED_*` 版本出自同一棵树；只有白名单、没有运行时的半成品包不得外发（`2.3.0-preview.200` / `2.5.0-preview.165` 已删除）
- **历史快照用 tag 不用长期分支**：例 `backup/pi-20261029`（rebase 前的 pixb，含完整 RFC-043）

## 网络与合并的两条硬规矩

**上游 fetch 走 https + 代理**（本机到 GitHub 的 ssh 今天反复超时；代理是 HTTP CONNECT）：

```bash
git -c http.proxy=http://192.168.1.200:1087 fetch --no-tags https://github.com/sleep2agi/<repo>.git main
git merge-base --is-ancestor <FETCH_HEAD> pixb   # 或比对 sha，证明合并的确实是上游 tip
```

- `upstream` 远端是 ssh 地址，超时后**没有** `upstream/main` 引用可查 ⇒ 只能拿 `origin/main` 镜像合并时，
  必须把「无法证明镜像等于上游 tip」写进报告，别默认相等。
- 下载走代理：`curl -x http://192.168.1.200:1087 -C - -o <out> <url>`（实测 1.7 MB/s vs 直连 22–112 KB/s）。

**合并后不许用「测试总数」判断好坏，必须与基线逐条比对失败名字集合**：

```bash
git worktree add -f /tmp/base-main main            # 基线 = 上游 main 本身
# 同一台机器同一套依赖跑同样套件，再比集合
comm -23 <(grep "^(fail)" 合并后.log | sort -u) <(grep "^(fail)" 基线.log | sort -u)   # 新增的红
git worktree remove --force /tmp/base-main
```

新增 0 才算「合并没引入红」；`bun install` 后锁文件必须无改动（自洽）。
成对包门必须当场核对：`PAIRED_*` 常量 == 两个 `package.json` 的 version；runtime 名单三处逐项相同。
版本号撞上上游已发布号时，**不得从 pixb 发 npm**，身份只认提交。

**UI e2e 断言要有真 hub**：dashboard 读 hub 走服务端代理（`app/api/hub/*` → `hubFetch(COMMHUB_URL)`），
`page.route` 只拦浏览器请求 ⇒ 拦截式 mock 对它是无效的，跑出来是「`npx init` 引导页」而不是布局 bug。
选择器必须逐条对着代码里的 `data-testid` 核对（`node-list-rail`，不是想象中的 `node-list-scroll`）。

## Dashboard 仓库的 issue / PR 规则（英文）

Dashboard 是独立仓库（`pixb/agent-network-dashboard`，upstream = `sleep2agi/agent-network-dashboard`）。
它的**对外产物一律英文**，顺序是 **issue → PR → 审阅 → 上游**：

1. **先 issue**：现象、复现、测量到的根因、期望行为、不在范围内的东西。写「实测」的数值，不写猜测。
2. **再 PR**，指向**我们自己的仓库**（`origin` = `pixb/…`），不是直接指 upstream。commit 信息英文。
3. **审阅通过之后才提 upstream**（`sleep2agi/…`）。上游没批准之前，现网只走我们自己的分支。

配套约定：

- **PR 要能被一眼审完**：基准分支取「修复之前的那个提交」（例：`review-base/chat-pane-viewport` = `bc5374d`），
  这样 PR 里就是**一个提交**的 diff。审完可以删掉那个基准分支。
- **commit 信息必须与代码一致**：文件路径、改了哪个组件、为什么，逐条对着 `git show --stat` 写。
  本次踩过：按截断的输出写成「3 个文件 / `components/layout/AppShell.tsx`」，
  实际是 9 个文件 / `app/components/AppShell.tsx` + 新增 `app/lib/main-scroll.ts`。
  写之前跑 `git show --stat` 与 `gh pr diff <n> --name-only` 对数。
- **已上线的提交默认不重写**。真要重写（例：commit 信息从中英转换），必须**成对做完**：
  `--amend` → `push --force-with-lease` → **重建镜像（label 传新提交）→ `up -d --no-build` 换版**。
  理由：amend 换 SHA 后旧提交**不在分支历史里**，若现网 label 还指着旧 SHA，
  就变成「跑的代码在分支里查不到」（hub 那次的反例就是 label `34cbb9a4` 不在 pixb 历史里）。
  做完的标准是 `git merge-base --is-ancestor <现网 label> origin/pixb` 判**是**。
  动手前先 `docker tag` 旧镜像（`rollback-<日期>`），并核对 `git diff <旧> <新>` 为空（只换信息不换代码）。
- 实测样例：issue #1 + PR #2（聊天栏视口高度链 + 自动滚底）。

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

约定（判据与实测见 `.agents/skills/agent-network-skill/SKILL.md` §7.0 与 `docs/tests/report-dm-visibility-20261104.txt`）：

- **指挥室是用户账号，不是节点**：派活用 utok/atok；不要给 manager 建节点（`report_status` 拒用户 token，人也无 `sessions` 行）。
- **每项目一个 network**（B 方案）：节点别名带机器+项目；`utok` 无隐式网络，读接口一律带 `?network_id=`。
- **中途提问用 `dm <用户名>`**（进 `user_inbox`，Dashboard `/messages/inbox` 可读，任务保持 running）；**回答即交付用 `reply --via send_reply`**（进 `inbox`，Messages 页可读）。默认 `reply`（`report_completion`）只写 `completions` + `tasks.result`，**在 Messages 页与收件箱都看不见，人也没有未读**。
- **派活显式写 `ttl_seconds`**（默认 3600s；上限 86400；`retry_task` 只续 1 小时）。

- **指挥室（manager）是用户账号，不是节点，也不需要节点**：派活用 `utok_` ⇒ `tasks.from_name` = 用户名；`report_status` 拒用户令牌 ⇒ 没有可心跳的东西；人没有 `sessions` 行 ⇒ 不能被 `send_task`/`say` 投递。
- **交付必须走任务**：节点用 `send_reply`（落 `inbox(session_name=<派活用户名>)`，dashboard Messages 可见）。`report_completion` 只写 `completions`，**不进消息流**；`send_desktop_message`（私信）落 `user_inbox`，**dashboard 没有页面读它**（`/dm` 前端不存在）。
- **一个项目 = 一个 network**：alias 唯一性按 network 判定，`utok_` 无隐式网络（REST 读必须带 `?network_id=`），节点 alias 带机器+项目前缀。
- 细则与实测数据见 `.agents/skills/agent-network-skill/SKILL.md` §7.0 与 `references/manual-node.md`。
