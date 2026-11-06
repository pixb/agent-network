// RFC-043 — pi RPC runtime session + think().
//
// Long-running architecture (mirrors opencode-acp, RFC-029 PR②):
//   - spawn `pi --mode rpc` ONCE at first turn (openPiRuntime)
//   - reuse the same subprocess for every subsequent turn
//   - persist --session-id / --session-dir so a crash-restart can resume
//     the same session (pi session files are append-only trees with a
//     durable entry cursor — verified by M0 probe S2)
//
// Safety defaults (RFC-043 D3):
//   - safe mode: read-only tool allowlist `--tools read,grep,find,ls`
//     (pi defaults to read,bash,edit,write — we narrow it), plus
//     `--no-approve --no-context-files` so project-local trust-gated
//     config (AGENTS.md etc.) is never auto-loaded into the agent
//   - unsafeTools=true (flags.piUnsafeTools) widens the allowlist to all
//     built-ins (read,bash,edit,write,grep,find,ls) and logs a warning at
//     the call site; trust boundaries (--no-approve/--no-context-files)
//     are NOT relaxed — only tool reach is widened
//
// Empty-reply rescue (RFC-043 D7, #383 precedent):
//   - when a turn settles with no assistant text, re-prompt once with a
//     plain-text request; toggle off via disableRescue / env
//     ANET_DISABLE_383_REPROMPT=1
//
// Preflight (RFC-043 D5) lives in preflight.ts: `pi auth check` must pass
// BEFORE spawn — M0 S3 proved a nonexistent provider hangs the prompt
// (no response, no events) instead of failing fast.
//
// 2026-11-04 — 低端设备 + 本地大模型现场（192.168.1.33，GTX 1070 8GB，实测）。
// 旧版把三样东西都写成硬编 15s，而 pi 的真实行为是：
//   - `prompt` 前会先检查上下文并**先压缩**（pi compaction.md:37），而
//     `prompt` 的 response 是**压缩之后**才发的 ⇒ ack 延迟 = 压缩墙钟
//     （现场：82K token 摘要 = 420–540s；摘要请求关闭 prompt-cache 写入
//     ⇒ 每次全量 prefill）
//   - 压缩期间 stdout **只有 start/end 两个边界**，中间零输出（json.md）
//   - agent 正在流式时不带 `streamingBehavior` 的 `prompt` **直接
//     success:false**（rpc-commands.md:29）
// 旧版这三条全部撞上 15s / 裸 prompt ⇒「压缩一触发就 100% 失败」。
// 现在：分相超时（timeout-resolve.ts）+ 发前 `get_state` 探测忙碌 +
// `followUp` 排队 + ack 超时先观察再重发 + 压缩成本从事件里实测。
// 模型配置不属于本层的可变输入：以上全部在节点代码里，不动用户的 pi 配置。

import { PiRpcClient, type PiRpcRecord } from "./client";
import {
  newPiTurnState,
  reducePiRecord,
  turnCompletedFor,
  type PiTurnState,
} from "./events";
import {
  PI_DEFAULT_HANDSHAKE_MS,
  PI_DEFAULT_LATE_ACK_MS,
  PI_DEFAULT_PROMPT_ACK_MS,
} from "./timeout-resolve";

export const PI_SAFE_TOOLS = ["read", "grep", "find", "ls"] as const;
export const PI_UNSAFE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const PI_RESCUE_PROMPT = "请用一句面向用户的纯文本给出最终答复";

/**
 * 结构化失败码。#2028 的门只看码判断重放，不靠被压平的回复文本；
 * 没有码的 pi 失败会被当通用 vendor 抖动，对着一台正在压缩的机器重放三次。
 */
export type PiRuntimeFailureCode =
  | "pi_prompt_rejected"
  | "pi_prompt_ack_timeout"
  | "pi_handshake_timeout"
  | "pi_runtime_busy";

export class PiRuntimeError extends Error {
  code: PiRuntimeFailureCode;
  constructor(code: PiRuntimeFailureCode, message: string) {
    super(message);
    this.name = "PiRuntimeError";
    this.code = code;
  }
}

/**
 * 忙碌策略（不动模型配置的唯一两个正面选择）：
 *   "queue" —— 带 `streamingBehavior:"followUp"` 排队，等当轮结束再跑（默认）
 *   "skip"  —— 本轮不提交，节点报忙；hub 那一行留在未 ack 状态可重派
 *   "fail"  —— 旧行为（直接判失败），只作为回退开关存在
 */
