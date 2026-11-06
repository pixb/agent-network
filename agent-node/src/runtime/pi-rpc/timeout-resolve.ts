// RFC-043 pi runtime — 分相超时解析。
//
// 现场（2026-11-04，低端设备跑本地大模型，192.168.1.33 / GTX 1070 8GB，实测）：
//   - prompt 前的自动压缩 = 420–540s（82K token 摘要，摘要请求关闭 prompt-cache
//     写入 ⇒ 每次全量 prefill，201 tok/s）
//   - 引擎冷启动 = 884s
//   - 满 32K 输出 = 18min
//   而 `prompt` 的 ack 超时是硬编 15s（`runtime.ts` 旧版），握手也一样。
//   ⇒ 压缩一触发就 100% 判失败，而 30min 的 idle 预算从来不是瓶颈。
//
// 一条 ack 不能同时管三件事：握手（`get_state`，本地，不打模型）、
// prompt 接受确认（会被压缩/忙碌拖长）、整轮 idle（流式活动重置）。
// 所以分三相，各自可配，各自打印来源 —— 形状照 grok 的
// `grok-build-acp/timeout-resolve.ts`（#214 维度 5 A6：「配置里写了值」不等于
// 「运行时用了这个值」，运维被这个坑咬过）。
//
// 优先级与 grok 一致：**env > flags > default**，并返回来源标签。
// `flags.piTimeoutMs`（整轮 idle）保持 cli.ts 原有的 flags 优先语义不变，
// 不在本模块里，避免改动既有行为。

/** 旧版硬编值，作为下限保留：低于它就是把合法压缩判成失败。 */
export const PI_TIMEOUT_FLOOR_MS = 15_000;

/** 上限：一天。超过它等于「没有超时」，那不如显式关掉。 */
export const PI_TIMEOUT_CEILING_MS = 86_400_000;

export type PiTimeoutSource = "env" | "flags" | "default" | "floor" | "ceiling";

export interface ResolvedPiTimeout {
  valueMs: number;
  source: PiTimeoutSource;
  rawValue?: string;
}

export const PI_DEFAULT_HANDSHAKE_MS = 45_000;
/** 实测压缩 420–540s ⇒ 取 1.7x 余量。握手与 ack 是分开的两条线。 */
export const PI_DEFAULT_PROMPT_ACK_MS = 900_000;
/** ack 超时后「已接受、ack 迟到」的观察窗：有活动就继续等，不重发。 */
export const PI_DEFAULT_LATE_ACK_MS = 30_000;

/**
 * env > flags > default，然后夹进 [floor, ceiling]。
 * 夹住时 source 说明是被谁夹的 —— 运维看到 `floor` 就知道自己写了个
 * 比压缩还短的值，那等于把合法压缩判成失败。
 */
export function resolvePiTimeout(opts: {
  envValue?: string | number | null;
  flagValue?: string | number | null;
  defaultMs: number;
  floorMs?: number;
  ceilingMs?: number;
}): ResolvedPiTimeout {
  const floor = opts.floorMs ?? PI_TIMEOUT_FLOOR_MS;
  const ceiling = opts.ceilingMs ?? PI_TIMEOUT_CEILING_MS;

  const picked: { valueMs: number; source: PiTimeoutSource; rawValue?: string } =
    parseNumeric(opts.envValue) !== null
      ? { valueMs: parseNumeric(opts.envValue)!, source: "env", rawValue: String(opts.envValue) }
      : parseNumeric(opts.flagValue) !== null
        ? { valueMs: parseNumeric(opts.flagValue)!, source: "flags", rawValue: String(opts.flagValue) }
        : { valueMs: opts.defaultMs, source: "default" };

  // 默认值不受 floor/ceiling 管辖：夹住默认值会把「clamp」的成因说成「你写的值」，
  // 而 floor 的全部意义就是告诉运维「你写的这个值比一次压缩还短」。
  if (picked.source === "default") return picked;

  if (picked.valueMs < floor) return { valueMs: floor, source: "floor", rawValue: picked.rawValue };
  if (picked.valueMs > ceiling) return { valueMs: ceiling, source: "ceiling", rawValue: picked.rawValue };
  return picked;
}

/** 0 / "0" 显式表达「关掉这一相」；其余非法值按未设置处理。 */
export function resolvePiSwitch(opts: {
  envValue?: string | number | null;
  flagValue?: string | number | null;
}): { disabled: boolean; set: boolean } {
  const raw = opts.envValue ?? opts.flagValue;
  if (raw === undefined || raw === null || raw === "") return { disabled: false, set: false };
  if (typeof raw === "string" && raw.trim() === "0") return { disabled: true, set: true };
  if (typeof raw === "number" && raw === 0) return { disabled: true, set: true };
  return { disabled: false, set: true };
}

/**
 * 给运维看的一行：`promptAck=900000ms(default) handshake=45000ms(default)`。
 * 被夹住时写清是谁夹的，以及为什么——这行就是「我的值生效了吗」的答案。
 */
export function describePiTimeout(label: string, r: ResolvedPiTimeout): string {
  const clamp =
    r.source === "floor"
      ? `（你写的 ${r.rawValue ?? "?"} 低于下限，按 ${r.valueMs}ms —— 比一次压缩还短的 ack 等于把压缩判成失败）`
      : r.source === "ceiling"
        ? `（你写的 ${r.rawValue ?? "?"} 超过上限，按 ${r.valueMs}ms）`
        : "";
  return `${label}=${r.valueMs}ms(${r.source})${clamp}`;
}

function parseNumeric(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw === "string") {
    if (raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}
