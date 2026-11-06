#!/usr/bin/env node
// 测试用 stub `pi --mode rpc`：stdin 收 JSONL 命令，stdout 吐 JSONL 记录。
//
// 不是 mock 库：runtime 走真实 spawn + 真实 stdio，时序语义与真 pi 一致 ——
//   · 压缩发生在 prompt 的 response 之前，压缩期间 stdout 完全静默
//     （docs/json.md 的 compaction_start / compaction_end 边界事件）；
//   · 流式进行中且没带 streamingBehavior 的 prompt ⇒ success:false
//     （docs/rpc-commands.md:29）；
//   · 排队提交的 ack disposition=queued ⇒ 之后才看到本轮开始
//     （docs/rpc-commands.md:40）。
//
// 每个 prompt 先吐一条 `{type:"stub_meta", n, behavior}`，测试靠它断言
// 「第几次提交、带没带 streamingBehavior」——重发次数与排队语义都靠它锁。
//
// env 脚本化（全部以 STUB_ 前缀，与 runtime.test.ts 的契约一致）：
//   STUB_MODE                       normal | slow_ack_compaction | busy_reject | late_ack
//                                  | resend_zero_activity | stale_settle_then_run | handled
//                                  | ack_timeout_forever | no_get_state
//   STUB_COMPACT_MS   压缩时长（默认 200）
//   STUB_ACK_MS       ack 延迟
//   STUB_IS_STREAMING / STUB_IS_COMPACTING  get_state 报忙碌
//   STUB_SESSION_FILE               滚存策略读到的会话文件路径
//   STUB_NEW_SESSION_ID / _CANCELLED / _FAIL
import process from "node:process";
import fs from "node:fs";

const env = process.env;
const n = (v, d) => (v === undefined ? d : Number(v));
const compactMs = n(env.STUB_COMPACT_MS, 200);
const ackMs = n(env.STUB_ACK_MS, 0);
const sessionFile = env.STUB_SESSION_FILE ?? "/tmp/stub-session.jsonl";
const mode = env.STUB_MODE ?? "normal";
const callLog = env.STUB_CALL_LOG; // E2E 用它断言「真的调用了 new_session」

const write = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const ev = (o, ms) => setTimeout(() => write(o), ms);
const textDelta = (text) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });

const stateData = () => ({
  isStreaming: env.STUB_IS_STREAMING === "1",
  isCompacting: env.STUB_IS_COMPACTING === "1",
  pendingMessageCount: env.STUB_IS_STREAMING === "1" ? 1 : 0,
  sessionId: currentSessionId,
  sessionFile,
});

let promptSeq = 0;
let settledSeq = 0;
let currentSessionId = "sess-original";