export type PiBusyPolicy = "queue" | "skip" | "fail";

/** 排队/压缩时给 hub 节点卡片看的一句话。不得说成「模型满载」——那不是这里的原因。 */
export function piBusyProgressText(reason: "streaming" | "compacting" | "unknown", waitedMs: number): string {
  const why =
    reason === "compacting"
      ? "上下文压缩中（本地模型摘要，实测可达分钟级）"
      : reason === "streaming"
        ? "上一轮未结束，已排队"
        : "模型忙，已排队";
  return `${why}，已等 ${Math.round(waitedMs / 1000)}s`;
}

export interface OpenPiRuntimeOptions {
  /** Per-node work dir — cwd for the pi child. */
  workDir: string;
  /** Complete env for the child. NOT merged with process.env. */
  env?: NodeJS.ProcessEnv;
  /** Persisted sessionId from a prior process, if any (--session-id). */
  sessionId?: string;
  /** Session dir for persistence (--session-dir); requires no fixed id. */
  sessionDir?: string;
  /** Exact provider/model, e.g. "stub/stub-model". */
  model?: string;
  /** Restrict model lookup to one provider. */
  provider?: string;
  /** Explicit tool allowlist. Defaults to PI_SAFE_TOOLS, or
   *  PI_UNSAFE_TOOLS when unsafeTools=true. */
  tools?: string[];
  /** RFC-043 D3 — widen tool allowlist to all built-ins. Does NOT relax
   *  --no-approve / --no-context-files (trust boundaries stay). */
  unsafeTools?: boolean;
  /** --no-approve: ignore trust-gated project-local config. Default true. */
  noApprove?: boolean;
  /** --no-context-files: disable AGENTS.md / CLAUDE.md discovery. Default true. */
  noContextFiles?: boolean;
  binary?: string;
  /**
   * 完全替换 argv（不传时按 `buildPiArgs` 组装）。
   *
   * 用途：把 pi 跑在包装启动器后面（wrapper / 代理 / 带固定 env 的 shim），以及
   * 单测里用 stub 子进程顶替真 pi。**不要用它拼参数** —— 常规参数走上面的结构化字段，
   * 那才能被 `buildPiArgs` 的单元测试锁住（RFC-043 D1/D3）。
   */
  argvOverride?: string[];
  /** `get_state` 握手预算（本地调用，不打模型）。默认 45s，照 grok #261 的
   *  「握手与 prompt deadline 分开」。 */
  handshakeTimeoutMs?: number;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  /** Persisted sessionId callback (anet config.session writeback). */
  onSession?: (sessionId: string) => void | Promise<void>;
  /** 会话文件路径回调（滚存策略要它的字节数）。 */
  onSessionFile?: (file: string) => void | Promise<void>;
}

export interface PiRuntimeSession {
  client: PiRpcClient;
  sessionId: string;
  /** `get_state.sessionFile`：会话文件字节数是「上下文多大」的可测代理
   *  （节点与 pi 同机 ⇒ 可直接 stat）。滚存策略靠它，不靠猜。 */
  sessionFile?: string;
}

export interface PiArgsOptions {
  sessionId?: string;
  sessionDir?: string;
  model?: string;
  provider?: string;
  tools?: string[];
  unsafeTools?: boolean;
  noApprove?: boolean;
  noContextFiles?: boolean;
}

/** Pure arg-builder (unit-testable). RFC-043 D1/D3: RPC mode + safe
 *  read-only allowlist + trust boundaries by default. */
export function buildPiArgs(opts: PiArgsOptions): string[] {
  const args = ["--mode", "rpc"];
  if (opts.sessionId) {
    args.push("--session-id", opts.sessionId);
  } else if (opts.sessionDir) {
    args.push("--session-dir", opts.sessionDir);
  } else {
    args.push("--no-session");
  }
  if (opts.model) args.push("--model", opts.model);
  if (opts.provider) args.push("--provider", opts.provider);
  // RFC-043 D3 — tool allowlist + trust boundaries.
  const tools = opts.tools ?? (opts.unsafeTools ? PI_UNSAFE_TOOLS : PI_SAFE_TOOLS);
  args.push("--tools", tools.join(","));
  if (opts.noApprove !== false) args.push("--no-approve");
  if (opts.noContextFiles !== false) args.push("--no-context-files");
  return args;
}

