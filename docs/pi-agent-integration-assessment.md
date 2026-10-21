# pi agent（@earendil-works/pi-coding-agent）接入 agent-network 评估

- 日期：2026-10-21（Docker 化评估 2026-10-21 追加）
- 状态：评估稿（待确认事项见文末）
- 范围：本项目是否支持 pi agent → **当前不支持**；本文评估「新增一个 runtime 适配器」的路径、改动面、工作量与风险
- 参照系：`opencode-cli`（RFC-029，最近一次新增 runtime 的全流程先例）
- **已拍板**：runtime 命名为 **`pi-cli`**（2026-10-21）

## 1. 结论摘要

- agent-network 的 runtime 是**硬编码枚举**（`agent-node/src/cli.ts` RUNTIME_MAP + `agent-network/src/normalize-runtime.ts` RuntimeName + `server/src/runtime-label.ts`），pi 不在其中，**现不支持**。
- pi agent 提供了**官方推荐的 RPC 模式**（`pi --mode rpc`，JSONL over stdin/stdout 的长驻子进程协议），其语义（常驻、多轮 prompt、事件流、会话持久化）与 agent-node 的 think 循环天然匹配，**接入路径成立**，复杂度低于当年 opencode 的 ACP 接入。
- 主要工作量集中在 agent-node 新适配层（参照 opencode-acp 约 3500 行产品代码 + 3600 行测试），anet / hub / 文档 / E2E 为配套改动。
- **最大风险点不是工程而是安全默认**：pi 默认启用 `bash` 工具，无人值守节点必须做工具白名单（参照 opencode-cli 的安全默认先例）。

## 2. Pi 侧接口形态（已核验，来源 pi.dev 官方文档）

### 2.1 安装与形态

| 项 | 事实 |
|---|---|
| 包名 | `@earendil-works/pi-coding-agent`（原 `@mariozechner/pi-coding-agent`，2026-05 迁移命名空间） |
| 安装 | `npm install -g @earendil-works/pi-coding-agent`（全局 CLI，命令名 `pi`） |
| 定位 | 可扩展终端 AI agent（作者 Mario Zechner / earendil-works） |
| 内核包 | `@earendil-works/pi-ai`（模型层）、`@earendil-works/pi-agent-core`（agent 内核） |

### 2.2 四种自动化接口（docs/latest → "Automate or embed Pi"）

| 接口 | 命令 | 进程模型 | 适合场景 |
|---|---|---|---|
| print mode | `pi -p "query"` / `pi --print` | 单次、最终文本到 stdout 后退出 | 一次性/脚本任务 |
| JSON event stream | `pi --mode json "…"` | 单次、JSONL 事件流到 stdout 后退出 | 需要结构化事件的单次任务 |
| **RPC mode** | `pi --mode rpc [--no-session]` | **长驻子进程**，JSONL 命令(stdin)/响应+事件(stdout) | 非 Node 集成、进程隔离、IDE、自定义客户端 —— 官方推荐 |
| SDK / RpcClient | `@earendil-works/pi-ai` 导出 | 进程内（Node/Bun）或子进程（RpcClient） | TS 宿主 |

> pi 官方**无原生 ACP**（第三方 `pi-toolkit` 提供非官方的 `pi-acp` 供 Zed 等 ACP 客户端使用，非官方维护，不建议依赖）。

### 2.3 RPC 协议能力（docs/latest/rpc + rpc-commands，已核验）

- **协议**：严格 JSONL 帧（每行一个 JSON，LF 结尾）；stdout 只承载协议记录，诊断走 stderr；stdin 关闭 = 优雅关闭。
- **关联**：每个命令可带 `id`，响应回显 `id`；命令异步处理，必须按 id 关联。
- **命令集**：`prompt` / `steer` / `follow_up` / `abort` / `clear_queue` / `new_session` / `get_state` / `get_messages` / `get_entries`(since 游标) / `get_tree` / `get_last_assistant_text` / `set_model` / `cycle_model` / `get_available_models` / `set_thinking_level` / `compact` / `set_auto_compaction` / `set_auto_retry` / `bash` / `abort_bash` / `switch_session` / `fork` / `clone` / `get_session_stats` / `export_html` / `set_session_name` / `get_commands`。
- **完成语义**：`agent_end` = 单次底层 agent run 结束（可能还有重试/压缩/后续工作）；`agent_settled` = pi 不再自动继续（等待该事件才可判定整轮完成）。
- **prompt 并发**：流式中发新 prompt 必须带 `streamingBehavior`（`steer` / `followUp`），否则报错。
- **会话**：session 为 append-only tree（jsonl），entry id 是 durable cursor（`get_entries since` 可跨进程重启续读）——比 opencode V1 的"本地 session DB 不跨进程"更强。
- **bash 控制**：`bash` 命令执行 shell 并写入上下文；`excludeFromContext` 可只存不喂模型；`bash_execution_update` 事件流。
- **认证**：`pi auth check --provider X --json` 输出 `ready` / `not_ready` / `invalid`（exit 0/1/2）；BYOK 多 provider（anthropic / openai / google / local / OpenRouter 等）。