function handle(cmd) {
  const id = cmd.id;
  const type = cmd.type;
  if (callLog) fs.appendFileSync(callLog, JSON.stringify({ command: type, atMs: Date.now() }) + "\n");

  if (type === "get_state") {
    if (mode === "no_get_state") return; // 握手都不回 → 触发握手超时
    write({ id, type: "response", command: "get_state", success: true, data: stateData() });
    return;
  }

  if (type === "prompt") {
    const mySeq = ++promptSeq;
    const behavior = cmd.streamingBehavior ?? "";
    const settledAt = settledSeq; // 本轮对应的 settled 序号
    write({ type: "stub_meta", n: mySeq, behavior });
    const ack = (ms, disposition) =>
      ev({ id, type: "response", command: "prompt", success: true, data: { disposition } }, ms);
    const settle = (text, ms) => {
      // 与真 pi 一致：agent_start/turn_start 先于正文；runStarted 的证据就在这两个上
      ev({ type: "agent_start" }, ms);
      ev({ type: "turn_start" }, ms + 2);
      ev({ type: "message_start", role: "assistant" }, ms + 5);
      ev(textDelta(text), ms + 10);
      ev({ type: "message_end", role: "assistant" }, ms + 15);
      ev({ type: "turn_end" }, ms + 18);
      ev({ type: "agent_end" }, ms + 20);
      ev({ type: "agent_settled", turnId: `turn-${settledAt}` }, ms + 25);
    };

    switch (mode) {
      case "slow_ack_compaction": {
        // 忠实顺序：压缩先发生（期间零 stdout），压缩完才 ack，然后才有正文
        ev({ type: "compaction_start", reason: "threshold" }, 10);
        ev(
          {
            type: "compaction_end",
            reason: "threshold",
            tokensBeforeSummarize: 120000,
            estimatedTokensAfter: 41000,
            usage: { totalTokens: 82000 },
          },
          compactMs,
        );
        ack(compactMs + 20, "started");
        settle("COMPACTED-REPLY", compactMs + 40);
        return;
      }
      case "busy_reject": {
        if (env.STUB_IS_STREAMING === "1") {
          // 探测得出忙碌 ⇒ 调用方应带 followUp 提交；裸发被拒
          if (!behavior) {
            write({ id, type: "response", command: "prompt", success: false, message: "Agent is already processing" });
            return;
          }
          ack(10, "queued");
          settle("QUEUED-REPLY", 40);
          return;
        }
        // 探测不出忙碌（pi 在我们发出后才进入流式）⇒ 第一次裸发被拒，第二次带 followUp 成功
        if (mySeq === 1) {
          write({ id, type: "response", command: "prompt", success: false, message: "Agent is already processing" });
          return;
        }
        ack(10, "queued");
        settle("QUEUED-REPLY", 40);
        return;
      }
      case "late_ack": {
        // ack 比调用方的预算晚到；期间没有任何活动
        ev({ type: "compaction_start", reason: "threshold" }, 10);
        ack(ackMs || 120, "queued");
        settle("LATE-ACK-REPLY", (ackMs || 120) + 30);
        return;
      }
      case "resend_zero_activity": {
        // 第一次：永不 ack、零活动 ⇒ 调用方应当恰好重发一次（带 followUp）
        if (mySeq === 1) return;
        ack(20, "started");
        settle("RESENT-REPLY", 40);
        return;
      }
      case "stale_settle_then_run": {
        // 上一轮遗留的 settled 先到，本条是 queued ⇒ 不能被旧 settled 判完成
        ev({ type: "agent_settled", turnId: "turn-stale" }, 5);
        ack(15, "queued");
        ev({ type: "agent_start" }, 110);
        ev({ type: "turn_start" }, 112);
        ev({ type: "message_start", role: "assistant" }, 120);
        ev(textDelta("TRUE-REPLY"), 130);
        ev({ type: "message_end", role: "assistant" }, 135);
        ev({ type: "agent_settled", turnId: `turn-${settledAt}` }, 140);
        return;
      }
      case "handled": {
        // 被扩展/命令接管：没有 run 开始，也不会有 agent_settled
        write({ id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
        return;
      }
      case "ack_timeout_forever":
        return; // 永不 ack、零活动
      default: {
        ack(5, "started");
        settle("OK-REPLY", 20);
        return;
      }
    }
  }

  if (type === "new_session") {
    if (env.STUB_NEW_SESSION_FAIL === "1") {
      write({ id, type: "response", command: "new_session", success: false, message: "stub: new_session 失败" });
      return;
    }
    if (env.STUB_NEW_SESSION_CANCELLED === "1") {
      write({ id, type: "response", command: "new_session", success: true, data: { cancelled: true } });
      return;
    }
    const newId = env.STUB_NEW_SESSION_ID ?? "sess-rolled";
    currentSessionId = newId; // 真 pi：new_session 之后 get_state 报的就是新 id
    write({ id, type: "response", command: "new_session", success: true, data: { sessionId: newId, sessionFile } });
    return;
  }

  if (type === "get_messages") {
    write({ id, type: "response", command: "get_messages", success: true, data: { messages: [] } });
    return;
  }
  if (type === "abort" || type === "shutdown") {
    write({ id, type: "response", command: type, success: true, data: {} });
    return;
  }
  write({ id, type: "response", command: type, success: false, message: `stub: 未实现 ${type}` });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += String(chunk);
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    if (cmd && typeof cmd === "object" && typeof cmd.type === "string") handle(cmd);
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 20));
