# RFC-043: pi-cli runtime 集成 (scoping + 开发规划)

| 项 | 值 |
|----|----|
| **作者** | 豆包 MainAgent（受 pix 委托） |
| **状态** | v0.1 — 2026-10-21 创建。用户已拍板：runtime 命名 **`pi-cli`**；安全默认策略由作者决定（见 §6）；开发前先规划本 RFC，开发中问题追加 §10 日志，文档作为中途交接/验收锚点。一期范围：headless（RPC mode），TUI 共存列为二期（不在本 RFC 实施范围，见 §12） |
| **创建** | 2026-10-21（北京 UTC+8） |
| **关联 RFC** | [RFC-029](RFC-029-opencode-runtime-integration.md)（新增 runtime 的完整先例：接口调研 → 安全默认 → 里程碑 → Docker E2E）· RFC-021（ACP capability 扩展，grok-build-acp 先例）· RFC-030（codex TUI 桥，向后兼容先例） |
| **红线** | 只做**公版 [earendil-works/pi](https://github.com/earendil-works/pi)**（`@earendil-works/pi-coding-agent`）；不引入非公开分支/fork；不引入第三方 pi-acp（pi-toolkit，非官方维护）；所有测试在 Docker 跑，不碰本机环境 |
| **依据** | pi.dev 官方文档（docs/latest、cli、rpc、rpc-commands，2026-10-21 抓取）；本地仓库代码链（agent-node/src/cli.ts、agent-node/src/runtime/opencode-acp/、agent-network/src/normalize-runtime.ts、server/src/runtime-label.ts、tests/Dockerfile、tests/test894-v1-runtime/）；行数基线 `wc -l` 实测 |
| **前置评估** | [docs/pi-agent-integration-assessment.md](../pi-agent-integration-assessment.md)（路径对比、改动面、工作量、Docker 化评估） |

---

## 摘要

给 anet 加**第 8 种 runtime（`pi-cli`）**：公版 `@earendil-works/pi-coding-agent`（命令名 `pi`），与现有 7 runtime 并列。节点创建时可选 `pi-cli`，think() 走 **pi RPC mode**（`pi --mode rpc`，JSONL over stdin/stdout 的长驻子进程协议），对 CommHub 网络（send_task / report_status 等）的接入语义与其他 runtime 一致。

**关键调研结论**（已在评估文档核验）：

1. pi 官方有**一等程序化接口 RPC mode**：`pi --mode rpc [--no-session]` 起长驻子进程，stdin 收 JSONL 命令（prompt/steer/follow_up/abort/get_state/get_entries/set_model/bash/switch_session/…），stdout 出响应 + 事件流（`agent_end` / `agent_settled` 完成语义）；关 stdin = 优雅关闭。这是官方推荐的非 Node 集成方式。
2. 会话持久化强于 opencode V1：session 为 append-only tree（jsonl），entry id 是 durable cursor（`get_entries since` 可跨进程续读）。
3. 安全默认**必须处理**：pi 默认启用 `bash`/`edit`/`write` 工具且项目信任非沙箱 —— 本 RFC 决定：默认只读工具集 + `piUnsafeTools` 显式开关（§6）。
4. 测试可全离线：pi 支持自定义 baseUrl 兼容端点，Docker 内用 stub-model.py 做确定性测试，不需要真实模型 key。

**推荐方案**：Track A（RPC mode 长驻子进程），一期 headless。总工时估 **2–3 周**（单人专职，含 review + Docker E2E + release gate），拆 M0–M4 里程碑（§8）。

---

## 1. 背景

当前 7 runtime（runtimes.md canonical 表）：

| runtime 名 | 集成 track | 大致语义 |
|---|---|---|
| `claude-code-cli` | interactive subprocess (TTY) | spawn 本机 `claude` 命令，走 MCP stdio |
| `claude-agent-sdk` | 进程内 SDK | `@anthropic-ai/claude-agent-sdk` |
| `codex-sdk` | 进程内 SDK | `@openai/codex-sdk` |
| `grok-build-acp` | subprocess JSON-RPC (ACP) | spawn `grok` ACP server |
| `codex-app-server` | subprocess + 桥 | 节点自有 codex app-server，TUI 共存 |
| `grok-build-cli` | subprocess | Grok Build CLI headless / 共存 TUI |
| `opencode-cli` | subprocess ACP | `opencode acp` 长驻 + session/load |

`pi-cli` 作为**多 provider BYOK agent**（Anthropic / OpenAI / Google / local / OpenRouter 等），接入后用户可"一个 runtime + 自选 provider/model"，且获得 pi 的 skills / extensions / MCP 生态。

## 2. pi 编程接口调研（已核验，2026-10-21 pi.dev 官方文档）

### 2.1 四种自动化接口

| 接口 | 命令 | 进程模型 | 结论 |
|---|---|---|---|
| print mode | `pi -p "…"` / `pi --print` | 单次，最终文本到 stdout | 备选（极简 MVP） |
| JSON event stream | `pi --mode json "…"` | 单次，JSONL 事件流 | 备选 |
| **RPC mode** | `pi --mode rpc [--no-session]` | **长驻子进程**，JSONL 命令(stdin)/响应+事件(stdout) | **选定** |
| SDK / RpcClient | `@earendil-works/pi-ai` | 进程内（Node/Bun）或子进程 | 不选（依赖过重，违 spawn 惯例） |

> pi 官方**无原生 ACP**；第三方 pi-toolkit 的 pi-acp 非官方维护，红线排除。

### 2.2 RPC 协议要点（接入设计依据）

- **帧**：严格 JSONL（每行一个 JSON，LF 结尾）；stdout 只承载协议记录，诊断走 stderr；关 stdin = 优雅关闭。
- **关联**：命令带可选 `id`，响应回显 `id`；命令异步处理，**必须按 id 关联**。
- **prompt 完成语义**：`prompt` 响应 `data.disposition` = `started`（已接受）/ `queued` / `handled`；之后事件流持续；`agent_end` = 单次 run 结束（可能还有重试/压缩）；**`agent_settled` = pi 不再自动继续**（整轮完成判据）。
- **流式并发**：流式中发新 prompt 必须带 `streamingBehavior`（`steer` / `followUp`），否则报错。
- **会话**：`--no-session`（内存）/ `--session-dir`（持久）；RPC 内 `get_entries since`（durable cursor）、`switch_session`、`fork`、`clone`。
- **bash 控制**：`bash` 命令执行 shell 并写入上下文，`excludeFromContext` 可只存不喂模型，`bash_execution_update` 事件流。
- **认证**：`pi auth check --provider X --json` → `ready`/`not_ready`/`invalid`（exit 0/1/2）。

### 2.3 安全/工具面（决定 §6 的依据）

- 默认内置工具 = `read` / `bash` / `edit` / `write`（**默认含 bash**）。
- 控制：`--tools`（allowlist 或 `+name`/`-name`）、`--exclude-tools`、`--no-tools`、`--no-builtin-tools`。
- 项目信任：`--approve` / `--no-approve`；`--no-context-files` 禁 AGENTS.md/CLAUDE.md 发现。
- 其余禁用：`--no-extensions` / `--no-skills` / `--no-prompt-templates` / `--no-mcp`。
- 官方明示：工具/扩展以 pi 进程权限运行，**项目信任不是沙箱**（与 opencode-cli 产品措辞一致）。

## 3. 方案选型

| 候选 | 匹配度 | 结论 |
|---|---|---|
| A. RPC mode 长驻子进程 | 高：常驻多轮、事件流、会话持久化、官方推荐 | **选定（一期 headless）** |
| B. print / JSON 单次 | 中：实现最简但每轮冷启动、流式/中止弱 | 仅作探针（M0） |
| C. SDK / RpcClient | 中低：需 pi-ai 依赖，违 spawn 惯例 | 否决 |
| D. 第三方 ACP | 低：非官方维护 | 红线排除 |

## 4. 架构设计

### 4.1 agent-node 新适配层 `src/runtime/pi-rpc/`

参照 `opencode-acp/` 结构（RPC 协议比 ACP 薄，估其 0.6–0.8 倍代码量）：

| 文件 | 职责 | 参照 |
|---|---|---|
| `client.ts` | spawn `pi --mode rpc --no-session`；JSONL 读写；id 关联；stderr 诊断收集；关 stdin 关闭 | opencode-acp/client.ts |
| `runtime.ts` | think() 入口：prompt → 事件归约 → `agent_settled` → 提取 replyText；超时、容量重试、空回复 rescue（§6.4） | opencode-acp/runtime.ts |
| `events.ts` | `message_update`（text_delta）等事件归约为 turn 状态 | opencode-acp/events.ts |
| `preflight.ts` | `pi auth check --provider X --json` 就绪探测；负用例假 key → `not_ready` | — |
| `binary.ts` | `PI_DEFAULT_PIN` + 本机 `pi --version` 校验（版本 pin，§6.5） | opencode-acp/binary.ts |
| `child-env.ts` | 子进程环境白名单清理；`--tools`/`--no-approve`/`--no-context-files` 等安全 flag 注入 | opencode-acp/child-env.ts |

### 4.2 三层 runtime 枚举接入

| 层 | 文件 | 改动 |
|---|---|---|
| agent-node | `src/cli.ts` | `RUNTIME_MAP` 加 `"pi-cli"`/`"pi"` → bucket `"pi"`；RUNTIME 联合类型加 `"pi"`；`--help` 白名单；分派分支；超时/容量重试接线 |
| anet | `agent-network/src/normalize-runtime.ts` | `RuntimeName` 加 `"pi-cli"`；`SUPPORTED_RUNTIME_NAMES` 加项；`RUNTIME_REUSED_LOGIN` 不加（pi 走 API key）；wizard 选单加项；daemon create_node 集合 |
| hub | `server/src/runtime-label.ts` | `exact` 映射加 `"pi"` → `"pi-cli"`；旧 hub 未知名优雅处理（RFC-030 先例） |

### 4.3 节点配置

```jsonc
{
  "runtime": "pi-cli",
  "model": "<provider>/<model-id>",   // BYOK；hub create_node 约束 model 必填
  "flags": {
    "piUnsafeTools": false            // §6 安全默认；true 才开 bash/edit/write（仅可信任务）
  },
  "env": { "PI_PROVIDER": "anthropic" }  // 可选：锁定 provider
}
```

## 5. 与 CommHub 的接入语义

与现有 runtime 一致，无特例：
- 节点通过 agent-node 的 turn 循环收 inbox 任务 → think() 走 pi RPC → replyText 回 report_status；
- 超时/容量重试复用现有 capacity-retry 设施；
- 坏结果不冒充成功：RPC 响应 + `agent_settled` 后无有效 replyText → 记为失败（§6.4）。

## 6. 决策记录（authoritative）

> 本节为**已定决策**，后续开发不得静默更改；如需变更，追加新决策并说明理由。

### D1. 接口：RPC mode（`pi --mode rpc`）— 已定
理由：官方推荐非 Node 集成；长驻多轮、事件流、会话持久化完备；无新 npm 依赖。

### D2. 命名：`pi-cli`（agent-node bucket `"pi"`，别名 `pi`）— 用户拍板
与 `opencode-cli`/`claude-code-cli` 命名对齐；hub label 显示 `pi-cli`。

### D3. 安全默认：**只读工具集 + 显式开关** — 作者决定
- 默认启动参数：`--tools read,grep,find,ls --no-approve --no-context-files`（保留只读审阅能力，禁用 `bash`/`edit`/`write`/`powershell`/`codemode` 等写与执行工具）。
- 打开完整工具：节点 `flags.piUnsafeTools = true`（仅限可信任务），启动打印警告（逐字，照 opencode-cli 先例）：「Built-in disabled 默认；piUnsafeTools=true 打开 bash/edit/write，这不是安全沙箱，进程隔离用 Docker/VM」。
- 理由：与 opencode-cli 安全默认哲学一致（默认不可写、显式打开、警告非沙箱），同时比全关保留开箱可用的只读审阅能力。
- 无人值守默认不加载扩展/skills/提示模板（`--no-extensions --no-skills --no-prompt-templates` 由 child-env 注入，除非 piUnsafeTools）。

### D4. 一期范围：headless only；TUI 共存二期 — 作者决定
二期（copresence）参照 opencode V2 共存模式，不进本 RFC 实施；文档 §12 记录预留。

### D5. 认证流：API key 优先，OAuth 交互登录不入无人值守路径
- wizard：选 provider → 选 model → 填 API key（参照 claude-agent-sdk vendor 子菜单）；OAuth provider 提示交互登录 `pi auth login`（需 TTY，不在无人值守支持范围）。
- preflight：启动时 `pi auth check --provider <X> --json`；`not_ready`/`invalid` → 明确失败，不冒充成功。

### D6. 版本 pin：agent-node 引入 `PI_DEFAULT_PIN` — 作者决定
参照 `OPENCODE_DEFAULT_PIN` 机制；Docker 测试断言 `pi --version` = pin；升级走 pin 变更 + release gate。

### D7. 空回复/失败语义 — 作者决定
- `agent_settled` 后 replyText 为空 → 记为失败并重试一次（"请用一句面向用户的纯文本给出最终答复"，cap maxTurns=1）；`ANET_DISABLE_383_REPROMPT=1` 可关（与 claude/opencode 共享的 operator override）。
- 错误分类照现有 stderr-classify / capacity-retry 设施接。

## 7. 改动清单（按层）

1. **agent-node**：`src/runtime/pi-rpc/`（6 文件，§4.1）+ `src/cli.ts`（白名单/分派/help）+ 超时/容量重试接线。
2. **anet**：`normalize-runtime.ts` + wizard 选单 + daemon create_node 集合 + ls/dashboard 显示。
3. **hub**：`runtime-label.ts` + 旧版本未知 runtime 优雅处理。
4. **文档**：`runtimes.md` canonical 表加行；`support-matrix.md` 加列（起步全 ❓）；`cli.md`/`getting-started.md` 提及；`agent-node.md`。
5. **测试**：单元（§8 M2）+ runtime 集成（M3）+ E2E 门 + pin/release gate。

## 8. 里程碑计划（一期 headless，估 2–3 周）

| 里程碑 | 内容 | 交付判据 | 估时 |
|---|---|---|---|
| **M0 探针** | Docker 内装 `pi@<pin>`；手测 RPC 协议（prompt/事件/agent_settled/关 stdin）；stub provider 接通 | 探针脚本 + 记录（事件 schema 实测结论、未知项闭环） | 1–2 天 |
| **M1 适配层骨架** | `pi-rpc/` 的 client + events + runtime（think 基本闭环） | 单测：JSONL 解析、id 关联、事件归约、settled 判完成 | 3–5 天 |
| **M2 枚举接线** | cli.ts RUNTIME_MAP/分派；normalize-runtime；hub label；wizard 选单 | 三处枚举一致；`anet node create --runtime pi-cli` 可建节点 | 2–3 天 |
| **M3 安全默认 + 加固** | child-env 注入只读工具/--no-approve；piUnsafeTools 开关+警告；preflight；空回复 rescue；超时/容量重试 | 负控制测试：piUnsafeTools=false 时 bash 不可用；假 key 报 not_ready；空回复 rescue 生效 | 3–4 天 |
| **M4 Docker E2E + 文档 + 验收** | 套件 `tests/testXXX-pi-cli-runtime/` + 单元 CI + E2E 门；文档全量；验收 checklist（§11） | E2E 全绿；文档一致；验收清单逐项过 | 2–3 天 |

**合计 11–17 工作日（2–3 周）**；误差来源：M0 探针若发现 RPC 事件 schema 与文档不符（需加固），M1/M3 各 +1–2 天。

> **执行状态（2026-10-22）**：M0–M4 全部完成（详见 §10 日志与 §11 验收清单）。实际耗时约 2 天（M0 1 天 + M1/M3 各半天 + M2 半天 + M4 半天），低于估时——得益于本地 ollama 真实模型直连与 Docker 套件复用。

## 9. Docker 测试计划（不碰本机）

- 基础设施照 `tests/Dockerfile` 与 `tests/test894-v1-runtime/`（已核验存在，零架构改造）。
- 新增套件：
  1. `tests/testXXX-pi-rpc-unit/`（参照 test725）：适配层单测，mock 子进程，无需 pi 二进制。
  2. `tests/testXXX-pi-cli-runtime/`（参照 test894-v1-runtime）：容器内 `npm i -g @earendil-works/pi-coding-agent@<pin>` + `pi --version` 断言 + stub-model.py（pi 自定义 baseUrl 兼容端点）+ probe.ts + 正负控制。
  3. `docker-e2e-pi.sh`（或扩展 loop-runtime）：节点创建/调度器触发/坏结果标记失败（照 #144，无需真实 key）。
- 约束：AGENTS.md（所有测试在 Docker；`sg docker -c`；每套件独立 Dockerfile；tmux 一律 `-L`/`-S` 私有 server；不 `kill-server`）。
- 本机零污染：依赖/全局包/构建产物全在容器；宿主只编辑源码与回写 `docs/tests/report-*.txt`。

## 10. 问题与决策日志（开发中持续追加）

> 约定：每次遇到问题/新决策，在此按「日期 | 类型(问题/决策) | 描述 | 处置/结论 | 影响」追加一行。本表是中途交接的核心材料。

| 日期 | 类型 | 描述 | 处置/结论 | 影响 |
|---|---|---|---|---|
| 2026-10-21 | 决策 | runtime 命名 | 用户拍板 `pi-cli` | 三处枚举统一用此名 |
| 2026-10-21 | 决策 | 安全默认 | 只读工具集 + `piUnsafeTools` 开关（D3） | M3 实现 |
| 2026-10-21 | 决策 | 接口 | RPC mode（D1） | M0/M1 实现 |
| 2026-10-21 | 问题 | pi 默认启用 bash 工具 | D3 安全默认处置 | M3 重点 |
| 2026-10-21 | 问题 | pi 无官方原生 ACP | 走 RPC mode，红线排除第三方 ACP | 方案已定 |
| 2026-10-21 | 问题 | RPC 事件 schema 需实测（agent_end vs agent_settled 边角） | M0 探针闭环，未知项不猜 | M1 依赖 M0 结论 |
| 2026-10-22 | 里程碑 | **M0 探针完成（全绿）** | 见 docs/tests/report-m0-pi-rpc-probe.txt：S1 多轮闭环、S2 会话持久化跨进程（sessionFile 一致 + since durable cursor）、S3 不假成功；**事件 schema 与官方文档一致**（agent_start/turn_start/message_start/message_end/message_update/turn_end/agent_end/agent_settled） | M1 协议依赖解除 |
| 2026-10-22 | 发现 | **nonexistent provider 时 prompt 挂起**（15s 无响应、30s 无事件） | D5 preflight 必须前置（`pi auth check`/启动前校验），不能依赖运行时 prompt 失败，否则 turn 挂死到超时 | M3 preflight 实现 + 适配层超时兜底 |
| 2026-10-22 | 决策 | 容器网络走国内镜像 | node 官方二进制 + npm registry 均用 npmmirror（bun fetch 下载 + SHA256 校验），arm64 原生容器，构建 1 分钟内 | 套件 Dockerfile 复用该策略 |
| 2026-10-22 | 记录 | bun API 兼容注意 | Subprocess 无 `.wait()`/`.close()`（用 `.exited`）；CryptoHasher 用 `new Bun.CryptoHasher("sha256")`；node:child_process stdin 无 `.flush()` | probe/适配层代码注意 |
| 2026-10-22 | 里程碑 | **M1 适配层骨架完成（全绿）** | `agent-node/src/runtime/pi-rpc/`：client.ts（JSONL + id 关联 + 超时）、events.ts（事件归约）、runtime.ts（openPiRuntime/think：prompt→agent_settled→replyText + idle 看门狗）；集成测试 4/4 过（真 pi 1.3.0 + stub，多轮复用同一子进程） | M2 接线可开始 |
| 2026-10-22 | 决策 | **真实模型服务 = 本地 ollama** | 用户已装 ollama（qwen2.5:14b / qwen2.5vl:7b / qwen3-vl:4b 等）；OpenAI 兼容端点 `/v1/chat/completions` 已实测可用；**qwen2.5:14b 为验证首选**（原生 tools 能力 + context 32768，纯文本 agent 稳定）；容器→宿主已打通（`http://host.docker.internal:11434` status=200） | M3 末/M4 真实冒烟：pi models.json 加 custom provider（api=openai-chat-completions，apiKey 占位，baseUrl=host.docker.internal:11434/v1，model=qwen2.5:14b） |
| 2026-10-22 | 里程碑 | **M2 枚举接线完成（全绿）** | 四处接线：agent-node cli.ts（RUNTIME_MAP pi-cli/pi→bucket "pi" + RUNTIME 联合 + --help）、agent-network normalize-runtime.ts（RuntimeName + canonicalize + SUPPORTED_RUNTIME_NAMES，BYOK 不进 RUNTIME_REUSED_LOGIN）、bin/cli.ts（checkRuntimeDependency pi 分支 + createRuntimeChoices + help 文本）、server runtime-label.ts（exact map pi/pi-cli→pi-cli）；编译检查套件 `tests/test-pi-compile-check/`（镜像 anet-pi-compile-check，报告 docs/tests/report-pi-compile-check.txt）：agent-node build PASS / agent-network tsc 0 错 / server tsc 基线 101 错不动（gate 只查改动文件） | M3 可开始 |
| 2026-10-22 | 记录 | 编译验证方法 | agent-network/server 全包 tsc 存在**既有**类型债（server 基线 101 错）；套件以"改动文件零新增错误 + 基线计数"为 gate，不以全包 tsc exit 0 为准 | 后续里程碑沿用该 gate 策略 |
| 2026-10-22 | 里程碑 | **M3 安全加固完成（全绿）** | D3：`buildPiArgs`（safe=`--tools read,grep,find,ls --no-approve --no-context-files`；unsafe 放宽工具但信任边界不松）；D5：`preflight.ts`（`pi auth check --json --no-refresh`，实测 stub→ready / no-such-provider→快速 not-ready 不挂起）；D7：空回复 rescue（maxTurns=1，"请用一句面向用户的纯文本给出最终答复"，`ANET_DISABLE_383_REPROMPT`/`disableRescue` 可关）；cli.ts 接线 `processWithPi`（lazy session + preflight + unsafe flag + 非沙箱警告 + dispatch 分支）；集成测试 11/11 过；编译检查 agent-node build PASS | M4 E2E 可开始 |
| 2026-10-22 | 里程碑 | **M4/L3 真实模型冒烟完成（全绿）** | 宿主 ollama qwen2.5:14b（OpenAI 兼容）：容器→宿主 `host.docker.internal:11434` status=200 直通；pi RPC think 真实回复 `OLLAMA_OK`（9ch，1.9s）；preflight ready；报告并入 report-m0-pi-rpc-probe.txt（M0 24 + M1 4 + M3 11 + L3 2 = **41 PASS**） | L2 可开始 |
| 2026-10-22 | 发现 | **pi 1.3.0 只注册 `api: "openai-completions"`** | `openai-chat-completions` 报 `No API provider registered` 且被 pi 静默吞成空回复（首跑 think 168ms 空回复、宿主日志证实 pi 没发 HTTP）；改用 `openai-completions` 后 `--print` 直接回 `OLLAMA_OK` | 冒烟/文档 models.json 一律用 openai-completions |
| 2026-10-22 | 问题 | hub V3 认证（L2 E2E 卡点） | agent-node 无 token 连 hub 401；anet node create 报 Not logged in；MCP send_task 需 from_session=认证用户名（否则 identity_mismatch）+ 显式 network_id=节点注册网络（否则 network_id_required / alias_not_found） | 套件内 register→token→network（注册自动建）→anet login→node create 固化 |
| 2026-10-22 | 里程碑 | **M4/L2 全链路 E2E 完成（12 PASS / 0 FAIL）** | 套件 `tests/test-pi-e2e/`（镜像 anet-pi-e2e）：stub 模型服务 → CommHub（/health 轮询）→ `anet node create pi-e2e --runtime pi-cli`（M2 接线实证：agent-node 日志 `runtime: pi (input: pi-cli)`）→ agent-node 注册 → MCP send_task `Reply with exactly PI_E2E_OK` → 轮询 `"replied"` → **result = `[pi-e2e] PI_E2E_OK`**（1s）；负控制 pi-bad（no-such model）被 preflight 拦截不挂起；报告 docs/tests/report-pi-e2e.txt | **M4 完成** |
| 2026-10-22 | 记录 | 容器内工具缺失与权限 | M0 镜像无 curl/python3 → 套件内嵌 bun http-cli.ts（METHOD URL [JSON]，Bearer 走 HUB_TOKEN）+ jq.ts（点路径 + 数组下标）；MCP 端点需 `Accept: application/json, text/event-stream`；工作区新建源文件为 600 权限导致容器 USER bun 读不了 → Dockerfile `chmod -R a+rX /check` | 后续套件复用该工具与权限处理 |
| 2026-10-22 | 问题 | 收尾盘点发现 4 处枚举缺口 | ①server `create-node-validate.ts` RUNTIMES 数组仍 7 项（daemon create_node 建 pi 节点报 `runtime_invalid`）；②goals 调度拒 pi bucket（`RuntimeBucket` 无 pi，启动警告 `unknown runtime bucket`，pi 节点无法参与定时目标）；③`clone-node.ts sessionContractForRuntime` 无 pi 分支（克隆落 unsupported）；④`cli-help.ts` node create 帮助列表缺 pi-cli | 全部补齐：RUNTIMES +`"pi-cli"`；goals/store `RuntimeBucket` +`"pi"` + PI_RUNTIME_NAMES（pi/pi-cli）；sessionContract pi 分支（transcript_when_present，依据 M0/S2 sessionFile 持久化实测）；cli-help 列表 +`pi-cli`（别名 pi）；配套单测全绿（store 38 / create-node-validate 47 / clone 6），compile-check 与 L2 E2E 复跑 12/12 全绿，启动日志 `goals scheduler: enabled (runtime=pi)` | 功能完整 |
| 2026-10-22 | 决策 | **TUI 共存（copresence）不做——实测依据** | pi 1.3.0 **无 server 会话架构**（`--mode` 仅 text/json/rpc，无 ACP/远端 server），opencode V2 共存模式（server 会话共享）**不适用**；claude-code 式 tmux 读屏 hack 对第三方全屏 TUI 脆弱且 pi 官方不支持；RPC mode 已是官方自动化接口（M0 验证完整多轮协议 + 会话持久化）。RFC §12 原「参照 opencode V2 共存」基于错误假设，更正为明确非目标 | §12 更新；support-matrix TUI 列标 — |

## 11. 验收标准（交接/验收 checklist）

- [x] **代码**：`agent-node/src/runtime/pi-rpc/` 各文件就位；cli.ts 三处枚举（RUNTIME_MAP/类型/help）一致；`pi-cli` 节点可创建、启动、收任务、回结果（L2 实测 `runtime: pi (input: pi-cli)` + `[pi-e2e] PI_E2E_OK`）。
- [x] **安全默认**：piUnsafeTools=false 时容器内实测 `bash`/`edit`/`write` 不可用（负控制，M3 单测）；true 时可用并打印警告（M3 单测）；preflight 假 key → 明确失败（M3 + L2 负控制 pi-bad 拦截，不挂起）。
- [x] **失败语义**：空回复 rescue 生效（M3 单测）；坏结果不记为成功（L2 日志 processTask failed=true 状态回传 hub）。
- [x] **测试**：单测 + runtime 集成套件 + E2E 门全绿（M0/M1/M3/L3 41 PASS + M2 4 PASS + L2 12 PASS）；pin 版本断言通过（套件内 `pi --version` = 1.3.0）；报告写入 `docs/tests/report-m0-pi-rpc-probe.txt` / `report-pi-compile-check.txt` / `report-pi-e2e.txt`。
- [x] **文档**：runtimes.md canonical 表、support-matrix.md、cli.md、getting-started.md、agent-node.md 与实现一致（M4 末已同步，见 git diff）。
- [x] **Docker**：所有测试在 Docker 内跑通；本机无 pi/bun/node_modules 污染（宿主仅源码 + 报告）。
- [x] **本 RFC**：§10 日志已按实际记录；无未闭环的已知问题（未闭环的须在 §12 明确列出）。
- [x] **收尾核验（M4 后）**：daemon create_node 集合含 pi-cli（create-node-validate RUNTIMES=8）；goals 调度 pi bucket 生效（`goals scheduler: enabled (runtime=pi)`）；clone 会话语义有 pi 分支（transcript_when_present）；`node create --help` 列表含 pi-cli；agent-node.md 提及 pi-cli；相关单测 + compile-check + L2 E2E 复跑全绿。

## 12. 非目标 / 二期预留

- **TUI 共存（copresence）**：**不做**（2026-10-22 实测决策）。pi 1.3.0 无 server 会话架构（`--mode` 仅 text/json/rpc），opencode V2 共存模式不适用；tmux 读屏 hack 脆弱且 pi 官方不支持；RPC mode 已是官方自动化接口（M0 完整验证）。若未来 pi 官方提供 server/ACP 模式再评估。
- **Windows 验证**：pi 官方支持 Windows，但一期只在 Linux（容器）/macOS（宿主）验证；Windows 进支持矩阵 ❓。
- **MCP 注入、skills 预置**：一期不做（安全默认禁扩展）；后续按需评估。
- **多节点共享 pi 登录**：不做（一个登录一个节点，照 codex 先例）。

## 附：核验来源

- pi.dev 官方文档：docs/latest、cli、rpc、rpc-commands（2026-10-21 抓取）
- 本地仓库：agent-node/src/cli.ts、runtime/opencode-acp/、opencode-copresence/；agent-network/src/normalize-runtime.ts；server/src/runtime-label.ts；docs-site/docs/guide/runtimes.md、support-matrix.md；tests/Dockerfile、test725-agent-node-unit-ci、test894-v1-runtime、MOCK-LLM-PROTOCOL.md、docker-e2e-loop-runtime.sh
- 基线行数：`wc -l` 实测（2026-10-21）；RFC-029 为里程碑/工时模板