### 2.4 安全与工具控制（对接入设计最相关）

- 默认内置工具 = `read` / `bash` / `edit` / `write` —— **默认含 bash**。
- 控制开关：`--tools`（allowlist 或 `+name`/`-name` 增减）、`--exclude-tools`、`--no-tools`、`--no-builtin-tools`。
- 项目信任：`--approve` / `--no-approve`（信任门控项目本地配置与资源）；`--no-context-files` 可禁 `AGENTS.md` / `CLAUDE.md` 发现。
- 其余禁用：`--no-extensions` / `--no-skills` / `--no-prompt-templates` / `--no-mcp`。
- Pi 官方文档明示：**工具与扩展以 pi 进程权限运行，项目信任不是沙箱**（与 opencode-cli 产品措辞一致）。

## 3. agent-network 侧现状（已核验，本地仓库）

### 3.1 runtime 枚举的三处硬编码

| 层 | 文件 | 现状 | 接入需改 |
|---|---|---|---|
| agent-node | `agent-node/src/cli.ts` ~:666-680 `RUNTIME_MAP` | 5 个 bucket：`claude`/`codex`/`grok`/`opencode`/`codex-app-server`；`--runtime` 白名单在 :384；分派按 RUNTIME import 对应 runtime 模块 | 加 `pi` bucket + 2 个别名键 + `--help` + 分派分支 |
| anet | `agent-network/src/normalize-runtime.ts` | `RuntimeName` 联合类型 7 值；`SUPPORTED_RUNTIME_NAMES` 7 项；`RUNTIME_REUSED_LOGIN` 4 项（pi 走 API key 不涉及） | 加 `pi-cli`（或既定名）值 + 数组项 |
| hub | `server/src/runtime-label.ts` `exact` 映射 | 7 键（`opencode`→`opencode-cli`、`codex`→`codex-sdk` 等） | 加 `pi`→`pi-cli`（按最终命名） |

配套：anet 的 node create wizard 选单、daemon `create_node` runtime 集合、`ls-columns` / dashboard 显示；hub 的 runtime-readiness（若做 readiness 探测）。

### 3.2 参照基线（opencode-cli 的落地规模，本地 wc -l 实测）

| 组件 | 产品代码 | 测试 | 说明 |
|---|---|---|---|
| `agent-node/src/runtime/opencode-acp/`（headless ACP 适配） | ~3,527 行 | ~3,579 行 | client(321) + runtime(496) + events(204) + child-env(1674) + binary(510) + profile-state(322) |
| `agent-node/src/runtime/opencode-copresence/`（TUI 共存，含 v1/v2） | 合计 ~7,448 行（含测试） | | attach-tui / launcher-health / v2-session / v2-readiness / http / inbox-wiring 等 |
| cli.ts 接入 | RUNTIME_MAP ~20 行 + 分派 + 超时/容量重试接线 | | 另含大量 opencode 专用逻辑 |

## 4. 接入路径评估与推荐

| 路径 | 匹配度 | 理由 |
|---|---|---|
| **A. RPC mode（推荐）** | 高 | 长驻子进程 + JSONL + 事件流 + 会话持久化（durable cursor），语义最贴近 agent-node 常驻 think 循环；官方推荐的非 Node 集成方式；协议薄（比 ACP 简单）；无额外 npm 依赖 |
| B. print / JSON 单次模式 | 中 | `pi -p` / `--mode json` 实现最简，但每轮冷启动、流式/队列/中止能力弱；仅适合极简 MVP 验证 |
| C. SDK / RpcClient | 中低 | 需引入 `@earendil-works/pi-ai` 运行时依赖，与项目「spawn 外部进程」惯例不符；锁定 node/bun 宿主 |
| D. 第三方 ACP（pi-toolkit） | 低 | 非官方维护、更新不确定，不推荐作为长期基础 |

