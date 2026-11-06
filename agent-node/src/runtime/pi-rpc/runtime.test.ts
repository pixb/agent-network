// RFC-043 pi runtime —— 慢设备现场的单测（2026-11-04 起）。
//
// 为什么必须有这个文件：`src/runtime/pi-rpc/` 此前零测试，而它的硬编 15s 在
// 低端设备 + 本地大模型现场（实测：prompt 前压缩 420–540s、冷启动 884s、
// 满 32K 输出 18min）是「压缩一触发就 100% 判失败」的直接原因。
//
// 子进程是真的：stub-pi.mjs 由真实 spawn + stdio 驱动，时序语义与真 pi 一致
// （ack 是压缩之后才发；压缩期间只有 start/end 两个边界；流式时不带
// streamingBehavior 的 prompt 直接 success:false）。

import { describe, expect, it } from "bun:test";
import { PiRpcClient } from "./client";
import {
  PiRuntimeError,
  openPiRuntime,
  piBusyProgressText,
  probePiState,
  rolloverPiSession,
  think,
} from "./runtime";

const STUB = new URL("./test-support/stub-pi.mjs", import.meta.url).pathname;

interface Harness {
  session: Awaited<ReturnType<typeof openPiRuntime>>;
  metas: Array<{ n: number; behavior: string }>;
  records: Array<Record<string, unknown>>;
  close: () => void;
}

async function openStub(env: Record<string, string>, handshakeMs = 1000): Promise<Harness> {
  const session = await openPiRuntime({
    workDir: "/tmp",
    binary: process.execPath,
    argvOverride: [STUB],
    env: { ...process.env, ...env },
    handshakeTimeoutMs: handshakeMs,
  });
  const metas: Harness["metas"] = [];
  const records: Harness["records"] = [];
  const onRecord = (r: Record<string, unknown>) => {
    records.push(r);
    if (r.type === "stub_meta") metas.push({ n: Number(r.n), behavior: String(r.behavior) });
  };
  session.client.on("record", onRecord);
  return { session, metas, records, close: () => session.client.kill() };
}

describe("pi runtime — 慢 ack 不再等于任务失败", () => {
  it("压缩把 ack 拖到超时之后：观察到 compaction_start ⇒ 视为已接受，本轮正常完成", async () => {
    const h = await openStub({ STUB_MODE: "slow_ack_compaction" });
    const out = await think(h.session, {
      prompt: "跑一个慢任务",
      idleTimeoutMs: 4000,
      promptAckTimeoutMs: 80, // 故意比压缩(200ms)短：旧版在这里必失败
      lateAckMs: 300,
      lateSettleGraceMs: 200,
    });
    expect(out.replyText).toBe("COMPACTED-REPLY");
    // 不重发：一条 prompt 都没有多
    expect(h.metas.length).toBe(1);
    expect(h.metas[0].n).toBe(1);
    // 压缩成本从事件里实测到，不靠猜
    expect(out.state.compactionCount).toBe(1);
    expect(out.state.compactionTokens).toBe(82000);
    expect(out.state.compactionTokensAfter).toBe(41000);
    expect(out.state.compactionMs).toBeGreaterThan(0);
    h.close();
  });

  it("排队提交时上一轮的 settled 先到：不得把上一轮正文当本任务回复", async () => {
    const h = await openStub({ STUB_MODE: "stale_settle_then_run" });
    const out = await think(h.session, {
      prompt: "任务",
      idleTimeoutMs: 4000,
      promptAckTimeoutMs: 1000,
      lateAckMs: 200,
    });
    expect(out.replyText).toBe("TRUE-REPLY");
    expect(out.state.runStarted).toBe(true);
    h.close();
  });

  it("disposition=handled：没有 run 开始，不等 agent_settled（否则只会变成 idle 超时）", async () => {
    const h = await openStub({ STUB_MODE: "handled" });
    const t0 = Date.now();
    const out = await think(h.session, {
      prompt: "任务",
      idleTimeoutMs: 3000,
      promptAckTimeoutMs: 1000,
      lateAckMs: 100,
    });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(out.state.settled).toBe(false);
    h.close();
  });
});

