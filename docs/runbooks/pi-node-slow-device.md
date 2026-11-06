# Runbook：低端设备上的 pi 节点（升级 / 验证生效 / 回滚）

适用：节点跑在消费级显卡 + 本地大模型上（现场：GTX 1070 8GB、131072 上下文）。
这类节点的失败模式与旋钮见
[docs-site/docs/guide/pi-slow-local-model.md](../docs-site/docs/guide/pi-slow-local-model.md)。

**前提（不改的东西）**：模型配置（窗口、`reserveTokens`、`maxTokens`、thinking 等级、
缓存参数）是调过的，**节点侧的修复一律不动它**。所有杠杆都在 `agent-node` 代码与
env/`flags` 旋钮里。

## 六个恢复问题（本 runbook 要能答上）

| 问题 | 答案在哪 |
|---|---|
| 常驻服务怎么启动、脚本在哪 | 权威副本：`deploy/fleet/pm2-fleet-boot.sh` + `deploy/fleet/anet-nodes-boot.sh`（机器上的启动器只是部署副本）。每个常驻条目的**权威副本路径登记在** `deploy/fleet/process-inventory.json`（`apps[].name` / `authority`，agent-node 条目在内）。漂移用 `deploy/check-deployed-copies.sh`（主机上跑，CI 看不到 `~/.local/bin`）与 `deploy/fleet/check-fleet-drift.sh` |
| 反代/隧道/端口写在哪 | 节点是**出站**连 hub（无监听端口、无反代）；hub 地址写在 `~/.anet/config.json` 的 `hub` 与节点目录的 `config.json` |
| env 与密钥从哪来 | 节点令牌 = 节点目录 `config.json` 的 `token`（`ntok_`，0600）；pi 的 provider key 在 pi 自己的配置里（**不入库**）；时间预算旋钮走 env 或 `~/.anet/config.json` 的 `flags.*`（模板见下，只写变量名） |
| 怎么换版本并验证真生效 | 见「升级」一节：验证只认 **pm2 的 script path / 进程实际加载的源码目录**，不认 npm 版本号 |
| 怎么回滚 | 记住上一个可用的 pixb 源码提交，`git checkout <rev>` + 重启进程（生产从 pixb 源码构建，回滚就是回到那份源码） |
| 哪些状态只能从数据备份恢复 | 节点的会话文件（pi 的 `.jsonl`）、`~/.anet/nodes/<alias>/config.json`、`pending-replies.json`；hub 侧任务与消息在 hub 的 sqlite 里。这些都不在 git 里 |

## 升级（部署身份 = pixb 源码提交）

```bash
# ① 在节点机器上，把 pixb 更新到目标提交（生产从 pixb 源码构建，不发 npm）
git -C <agent-network 工作副本> fetch origin && git -C <...> checkout pixb && git -C <...> pull --ff-only
git -C <...> log --oneline -1          # 记下这个 sha —— 它才是发布身份

# ② 装依赖 + 构建发布物（bundle 是生产形状）
cd <...>/agent-node && bun install && bun run build && ls -l dist/cli.js

# ③ 让常驻进程真的加载这份代码（pm2 路径 = 现场核对项，别照抄文档里的目录）
pm2 describe <node-条目名> | grep -E "script|script path|restarts|uptime"
# <node-条目名> 从 deploy/fleet/process-inventory.json 的 apps[].name 里取，
# 不要照抄本文档里的示例名（条目名是现场事实，会随节点增减变化）
pm2 restart <node-条目名>
```

**验证生效只问进程实际加载的是哪份代码**：`pm2 describe` 的 script path 必须指向
上面那个工作副本的 `agent-node/dist/cli.js`（或 `src/cli.ts`）。若它指向
`~/.npm/_npx/...` 或另一个目录，说明这次升级对现网没有意义（AGENTS.md 里记过这种反例：
`pm2 online` 且接口 200，而 script path 还指着上一版运行目录）。

## 升级后必须看到的三条（这几条就是本次修复是否生效的判据）

启动横幅（`--log-level debug` 或节点日志当日文件）：

```
[pi] promptAck=900000ms(env|flags|default) handshake=45000ms(default) lateAck=30000ms lateGrace=90000ms
[pi] idle=1800000ms(flags.piTimeoutMs/flags.timeout/PI_TIMEOUT_MS) busyPolicy=queue rollover=262144B carry=1200chars
```

跑一条任务后：

```
[pi] prompt ack <N>ms disposition=started|queued
[pi] 本轮压缩 1 次 = <秒>s，摘要 <token> token，压缩后上下文约 <token> token   # 有压缩时
[pi] 会话滚存：会话文件 <bytes>B ≥ 阈值 <N>B（上一轮收尾携带 <M> 字符）      # 到阈值时
```

**旧形状的判据（说明没生效）**：hub 里出现
`[节点] pi 错误: timeout waiting pi response for prompt`。

## 旋钮模板（只写变量名，不写值）

`~/.anet/config.json`：

```json
{
  "hub": "<hub 地址>",
  "network_id": "<net_…>",
  "flags": {
    "piTimeoutMs": 0,
    "piPromptAckTimeoutMs": 0,
    "piHandshakeTimeoutMs": 0,
    "piLateAckMs": 0,
    "piLateSettleGraceMs": 0,
    "piBusyPolicy": "queue",
    "piSessionRolloverBytes": 0,
    "piRolloverCarryChars": 0,
    "piSessionPerTask": false
  }
}
```

env 同名大写形式优先（`PI_PROMPT_ACK_TIMEOUT_MS` 等），来源会在横幅里点名。
派活侧配套规则：`ttl_seconds ≥ 2 × (PI_TIMEOUT_MS / 1000)`。

## 回滚

```bash
git -C <工作副本> checkout <上一个可用 sha>
cd <工作副本>/agent-node && bun install && bun run build
pm2 restart <node-条目名>
pm2 describe <node-条目名> | grep -E "script path"
```

不需要回滚 hub：本次修复只在 `agent-node` 侧（hub 协议与 pi 上游都没动）。

## 演练（不碰生产）

```bash
tests/pi-rpc-ack/make-baseline.sh            # 从 git 历史打基线源码
docker build -q -f tests/pi-rpc-ack/Dockerfile -t anet-pi-rpc-ack .
docker run --rm anet-pi-rpc-ack              # 32 项断言；一次性 hub/sqlite
```

基线与修复后的代码在同一镜像内并存，跑同一条 20s 压缩任务：基线必死，修复后交付。
结果存档：`docs/tests/report-pi-rpc-ack-20261106.txt`。