**结论：选 A（RPC mode）**，一期只做 headless；TUI 共存二期参照 opencode-copresence 先例。

## 5. 改动清单（按层）

### 一期（headless，RPC mode）

1. **agent-node 新增 `src/runtime/pi-rpc/`**（参照 opencode-acp 结构，可精简）：
   - `client.ts`：spawn `pi --mode rpc --no-session`；JSONL 读写；id 关联；关 stdin 关闭；stderr 诊断收集。
   - `runtime.ts`：think 入口（prompt → 事件归约 → `agent_settled` → 提取 replyText）；超时、容量重试、空回复 rescue（参照 opencode 的 383 先例）。
   - `events.ts`：`message_update`（text_delta）等事件归约。
   - `preflight.ts`：`pi auth check --provider X --json` 就绪探测。
   - `binary.ts`：pin pi 版本 / 二进制定位（参照 `opencode-ai@1.19.3` pin 机制）。
   - `child-env.ts`：子进程环境白名单清理（参照 opencode 的 buildOpencodePermissionPolicy 思路）。
2. **agent-node `cli.ts`**：RUNTIME_MAP 加 `"pi-cli"/"pi"` → bucket `"pi"`；RUNTIME 类型加 `"pi"`；`--help` 白名单；分派分支；超时/容量重试接线。
3. **anet**：`normalize-runtime.ts` 加 runtime 名；node create wizard 选单加一项；daemon create_node 集合；ls/dashboard 显示。
4. **hub**：`runtime-label.ts` exact 映射加键；旧 hub 对新 runtime 的未知名处理（参照 RFC-030 codex-app-server 先例，保证向后兼容）。
5. **文档**：`runtimes.md` canonical 表加行；`support-matrix.md` 加列（起步全 ❓）；`cli.md` / `getting-started.md` 提及。
6. **测试**：适配层单元测试 + `tests/testN-xxx/` 独立 Docker 套件 + release gate / pin 测试。

### 二期（可选，TUI 人机共存）

参照 `opencode-copresence/`：tmux 集成、会话共享、launcher-health、attach；Pi 有成熟 TUI，方案可复用 opencode V2 共存模式。

## 6. 工作量估算（参照 opencode 基线，单人专职含 review/E2E）

| 档 | 内容 | 估算 |
|---|---|---|
| 一期 S：RPC headless MVP | pi-rpc 适配层（RPC 比 ACP 薄，估 opencode-acp 的 0.6–0.8 倍：产品 2,000–2,800 行 + 测试 2,500–3,000 行）+ cli.ts/anet/hub/文档/Docker E2E | **约 2–3 周** |
| 一期 M：完整 headless + 支持矩阵 | 上述 + readiness、pin/release gate、多平台验证（Linux/macOS） | **约 3–4 周** |
| 二期：TUI 共存 | opencode-copresence 参照 ~7,400 行（含测试） | **约 2–4 周** |

误差来源：RPC 协议成熟度（接口较新，事件语义需实测加固）、pi 版本迭代节奏（pin/回归成本）、E2E 套件深度。

## 7. 风险与难点

1. **安全默认（最高优先级）**：pi 默认启用 `bash` 且信任门控非沙箱 —— 无人值守节点**必须**用 `--tools` 白名单（如只留 `read,grep,find,ls`）+ `--no-approve` + `--no-context-files`，否则 agent 可自由执行命令/读项目文件。照 opencode-cli 安全默认先例落地（含「坏结果不冒充成功」的失败标记）。
2. **认证流**：BYOK 多 provider，wizard 需 provider/model/key 选择（参照 claude-agent-sdk 的 vendor 子菜单）；OAuth provider 需交互登录，无人值守场景要 preflight 拦截。
3. **版本 pin**：pi 迭代快（changelog 高频），需 pin 版本 + 升级回归（参照 opencode pin 机制）。
4. **协议加固**：RPC 较新 —— 需实测 `agent_end` vs `agent_settled`、空回复、容量重试、超时，照 opencode 的 rescue 模式补齐。
5. **向后兼容**：新 runtime 字符串要让旧 anet/hub 优雅处理（未知 runtime 的显式报错而非静默降级）。
6. **平台**：pi 跨平台好（含 Windows）；headless 低风险；共存类仍限 Linux/macOS（与 opencode 一致）。

## 8. 建议推进步骤