describe("pi runtime — 忙碌（isStreaming/isCompacting 是 pi 自己报的）", () => {
  it("流式中裸发被拒：带 streamingBehavior=followUp 排队重发一次，任务不失败", async () => {
    // 探测不出忙碌（pi 在我们发出后才进入流式）⇒ 走「被拒后挠性重发」这条路
    const h = await openStub({ STUB_MODE: "busy_reject" });
    const out = await think(h.session, {
      prompt: "任务",
      idleTimeoutMs: 4000,
      promptAckTimeoutMs: 1000,
      lateAckMs: 200,
      busyPolicy: "queue",
    });
    expect(out.replyText).toBe("QUEUED-REPLY");
    expect(h.metas.length).toBe(2);
    expect(h.metas[0].behavior).toBe(""); // 第一次是裸发
    expect(h.metas[1].behavior).toBe("followUp");
    h.close();
  });

  it("探测得出忙碌（isStreaming 是 pi 自己报的）：第一次就带 followUp，不经被拒", async () => {
    const h = await openStub({ STUB_MODE: "busy_reject", STUB_IS_STREAMING: "1" });
    const out = await think(h.session, {
      prompt: "任务",
      idleTimeoutMs: 4000,
      promptAckTimeoutMs: 1000,
      lateAckMs: 200,
      busyPolicy: "queue",
    });
    expect(out.replyText).toBe("QUEUED-REPLY");
    expect(h.metas.length).toBe(1); // 没有「先撞再重发」这一次多余往返
    expect(h.metas[0].behavior).toBe("followUp");
    expect(out.state.runStarted).toBe(true); // 排队提交 ⇒ 必须看到本轮开始
    h.close();
  });

  it("busyPolicy=skip：本轮不提交（零条 prompt），并给出可行动的结构化码", async () => {
    const h = await openStub({ STUB_MODE: "busy_reject", STUB_IS_STREAMING: "1" });
    let code: string | null = null;
    try {
      await think(h.session, {
        prompt: "任务",
        idleTimeoutMs: 2000,
        promptAckTimeoutMs: 500,
        lateAckMs: 100,
        busyPolicy: "skip",
      });
    } catch (e: unknown) {
      code = (e as PiRuntimeError).code ?? null;
    }
    expect(code).toBe("pi_runtime_busy");
    expect(h.metas.length).toBe(0); // 真的没提交
    h.close();
  });

  it("排队提交会报给调用方（节点保持 working，指挥室看得到在等什么）", async () => {
    const h = await openStub({ STUB_MODE: "resend_zero_activity" });
    const busy: Array<string> = [];
    await think(h.session, {
      prompt: "任务",
      idleTimeoutMs: 4000,
      promptAckTimeoutMs: 60,
      lateAckMs: 80,
      onBusy: (reason) => busy.push(reason),
    });
    expect(busy.length).toBe(1);
    h.close();
  });

  it("忙碌文案不说「模型满载」——这里的原因是压缩/上一轮，不是满载", () => {
    expect(piBusyProgressText("compacting", 480000)).toContain("压缩");
    expect(piBusyProgressText("compacting", 480000)).not.toContain("满载");
    expect(piBusyProgressText("streaming", 1000)).toContain("上一轮");
  });
});

