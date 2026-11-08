# 低端设备跑本地大模型的节点（pi runtime）

面向的现场：**消费级显卡 + 本地大模型 + 长上下文自动压缩**。这类节点的失败不是
「模型慢」这么简单，而是**节点代码里的时间预算和压缩的墙钟不在一个量级上**。

真实测量（2026-11-04，GTX 1070 8GB，`strata/swift-1.5-iq2_xs`，131072 上下文）：

| 量 | 实测 |
|---|---|
| decode | 21–37 tok/s |
| prefill | 201–224 tok/s |
| 100K prompt 的 TTFT | ~496s |
| 引擎冷启动 | ~884s |
| 一次自动压缩（摘要 ~82K token） | **7–9 分钟** |

压缩为什么会这么贵：`reserveTokens=16384` ⇒ 触发线 `131072-16384 = 114688` token；
摘要请求**关闭 prompt-cache 写入**，等于全量 prefill：`82000 / 201 ≈ 408s`。
压缩发生在 **prompt 的 response 之前**，期间 stdout 完全静默
（`docs/json.md` 的 `compaction_start` / `compaction_end` 边界事件）。

节点侧原来的硬编是 **15s** 等 prompt 的 ack。15s 对 408s ⇒ 压缩一触发，任务 100% 判死，
hub 里留下这句：

```
[节点名] pi 错误: timeout waiting pi response for prompt (r2)
```

**用户不改模型配置**是这条链路的硬前提（窗口、阈值、缓存参数都是调过的）。
下面全部是节点代码里的旋钮，配置一个都不用动。

## 旋钮（env 优先于 `~/.anet/config.json` 的 `flags.*`） {#knobs}

启动横幅会把每个旋钮的**生效值和来源**打出来，不用猜：

```
[pi] promptAck=900000ms(env) handshake=45000ms(default) lateAck=30000ms lateGrace=90000ms
[pi] idle=1800000ms(flags.piTimeoutMs) busyPolicy=queue rollover=262144B carry=1200chars
```

| 旋钮 | env | `flags.*` | 默认 | 管什么 |
|---|---|---|---|---|
| prompt ack | `PI_PROMPT_ACK_TIMEOUT_MS` | `piPromptAckTimeoutMs` | 900s | 等 pi **接受**这条 prompt（含压缩的墙钟） |
| 握手 | `PI_HANDSHAKE_TIMEOUT_MS` | `piHandshakeTimeoutMs` | 45s | `get_state` 握手 |
| ack 后观察窗 | `PI_LATE_ACK_MS` | `piLateAckMs` | 30s | ack 超时后取证多久 |
| 迟到收尾宽限 | `PI_LATE_SETTLE_GRACE_MS` | `piLateSettleGraceMs` | 90s | 已接受的轮次给多长收尾时间 |
| 空闲预算 | `PI_TIMEOUT_MS` | `piTimeoutMs` / `timeout` | 30min | 一轮的总静默预算（压缩的静默量的是这个） |
| 忙碌策略 | `PI_BUSY_POLICY` | `piBusyPolicy` | `queue` | `queue` 排队 / `skip` 本轮不提交 / `fail` 直接失败 |
| 会话滚存阈值 | `PI_SESSION_ROLLOVER_BYTES` | `piSessionRolloverBytes` | 262144（≈64K token） | 0 = 关 |
| 滚存携带字符 | `PI_SESSION_ROLLOVER_CARRY_CHARS` | `piRolloverCarryChars` | 1200 | 0 = 不带（断记忆） |
| 每任务新会话 | `PI_SESSION_PER_TASK=1` | `piSessionPerTask` | 关 | 每个任务都换新会话 |

两个边界（`timeout-resolve.ts`）：写下来的值被夹进 **15s … 24h**，横幅里来源会写成
`floor` / `ceiling` 而不是 `env` —— 照 grok 的做法，「配置里写了值」不等于「运行时用了这个值」，
运维不该猜。默认值不受夹取管辖（夹默认值会把成因说成「你写的值」）。