1. **RFC**：参照 RFC-029 立 `pi-cli` runtime 提案 —— 锁定接口（RPC mode）、命名（`pi-cli`？）、安全默认、pin 策略、一期/二期范围。
2. **一期 headless**：agent-node pi-rpc 适配 → cli.ts → anet 选单 → hub label → 文档 → Docker E2E → release gate。
3. **二期（可选）**：TUI 共存，参照 opencode V2。
4. **支持矩阵**：L1 → L2（真实机器）→ L3（CI）逐级验证。

## 10. 开发与测试 Docker 化评估（2026-10-21）

**结论：可以，且项目已有强制性的 Docker 测试基础设施；pi-cli 开发可做到「本机只编辑源码，构建/安装/测试/打包全部在容器内」，本机零污染。**

### 10.1 现有 Docker 基础设施（已核验，本地仓库）

| 设施 | 位置 | 用途 | 与 pi-cli 的关系 |
|---|---|---|---|
| 统一镜像 | `tests/Dockerfile` | oven/bun:1.3.14 + node 20 + 工具链（python3/make/g++/curl/jq/procps）；COPY 本地源码 → 容器内 `npm install && npm run build` → 全局装 anet/agent-node | 直接复用；构建/装依赖在容器内完成 |
| agent-node 单元 CI | `tests/test725-agent-node-unit-ci/`（Dockerfile + run.sh，node:22-bookworm-slim + bun，`npm ci --include=optional`） | agent-node 单元测试门 | pi-rpc 适配层单测（client JSONL/事件归约，可 mock 子进程）照此新建或并入 |
| runtime 集成套件 | `tests/test894-v1-runtime/`（opencode runtime：容器内 `npm i -g opencode-ai@1.18.34` + 版本断言 + stub-model.py + probe.ts + 正负控制） | 验证 runtime 适配层在真实二进制上的行为 | **pi-cli runtime 套件的最佳模板** |
| mock 模型 | `tests/MOCK-LLM-PROTOCOL.md` + `tests/helpers/mock-llm-server.ts`、`tests/test543-opencode-v2-copresence/stub-model.py` | 确定性测试，不需要真实 API key（绑定 127.0.0.1） | pi 支持自定义 baseUrl 兼容端点（Model 对象含 `baseUrl` 字段），可指向 stub 做全离线 E2E |
| E2E 门 | `tests/docker-e2e-loop-runtime.sh` 等 docker-e2e-*.sh | 调度器/生命周期门（#144：断言调度器触发即可，不需要 vendor key） | 加 pi 节点或新建 `docker-e2e-pi.sh` |
| 合规约束 | AGENTS.md | 所有测试在 Docker；`sg docker -c`；每套件独立 Dockerfile；tmux 一律 `-L`/`-S` 私有 server + `env -u TMUX`；不 `kill-server` | pi-cli 套件照抄 |

### 10.2 推荐方案（本地源码 + 容器全流程，贴合现有惯例）

```
本地宿主（macOS）                    Docker 容器（Linux）
┌──────────────────┐   COPY 源码    ┌──────────────────────────────┐
│ 源码编辑          │ ──────────────▶ │ npm ci / npm install          │  ← 不写宿主 node_modules
│ docs/tests/ 报告  │                │ bun build（agent-node/anet）   │
│ （只读挂载/回写）  │ ◀── report ─── │ npm i -g pi-coding-agent@pin   │  ← 全局包只在容器内
└──────────────────┘                │ pi auth check / stub provider  │
                                    │ bun test + probe.ts + E2E       │
                                    └──────────────────────────────┘
```

1. **适配层单测**（pi-rpc 的 client/events/runtime 逻辑）：新建 `tests/testXXX-pi-rpc-unit/`（参照 test725）或并入现有 agent-node 单元 CI。纯 bun test，子进程可 mock，**不需要 pi 二进制**。
2. **runtime 集成测试**：新建 `tests/testXXX-pi-cli-runtime/`（参照 test894-v1-runtime）——容器内 `npm i -g @earendil-works/pi-coding-agent@<pin>` + `test "$(pi --version)" = <pin>` 断言；stub-model.py（Anthropic 兼容端点）+ `pi --provider` 指向 stub；probe.ts 走 pi-rpc 适配层；正负控制（正确 provider PASS + 错误 provider 断言失败）。
3. **E2E 门**：`docker-e2e-loop-runtime.sh` 扩展或新建 `docker-e2e-pi.sh`，断言节点创建/调度器触发/坏结果标记失败（照 #144 的做法，不需要真实模型 key）。
4. **release 打包**（可选）：tgz `npm pack` 也可容器化（build 后再 pack，参照 report-opencode-pin 的坑：`npm pack` 不跑 prepublishOnly，必须先 build）；本机可不装 bun/node 构建链。