describe("pi runtime — ack 超时是不确定态，不能直接重发", () => {
  it("ack 迟到（流里有活动）：继续等本轮，且一条 prompt 都不多发", async () => {
    const h = await openStub({ STUB_MODE: "late_ack", STUB_ACK_MS: "120" });
    const out = await think(h.session, {
      prompt: "任务",
      idleTimeoutMs: 4000,
      promptAckTimeoutMs: 60,
      lateAckMs: 300,
    });
    expect(out.replyText).toBe("LATE-ACK-REPLY");
    expect(h.metas.length).toBe(1); // 关键：没有重复执行
    h.close();
  });

  it("零活动：恰好重发一次，且第二次带 followUp", async () => {
    const h = await openStub({ STUB_MODE: "resend_zero_activity" });
    const out = await think(h.session, {
      prompt: "任务",
      idleTimeoutMs: 4000,
      promptAckTimeoutMs: 60,
      lateAckMs: 120,
    });
    expect(out.replyText).toBe("RESENT-REPLY");
    expect(h.metas.length).toBe(2);
    expect(h.metas[1].behavior).toBe("followUp");
    h.close();
  });

  it("两次都超时：给结构化码 + 点名旋钮，不静默吞掉", async () => {
    const h = await openStub({ STUB_MODE: "ack_timeout_forever" });
    let err: PiRuntimeError | null = null;
    try {
      await think(h.session, {
        prompt: "任务",
        idleTimeoutMs: 2000,
        promptAckTimeoutMs: 50,
        lateAckMs: 80,
      });
    } catch (e: unknown) {
      err = e as PiRuntimeError;
    }
    expect(err?.code).toBe("pi_prompt_ack_timeout");
    expect(err?.message).toContain("piPromptAckTimeoutMs");
    expect(h.metas.length).toBe(2); // 只重发一次，不是三次
    h.close();
  });
});

describe("pi runtime — 握手与探测", () => {
  it("get_state 给出 isStreaming / isCompacting / sessionFile（滚存策略靠它）", async () => {
    const h = await openStub({
      STUB_MODE: "normal",
      STUB_IS_COMPACTING: "1",
      STUB_SESSION_FILE: "/tmp/sess.jsonl",
    });
    const st = await probePiState(h.session.client, 1000);
    expect(st?.isCompacting).toBe(true);
    expect(st?.isStreaming).toBe(false);
    expect(st?.sessionFile).toBe("/tmp/sess.jsonl");
    h.close();
  });

  it("握手超时给结构化码（旧版是一条没有方向的 timeout）", async () => {
    const client = new PiRpcClient();
    let thrown: PiRuntimeError | null = null;
    try {
      await openPiRuntime({
        workDir: "/tmp",
        binary: process.execPath,
        argvOverride: [STUB],
        env: { ...process.env, STUB_MODE: "no_get_state" },
        handshakeTimeoutMs: 50,
      });
    } catch (e: unknown) {
      thrown = e as PiRuntimeError;
    }
    expect(thrown?.code).toBe("pi_handshake_timeout");
    expect(thrown?.message).toContain("piHandshakeTimeoutMs");
    client.kill();
  });
});

describe("pi runtime — 会话滚存（不动用户模型配置的正面杠杆）", () => {
  it("new_session → get_state → 新 sessionId 回到 session 上", async () => {
    const h = await openStub({
      STUB_MODE: "normal",
      STUB_NEW_SESSION_ID: "sess-rolled-1",
    });
    const id = await rolloverPiSession(h.session, {});
    expect(id).toBe("sess-rolled-1");
    expect(h.session.sessionId).toBe("sess-rolled-1");
    h.close();
  });

  it("扩展取消了新会话：不得谎称已滚存", async () => {
    const h = await openStub({ STUB_MODE: "normal", STUB_NEW_SESSION_CANCELLED: "1" });
    const warns: string[] = [];
    const id = await rolloverPiSession(h.session, { warn: (m) => warns.push(m) });
    expect(id).toBeNull();
    expect(h.session.sessionId).toBe("sess-original");
    expect(warns.join(" ")).toContain("取消");
    h.close();
  });

  it("new_session 失败：返回 null 并留可行动日志，不影响本轮", async () => {
    const h = await openStub({ STUB_MODE: "normal", STUB_NEW_SESSION_FAIL: "1" });
    const warns: string[] = [];
    const id = await rolloverPiSession(h.session, { warn: (m) => warns.push(m) });
    expect(id).toBeNull();
    expect(warns.length).toBeGreaterThan(0);
    h.close();
  });
});