**启动就会警告**：ack 预算比一次压缩还短时（<300s）横幅直接说明「比一次压缩还短的 ack
等于把压缩判成失败」，不用等失败再猜。

## 会话滚存：唯一能让压缩**根本不发生**的杠杆 {#rollover}

节点原本长期复用同一个 pi 会话（`config.session` 写回），于是越跑越靠近触发线
⇒ 几乎每个任务都要付一次 7–9 分钟的压缩。滚存的思路是**不涨过去**：

- 阈值代理 = **会话文件字节数**（pi 在 `get_state.sessionFile` 里给了路径，节点与 pi 同机 ⇒ 直接 `stat`），不是猜 token；
- 到阈值就 `new_session` RPC，把新 sessionId 写回 `config.session`（重启后仍用新会话）；
- 代价是跨任务记忆断，所以滚存时把**上一轮收尾**显式拼进新会话的第一条 prompt
  （默认 1200 字符）——记忆变成一段可控文本，而不是靠 82K 摘要背着跑 9 分钟。

日志长这样（E2E 实测）：

```
[pi] 会话滚存：会话文件 4000B ≥ 阈值 1000B（上一轮收尾携带 8 字符）
[pi] 会话已滚存 → sess-rol...
```

`new_session` 被扩展取消或失败时**不会谎称已滚存**：本轮继续用旧会话，日志写明未生效。

## ack 超时是「不确定态」，不是失败 {#ack}

15s 到期的时候 pi **可能已经接受了这条 prompt**，回复就在流里；节点报失败、pi 继续跑，
这是最坏的组合。所以：

1. 发 prompt 前先 `get_state` 探测 `isStreaming` / `isCompacting`（忙碌是 pi 自己报的，不靠撞）；
2. 忙碌时带 `streamingBehavior: "followUp"` 提交（pi 规格：流式中裸发 prompt 直接报错）；
3. ack 超时先进**观察窗**取证：有活动（`compaction_start`、消息、压缩）⇒ 视为已接受，
   **继续等本轮，不重发**；
4. 只有**零活动**才允许恰好一次排队重发；
5. 排队提交会把状态报给 hub（节点卡片显示在等什么，节点保持 `working`），
   文案不说「模型满载」——这里的原因是压缩/上一轮。

## 失败码（运维不用从堆栈里认） {#codes}

| 码 | 含义 | 会不会重放 |
|---|---|---|
| `pi_prompt_ack_timeout` | 等 pi 接受 prompt 超时（点名旋钮名与现值） | **不重放** |
| `pi_prompt_rejected` | pi 明确拒绝（含排队后仍被拒） | **不重放** |
| `pi_handshake_timeout` | `get_state` 握手都没成 | **不重放** |
| `pi_runtime_busy` | `busyPolicy=skip` 下本轮未提交 | **不重放** |

这四个码在 `vendor-error.ts` 的 `NON_REPLAYABLE_RUNTIME_CODES` 里。修复前 pi 的错误没有
`code` ⇒ 被当普通噪声 ⇒ 在最忙的时候被重放 3 次（低端设备上这是最贵的错）。

## 派活时的 TTL 约定 {#ttl}

任务 TTL 必须**盖过节点跑完一条任务的时间**，否则任务在 hub 侧过期、节点还在跑：

```
ttl_seconds ≥ 2 × (PI_TIMEOUT_MS / 1000)
```

30min 空闲预算 ⇒ 至少 `ttl_seconds=3600`；要跑压缩级别的长任务，把 idle 和 TTL 一起抬。
细则见 skill 的 `references/ttl-and-expiry.md`。

## 怎么验证（不碰生产） {#verify}

```bash
tests/pi-rpc-ack/make-baseline.sh          # 从 git 历史打出「修复前」的 agent-node
docker build -q -f tests/pi-rpc-ack/Dockerfile -t anet-pi-rpc-ack .
docker run --rm anet-pi-rpc-ack
```

套件里基线和修复后的代码**在同一镜像里并存**，跑同一条 20s 压缩任务：
基线必死（`timeout waiting pi response for prompt`），修复后交付。
报告：`docs/tests/report-pi-rpc-ack-20261106.txt`。