### 10.3 pi-cli 特定注意点（容器内）

| 项 | 说明 |
|---|---|
| pi 安装 | `npm i -g @earendil-works/pi-coding-agent@<pin>`，纯 JS/TS 包大概率无原生编译；装完 `pi --version` 断言（照 opencode-ai pin 先例） |
| 模型调用 | 测试全走 stub/mock 端点（pi 支持自定义 baseUrl 兼容端点），无需外网模型 API；真实 key 只留给人工冒烟 |
| 认证 | `pi auth check --provider X --json` 容器内可跑；preflight 负用例用假 key 断言 `not_ready`/`invalid`；OAuth 交互登录不做无人值守路径 |
| node-pty | agent-node optionalDependency；容器 Linux 需 python3/make/g++（tests/Dockerfile 已装）；headless 的 pi-rpc 不需要 PTY，二期 TUI 共存才需要 + tmux |
| 网络 | 容器内需 npm registry（装 pi 与依赖）；stub 模式下无需外网模型 |
| 宿主差异 | 容器为 Linux x64，与 opencode 共存类 runtime 的验证平台一致；macOS 宿主只承担源码编辑与 Docker 命令 |
| 本机零污染保障 | 依赖/全局包/构建产物全部落在容器；宿主只留源码与 `docs/tests/report-*.txt` 产物；本机 node/bun 不安装任何 pi 相关包 |

### 10.4 更彻底的「容器内开发」（devcontainer，二期可选）

项目当前**没有** devcontainer 先例。若要编码+构建+调试全在容器（VSCode Remote Containers / devcontainer.json），收益是进一步隔离（node_modules、pi、bun 全在容器），代价：
- 新增 devcontainer.json + .dockerignore（排除 node_modules）等基础设施；
- macOS Docker Desktop 下容器内 bun build 性能低于本地；
- TUI 共存调试需要 `docker exec -it`/attach，交互体验打折。

**建议：一期不做 devcontainer，沿用「本地编辑 + 容器 build/test」；若团队多人或环境漂移成为问题再评估。**

### 10.5 结论

- 测试在 Docker：**已是项目强制惯例**，pi-cli 直接照 test894-v1-runtime 模式新建套件即可，本机零污染。
- 开发在 Docker：**可行**，推荐「本地源码 + 容器构建测试」；全部依赖/全局包/构建在容器内，宿主只编辑源码与回写报告。
- 唯一需要新增的基础设施：1–2 个独立测试套件 Dockerfile（照模板复制），无架构性改造。

## 9. 待确认事项 → 决策状态（2026-10-21 已闭环，详见 RFC-043）

1. ~~runtime 命名~~ → **已定：`pi-cli`**
2. ~~是否二期 TUI 共存~~ → **已定：一期 headless；TUI 共存二期预留（RFC-043 §12）**
3. ~~安全默认策略~~ → **已定：只读工具集（read/grep/find/ls）+ `piUnsafeTools` 显式开关（RFC-043 D3）**
4. ~~默认模型/provider~~ → **已定：BYOK；wizard provider/model/key，OAuth 交互登录不入无人值守（RFC-043 D5）**
5. ~~谁来做/何时启动~~ → **已定：按 RFC-043 里程碑 M0–M4 推进（2–3 周），测试全在 Docker**

> 开发规划、决策记录、问题日志、验收标准见 [docs/rfcs/RFC-043-pi-cli-runtime-integration.md](rfcs/RFC-043-pi-cli-runtime-integration.md)。

## 附：核验来源

- pi.dev 官方文档：docs/latest（Automate or embed Pi）、docs/latest/cli、docs/latest/rpc、docs/latest/rpc-commands（2026-10-21 抓取）
- 本地仓库：agent-node/src/cli.ts（RUNTIME_MAP / --runtime 白名单）、agent-node/src/runtime/opencode-acp/、opencode-copresence/、agent-network/src/normalize-runtime.ts、server/src/runtime-label.ts、docs-site/docs/guide/runtimes.md、support-matrix.md
- Docker 基础设施：tests/Dockerfile、tests/test725-agent-node-unit-ci/、tests/test894-v1-runtime/、tests/MOCK-LLM-PROTOCOL.md、tests/test543-opencode-v2-copresence/stub-model.py、tests/docker-e2e-loop-runtime.sh
- 基线行数：`wc -l` 实测（2026-10-21）