export async function openPiRuntime(opts: OpenPiRuntimeOptions): Promise<PiRuntimeSession> {
  const args = opts.argvOverride ?? buildPiArgs(opts);
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? PI_DEFAULT_HANDSHAKE_MS;

  const client = new PiRpcClient();
  client.spawn({ cwd: opts.workDir, env: opts.env, binary: opts.binary, args });

  let gs: PiRpcRecord;
  try {
    gs = await client.request("get_state", {}, handshakeTimeoutMs);
  } catch (e: unknown) {
    await client.shutdown().catch(() => {});
    throw new PiRuntimeError(
      "pi_handshake_timeout",
      `pi 握手（get_state）失败：${e instanceof Error ? e.message : String(e)}`
        + `；握手预算 ${handshakeTimeoutMs}ms（flags.piHandshakeTimeoutMs / PI_HANDSHAKE_TIMEOUT_MS）`,
    );
  }
  if (gs.success !== true) {
    await client.shutdown().catch(() => {});
    throw new Error(`pi get_state failed: ${JSON.stringify(gs.error ?? gs)}`);
  }
  const data = (gs.data ?? {}) as { sessionId?: unknown; sessionFile?: unknown };
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
  if (opts.onSession && sessionId) await opts.onSession(sessionId);
  const sessionFile = typeof data.sessionFile === "string" ? data.sessionFile : undefined;
  if (opts.onSessionFile && sessionFile) await opts.onSessionFile(sessionFile);
  return { client, sessionId, sessionFile };
}

export interface PiStateProbe {
  isStreaming: boolean;
  isCompacting: boolean;
  pendingMessageCount: number;
  sessionId?: string;
  sessionFile?: string;
}

/**
 * 发 prompt 前的一次 `get_state`：把「pi 忙不忙」从「撞了才知道」变成
 * 确定性探测（pi 在 `get_state.data` 里直接给了 isStreaming / isCompacting /
 * pendingMessageCount）。探测失败不判任务失败：按未知继续走原来的裸 prompt 路径。
 */
