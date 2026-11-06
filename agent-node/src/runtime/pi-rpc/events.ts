// RFC-043 — pi RPC session-event reduction.
//
// Reduces the pi RPC stdout event stream (see pi.dev/docs/latest/rpc:
// JSON Event Stream; schema verified by M0 probe) into per-turn state.
//
// Events observed by M0 probe (census): agent_start / turn_start /
// message_start / message_end / message_update / turn_end / agent_end /
// agent_settled. The only text payload rides on `message_update` →
// `assistantMessageEvent.type === "text_delta"`.
//
// 2026-11-04（低端设备跑本地大模型）加了三样，都是为了让「压缩」和「排队」
// 变成可观测、可判定的东西，而不是运维猜：
//   - `runStarted`：排队提交时，谁的 settled 才算本任务的 settled
//   - `compaction_*`：压缩墙钟与摘要 token 数（pi 自己在 `compaction_end` 里报）
//   - 压缩期间的**静默**是 idle watchdog 量到的东西，必须留数

export interface PiTurnState {
  /** Accumulated final assistant text (text_delta concat). */
  replyText: string;
  /** Accumulated thinking text (for logs / debugging). */
  thoughtText: string;
  /** Count of assistant text deltas observed this turn. */
  deltaCount: number;
  /** Count of message records observed this turn. */
  messageCount: number;
  /** Whether agent_settled was observed (pi will not continue by itself). */
  settled: boolean;
  /** Whether agent_end was observed (one low-level run finished). */
  agentEnded: boolean;
  /**
   * Whether a run *started* after we sent our prompt (agent_start / turn_start).
   *
   * 这是「排队提交」时的完成判据。session 是长期复用的，我们发 prompt 时 pi 可能
   * 正在跑上一轮的收尾（压缩、overflow recovery、follow-up）。那个 run 自己的
   * `agent_settled` 会先到 —— 把它当本任务的完成，就会把**上一轮的正文**当本任务
   * 的回复发回 hub。`disposition: "queued"` 下必须先看到 run 真正开始。
   */
  runStarted: boolean;
  /** `compaction_start` → `compaction_end` 累计墙钟（ms）；没压缩 = 0。 */
  compactionMs: number;
  /** 摘要那次 LLM 调用报的 token 数（`compaction_end.usage.totalTokens`）。 */
  compactionTokens: number;
  /** 压缩后的上下文估计（`estimatedTokensAfter`）；没报到 = 0。 */
  compactionTokensAfter: number;
  /** 压缩次数（一轮里可能不止一次：threshold + overflow recovery）。 */
  compactionCount: number;
  /** 内部：压缩开始时间戳，`compaction_end` 到达时算墙钟。 */
  compactionStartedAtMs?: number;
}

export function newPiTurnState(): PiTurnState {
  return {
    replyText: "",
    thoughtText: "",
    deltaCount: 0,
    messageCount: 0,
    settled: false,
    agentEnded: false,
    runStarted: false,
    compactionMs: 0,
    compactionTokens: 0,
    compactionTokensAfter: 0,
    compactionCount: 0,
  };
}

export interface PiRecordLike {
  type?: unknown;
  [k: string]: unknown;
}

/** Merge one stdout record into the turn state; returns the state. */
export function reducePiRecord(
  state: PiTurnState,
  record: PiRecordLike,
  now: () => number = () => Date.now(),
): PiTurnState {
  const type = record.type;
  if (typeof type !== "string") return state;

  if (type === "message_update") {
    const ev = record.assistantMessageEvent as
      | { type?: unknown; delta?: unknown; thinkingDelta?: unknown }
      | undefined;
    if (ev && typeof ev === "object") {
      if (ev.type === "text_delta" && typeof ev.delta === "string") {
        state.replyText += ev.delta;
        state.deltaCount += 1;
      } else if (ev.type === "thinking_delta" && typeof ev.thinkingDelta === "string") {
        state.thoughtText += ev.thinkingDelta;
      }
    }
  } else if (type === "message_start" || type === "message_end") {
    state.messageCount += 1;
  } else if (type === "agent_start" || type === "turn_start") {
    state.runStarted = true;
  } else if (type === "compaction_start") {
    state.compactionStartedAtMs = now();
    state.compactionCount += 1;
  } else if (type === "compaction_end") {
    if (typeof state.compactionStartedAtMs === "number") {
      state.compactionMs += Math.max(0, now() - state.compactionStartedAtMs);
      state.compactionStartedAtMs = undefined;
    }
    const usage = record.usage as { totalTokens?: unknown } | undefined;
    if (usage && typeof usage.totalTokens === "number") state.compactionTokens += usage.totalTokens;
    const after = record.estimatedTokensAfter;
    if (typeof after === "number") state.compactionTokensAfter = after;
  } else if (type === "agent_end") {
    state.agentEnded = true;
  } else if (type === "agent_settled") {
    state.settled = true;
  }
  return state;
}

/** True when a turn is complete: pi will not continue by itself. */
export function turnCompleted(state: PiTurnState): boolean {
  return state.settled;
}

/**
 * 排队提交时的完成判据：看到本轮真正开始**之后**的 settled。
 * 非排队提交（disposition=started/handled）沿用 `turnCompleted`。
 */
export function turnCompletedFor(state: PiTurnState, requireRunStart: boolean): boolean {
  if (!state.settled) return false;
  return requireRunStart ? state.runStarted : true;
}