export async function probePiState(
  client: PiRpcClient,
  timeoutMs: number = PI_DEFAULT_HANDSHAKE_MS,
): Promise<PiStateProbe | null> {
  try {
    const r = await client.request("get_state", {}, timeoutMs);
    if (r.success !== true) return null;
    const d = (r.data ?? {}) as Record<string, unknown>;
    return {
      isStreaming: d.isStreaming === true,
      isCompacting: d.isCompacting === true,
      pendingMessageCount:
        typeof d.pendingMessageCount === "number" ? d.pendingMessageCount : 0,
      sessionId: typeof d.sessionId === "string" ? d.sessionId : undefined,
      sessionFile: typeof d.sessionFile === "string" ? d.sessionFile : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 会话滚存：`new_session` → `get_state` 取新 id/路径。
 *
 * 这是「不动模型配置」的正面杆杆：上下文不涨过阈值，自动压缩根本不触发
 * （现场：114.7K 触发 / 82K 摘要 = 7–9 分钟）。跨任务记忆的代价由调用方
 * 决定带不带收尾摘要（cli.ts 的 flags.piRolloverCarryChars）。
 */
export async function rolloverPiSession(
  session: PiRuntimeSession,
  opts: { handshakeTimeoutMs?: number; log?: (m: string) => void; warn?: (m: string) => void } = {},
): Promise<string | null> {
  const timeoutMs = opts.handshakeTimeoutMs ?? PI_DEFAULT_HANDSHAKE_MS;
  const r = await session.client.request("new_session", {}, timeoutMs).catch((e: unknown) => {
    opts.warn?.(`[pi] new_session 失败：${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  if (!r) return null;
  if (r.success !== true) {
    // 失败要说话：不写的运维会以为会话已经换新了，而上下文还在老路上跑。
    opts.warn?.(`[pi] new_session 被拒：${JSON.stringify(r.error ?? r)}，本轮继续用旧 session`);
    return null;
  }
  if ((r.data as { cancelled?: unknown } | undefined)?.cancelled === true) {
    // 扩展取消了新会话：不能谎称已滚存。
    opts.warn?.("[pi] new_session 被扩展取消，本轮继续用旧 session");
    return null;
  }
  const st = await probePiState(session.client, timeoutMs);
  if (!st?.sessionId) {
    opts.warn?.("[pi] 滚存后 get_state 没给出 sessionId，不写回 config");
    return null;
  }
  session.sessionId = st.sessionId;
  if (st.sessionFile) session.sessionFile = st.sessionFile;
  opts.log?.(`[pi] 会话已滚存 → ${st.sessionId.slice(0, 8)}...`);
  return st.sessionId;
}

export interface PiThinkOptions {
  /** User turn text. Sent verbatim as the prompt message. */
  prompt: string;
  /** Idle timeout ms; 0 disables. Streaming records reset the timer.
   *  Default 30 min. */
  idleTimeoutMs?: number;
  /** `prompt` 的 ack 预算。现场压缩把 ack 拖到 420–540s，默认 900s。
   *  旧版这里就是硬编的 15000。 */
  promptAckTimeoutMs?: number;
  /** `get_state`（发前探测 / 握手）预算。 */
  handshakeTimeoutMs?: number;
  /** ack 超时后「已接受、ack 迟到」的观察窗。默认 30s。 */
  lateAckMs?: number;
  /**
   * idle 超时后、杀子进程之前的宽限窗。默认 90s。
   *
   * #3071 的原话：「289 条超时任务…那一轮跑完了，但没人在听」。旧版一到大
   * idle 就 SIGKILL，那一轮的正文直接丢了。现场是冷启动 884s + 压缩 9min +
   * 满 32K 输出 18min 可以叠加出超过 idle 预算的合法长轮，所以对慢设备这一
   * 条是必需项：先给一段宽限，能收到 settled 就**照常交付结果**，收不到才杀。
   */
  lateSettleGraceMs?: number;
  /** 忙碌策略，默认 "queue"。 */
  busyPolicy?: PiBusyPolicy;
  /** RFC-043 D7 — disable the empty-reply rescue re-prompt.
   *  Falls through to env ANET_DISABLE_383_REPROMPT=1 if unset. */
  disableRescue?: boolean;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  /** Exact prompt request was accepted (disposition started/queued). */
  onSubmitted?: () => void;
  /** Turn completed (agent_settled reached). */
  onConsumed?: () => void;
  /** 排队/压缩中：调用方拿去报 hub（节点保持 working，任务文本说清在等什么）。 */
  onBusy?: (reason: "streaming" | "compacting" | "unknown", waitedMs: number) => void;
}

export interface PiThinkResult {
  /** Final assistant text. Empty only if the turn ended with no text AND
   *  the rescue also produced nothing (or was disabled). */
  replyText: string;
  /** Persisted sessionId used on this turn. */
  sessionId: string;
  /** Terminal turn state. */
  state: PiTurnState;
  /** Whether the empty-reply rescue fired this turn. */
  rescued: boolean;
}

/** One prompt → agent_settled cycle. Reduces events into `state`. */
async function thinkOnce(
  client: PiRpcClient,
  prompt: string,
  opts: PiThinkOptions,
  state: PiTurnState,
  idleTimeoutMs: number,
): Promise<void> {
  const ackTimeoutMs = opts.promptAckTimeoutMs ?? PI_DEFAULT_PROMPT_ACK_MS;
  const handshakeMs = opts.handshakeTimeoutMs ?? PI_DEFAULT_HANDSHAKE_MS;
  const lateAckMs = opts.lateAckMs ?? PI_DEFAULT_LATE_ACK_MS;
  const busyPolicy = opts.busyPolicy ?? "queue";

  // 1) 先把 record 流接上，再发 prompt —— 顺序不能反：排队提交时上一轮的
  //    settled 可能在我们拿到 ack 之前就到，错过就只能等下一次。
  //    完成判据由 `requireRunStart` 控制（ack 之后才定），防把上一轮正文当本任务回复。
  let requireRunStart = false;
  // ack 之前到达的 agent_settled 一律不算本任务完成 —— 它是**上一轮**遗留的。
  // 排队提交（disposition=queued）时这条尤其致命：旧 settled 比本任务的
  // response 先到，装了监听就立刻「完成」，回复正文是空的。
  let acked = false;
  let removeListener: (() => void) | null = null;
  // removeListener 只在 onRecord 闭包里被置空。TS 的控制流分析看不到闭包里的赋值，
  // 于是把调用点收窄成 null —— 对 null 用 `?.()` 得到 never，报 TS2349「不可调用」。
  // 把读取放进函数：嵌套作用域里收窄重置回声明类型，调用点就合法了。
  const clearListener = () => {
    const off = removeListener;
    removeListener = null;
    off?.();
  };
  const settledPromise = new Promise<void>((resolve) => {
    const onRecord = (r: PiRpcRecord) => {
      reducePiRecord(state, r);
      if (!acked) return;
      if (turnCompletedFor(state, requireRunStart)) {
        client.removeListener("record", onRecord);
        removeListener = null;
        resolve();
      }
    };
    client.on("record", onRecord);
    removeListener = () => client.removeListener("record", onRecord);
  });

  const send = (extra: Record<string, unknown>) =>
    client.request("prompt", { message: prompt, ...extra }, ackTimeoutMs);

  // 2) 发前探测忙碌：isStreaming / isCompacting 是 pi 自己报的，不靠撞。
  const probe = await probePiState(client, handshakeMs);
  const reason: "streaming" | "compacting" | "unknown" =
    probe === null ? "unknown" : probe.isCompacting ? "compacting" : probe.isStreaming ? "streaming" : "unknown";
  const busy = probe !== null && (probe.isStreaming || probe.isCompacting);

  if (busy && busyPolicy === "skip") {
    clearListener();
    throw new PiRuntimeError(
      "pi_runtime_busy",
      `模型忙（${reason === "compacting" ? "压缩中" : "上一轮未结束"}），本轮未提交`,
    );
  }

  let behavior: "followUp" | undefined =
    busy && busyPolicy === "queue" ? "followUp" : undefined;

  // 3) 发 prompt，量 ack。
  let disposition: "started" | "queued" | "handled" | "unknown" = "unknown";
  let ackMs = 0;
  const t0 = Date.now();
  try {
    const resp = await send(behavior ? { streamingBehavior: behavior } : {});
    ackMs = Date.now() - t0;
    if (resp.success !== true) {
      const blob = JSON.stringify(resp.error ?? resp);
      // 旧版到这里直接抛 ⇒ 「pi 忙」等于「任务失败」。
      // 只有一例可安全挽救：我们在 pi 流式时裸发了 prompt（rpc-commands.md:29
      // 明写这会报错）。带 followUp 重发一次；重发不会跑两遍，因为我们还
      // 什么都没开始（runStarted=false 且本轮零产出）。
      const streamingRejection = /stream|processing|busy|running|interrupt|queue/i.test(blob);
      if (!behavior && busyPolicy !== "fail" && streamingRejection && !state.runStarted) {
        opts.warn?.(`[pi] prompt 被拒（模型在忙），带 followUp 排队重发一次：${blob}`);
        behavior = "followUp";
        const t1 = Date.now();
        const resp2 = await send({ streamingBehavior: "followUp" }).catch((e: unknown) => {
          throw new PiRuntimeError(
            "pi_prompt_ack_timeout",
            `排队重发也超时：${e instanceof Error ? e.message : String(e)}；ack 预算 ${ackTimeoutMs}ms`,
          );
        });
        ackMs += Date.now() - t1;
        if (resp2.success !== true) {
          throw new PiRuntimeError(
            "pi_prompt_rejected",
            `pi prompt 排队后仍被拒：${JSON.stringify(resp2.error ?? resp2)}`,
          );
        }
        disposition = dispositionOf(resp2);
      } else {
        throw new PiRuntimeError(
          "pi_prompt_rejected",
          `pi prompt 被拒（忙碌策略=${busyPolicy}）：${blob}`,
        );
      }
    } else {
      disposition = dispositionOf(resp);
    }
  } catch (e: unknown) {
    if (e instanceof PiRuntimeError) {
      clearListener();
      throw e;
    }
    // ack 超时是一个**不确定态**：pi 可能已经接受了这条 prompt，回复就在流里。
    // 直接重发 = 同一任务跑两遍（低端设备上这是最贵的错）。
    // 先进观察窗：有活动 = ack 迟到，继续等；零活动 = 才允许一次排队重发。
    const waited = Date.now() - t0;
    // 先进观察窗。注意证据不只看将来：**超时之前就已经到达的记录**同样是证据
    // （压缩的 compaction_start 比 ack 超时早得多，只看将来会错过它）。
    const evidenceNow =
      state.runStarted ||
      state.messageCount > 0 ||
      state.deltaCount > 0 ||
      state.compactionCount > 0 ||
      state.agentEnded ||
      state.settled;
    const evidence = evidenceNow || (await watchForAccept(client, lateAckMs, state));
    if (evidence) {
      opts.warn?.(
        `[pi] prompt ack 迟到：${waited}ms 内无 response，但本轮已有活动` +
          `（run=${state.runStarted} 消息=${state.messageCount} 压缩=${state.compactionCount}）` +
          ` ⇒ 视为已接受，继续等本轮，不重发`,
      );
      disposition = "queued";
      ackMs = waited;
    } else {
      const resendSafe = !state.runStarted && state.messageCount === 0 && state.deltaCount === 0;
      if (!resendSafe || busyPolicy === "fail") {
        clearListener();
        throw new PiRuntimeError(
          "pi_prompt_ack_timeout",
          `等 pi 接受 prompt 超时 ${waited}ms（ack 预算 ${ackTimeoutMs}ms，现场压缩可达 9 分钟；`
            + `调 flags.piPromptAckTimeoutMs / PI_PROMPT_ACK_TIMEOUT_MS），且本轮已有活动，不重发`,
        );
      }
      opts.warn?.(`[pi] prompt ack 超时 ${waited}ms，零活动 ⇒ 带 followUp 重发恰好一次`);
      // 重发也是一次「排队提交」：报给调用方，指挥室看得到节点在等什么，
      // 节点保持 working 而不是安静地重试（#1005 的反面：把等待报出去）。
      opts.onBusy?.("unknown", waited);
      behavior = "followUp";
      const resp3 = await send({ streamingBehavior: "followUp" }).catch((e2: unknown) => {
        throw new PiRuntimeError(
          "pi_prompt_ack_timeout",
          `prompt 连续两次 ack 超时（ack 预算 ${ackTimeoutMs}ms；调 flags.piPromptAckTimeoutMs / PI_PROMPT_ACK_TIMEOUT_MS）：`
            + `${e2 instanceof Error ? e2.message : String(e2)}`,
        );
      });
      ackMs = Date.now() - t0;
      if (resp3.success !== true) {
        throw new PiRuntimeError("pi_prompt_rejected", `pi prompt 排队重发被拒：${JSON.stringify(resp3.error ?? resp3)}`);
      }
      disposition = dispositionOf(resp3);
    }
  }

  acked = true;
  opts.log?.(
    `[pi] prompt ack ${ackMs}ms disposition=${disposition}` +
    (behavior ? ` streamingBehavior=${behavior}` : "") +
    (probe ? ` isStreaming=${probe.isStreaming} isCompacting=${probe.isCompacting}` : " probe=unknown"),
  );

  // 4) 完成判据：排队提交时必须等本轮真正开始后的 settled。
  requireRunStart = disposition === "queued";
  if (disposition === "handled") {
    // 扩展/输入处理器吃了这条 prompt：没有 run 开始，不能等 agent_settled
    // （等到地老天荒只会变成 idle 超时）。
    opts.warn?.("[pi] disposition=handled：本轮没有 run 开始，不等 agent_settled");
    clearListener();
    opts.onSubmitted?.();
    opts.onConsumed?.();
    return;
  }

  opts.onSubmitted?.();
  if (requireRunStart) {
    // 排队不是失败，也不是「卡死」：把它报出去，指挥室看得到在等什么。
    // 注意不照抄 capacity-retry 的「模型满载」文案：这里的原因是压缩/上一轮，不是满载。
    const fired = Date.now();
    opts.onBusy?.(reason, 0);
    opts.log?.(`[pi] 排队提交（${reason}），等当轮结束；等待由 idle 预算 ${idleTimeoutMs}ms 兑住`);
    void fired;
  }

  // 5) Idle watchdog（原语义不变：流式活动重置计时器）。
  let watchdog: NodeJS.Timeout | null = null;
  const timeoutPromise =
    idleTimeoutMs > 0
      ? new Promise<"timeout">((resolve) => {
          const check = () => {
            if (turnCompletedFor(state, requireRunStart)) return;
            const elapsed = Date.now() - client.lastActivityAt;
            if (elapsed > idleTimeoutMs) {
              resolve("timeout");
              return;
            }
            watchdog = setTimeout(check, Math.min(5000, idleTimeoutMs - elapsed));
          };
          watchdog = setTimeout(check, 5000);
        })
      : new Promise<"timeout">(() => {});

  const outcome = await Promise.race([settledPromise.then(() => "settled" as const), timeoutPromise]);
  if (outcome === "timeout") {
    // #3071：先给一段宽限，别把一整轮成果 SIGKILL 掉。
    const graceMs = opts.lateSettleGraceMs ?? 90_000;
    const late =
      graceMs > 0
        ? await Promise.race([
            settledPromise.then(() => true as const),
            new Promise<false>((r) => setTimeout(() => r(false), graceMs)),
          ])
        : false;
    if (late) {
      opts.warn?.(
        `[pi] idle 超时后 ${graceMs}ms 内收到 settled ⇒ 本轮作为迟到结果交付（不杀进程、不丢正文）`,
      );
      if (watchdog) clearTimeout(watchdog);
      clearListener();
      opts.onConsumed?.();
      return;
    }
    client.kill();
    clearListener();
    const note =
      state.compactionCount > 0
        ? `本轮观察到压缩 ${state.compactionCount} 次（累计 ${Math.round(state.compactionMs / 1000)}s，`
          + `摘要 ${state.compactionTokens} token）——压缩期间 stdout 静默，watchdog 量的就是这个`
        : "本轮无压缩记录";
    throw new Error(
      `pi turn idle timeout after ${idleTimeoutMs}ms；${note}；` +
      `调 flags.piTimeoutMs / PI_TIMEOUT_MS（现 ${idleTimeoutMs}ms）`,
    );
  }
  if (watchdog) clearTimeout(watchdog);
  clearListener();
  if (state.compactionCount > 0) {
    opts.log?.(
      `[pi] 本轮压缩 ${state.compactionCount} 次 = ${Math.round(state.compactionMs / 1000)}s，`
        + `摘要 ${state.compactionTokens} token，压缩后上下文约 ${state.compactionTokensAfter} token`,
    );
  }
  opts.onConsumed?.();
}

/** `prompt` response 里的 data.disposition；新版 pi 缺字段不崩。 */
function dispositionOf(resp: PiRpcRecord): "started" | "queued" | "handled" | "unknown" {
  const d = (resp.data as { disposition?: unknown } | undefined)?.disposition;
  return d === "started" || d === "queued" || d === "handled" ? d : "unknown";
}

/**
 * ack 超时后的观察窗：看到任何「接受证据」就不重发。
 * 证据 = run 开始 / 消息活动 / 压缩开始 / 流结束（任何一条都说明 pi 在动）。
 * 顺手把看到的记录归约进 state，不丢事件。
 */
function watchForAccept(client: PiRpcClient, windowMs: number, state: PiTurnState): Promise<boolean> {
  if (windowMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onRecord = (r: PiRpcRecord) => {
      reducePiRecord(state, r);
      const t = r.type;
      if (
        t === "agent_start" || t === "turn_start" || t === "message_start" ||
        t === "message_update" || t === "compaction_start" || t === "agent_end" ||
        t === "agent_settled"
      ) {
        cleanup();
        resolve(true);
      }
    };
    const timer = setTimeout(() => { cleanup(); resolve(false); }, windowMs);
    function cleanup() {
      clearTimeout(timer);
      client.removeListener("record", onRecord);
    }
    client.on("record", onRecord);
  });
}

export async function think(session: PiRuntimeSession, opts: PiThinkOptions): Promise<PiThinkResult> {
  const { client } = session;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60 * 1000;
  const disableRescue =
    opts.disableRescue ?? process.env.ANET_DISABLE_383_REPROMPT === "1";

  const state = newPiTurnState();
  await thinkOnce(client, opts.prompt, opts, state, idleTimeoutMs);

  let rescued = false;
  if (state.replyText === "" && !disableRescue) {
    // RFC-043 D7 — #383 precedent: a silent terminal turn is re-prompted
    // ONCE for plain text; never loop.
    const rescue = newPiTurnState();
    await thinkOnce(client, PI_RESCUE_PROMPT, opts, rescue, idleTimeoutMs).catch((e: unknown) => {
      opts.warn?.(`[pi] rescue re-prompt failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (rescue.replyText !== "") {
      state.replyText = rescue.replyText;
      state.deltaCount += rescue.deltaCount;
      state.messageCount += rescue.messageCount;
      state.agentEnded = state.agentEnded || rescue.agentEnded;
      state.settled = state.settled || rescue.settled;
      rescued = true;
    }
  }

  return { replyText: state.replyText, sessionId: session.sessionId, state, rescued };
}
