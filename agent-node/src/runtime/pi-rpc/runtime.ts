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

import { PiRpcClient, type PiRpcRecord } from "./client";
import { newPiTurnState, reducePiRecord, turnCompleted, type PiTurnState } from "./events";

export const PI_SAFE_TOOLS = ["read", "grep", "find", "ls"] as const;
export const PI_UNSAFE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const PI_RESCUE_PROMPT = "请用一句面向用户的纯文本给出最终答复";

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
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  /** Persisted sessionId callback (anet config.session writeback). */
  onSession?: (sessionId: string) => void | Promise<void>;
}

export interface PiRuntimeSession {
  client: PiRpcClient;
  sessionId: string;
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
  const args = buildPiArgs(opts);

  const client = new PiRpcClient();
  client.spawn({ cwd: opts.workDir, env: opts.env, binary: opts.binary, args });

  const gs = await client.request("get_state", {}, 15000);
  if (gs.success !== true) {
    await client.shutdown().catch(() => {});
    throw new Error(`pi get_state failed: ${JSON.stringify(gs.error ?? gs)}`);
  }
  const data = (gs.data ?? {}) as { sessionId?: unknown };
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
  if (opts.onSession && sessionId) await opts.onSession(sessionId);
  return { client, sessionId };
}

export interface PiThinkOptions {
  /** User turn text. Sent verbatim as the prompt message. */
  prompt: string;
  /** Idle timeout ms; 0 disables. Streaming records reset the timer.
   *  Default 30 min. */
  idleTimeoutMs?: number;
  /** RFC-043 D7 — disable the empty-reply rescue re-prompt.
   *  Falls through to env ANET_DISABLE_383_REPROMPT=1 if unset. */
  disableRescue?: boolean;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  /** Exact prompt request was accepted (disposition started/queued). */
  onSubmitted?: () => void;
  /** Turn completed (agent_settled reached). */
  onConsumed?: () => void;
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
  // Reduce every stdout record until agent_settled.
  const settledPromise = new Promise<void>((resolve) => {
    const onRecord = (r: PiRpcRecord) => {
      reducePiRecord(state, r);
      if (turnCompleted(state)) {
        client.removeListener("record", onRecord);
        resolve();
      }
    };
    client.on("record", onRecord);
  });

  // Idle watchdog: lastActivityAt-driven; streaming keeps the turn alive.
  let watchdog: NodeJS.Timeout | null = null;
  const timeoutPromise =
    idleTimeoutMs > 0
      ? new Promise<"timeout">((resolve) => {
          const check = () => {
            if (turnCompleted(state)) return;
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

  const resp = await client.request("prompt", { message: prompt }, 15000);
  if (resp.success !== true) {
    if (watchdog) clearTimeout(watchdog);
    throw new Error(`pi prompt rejected: ${JSON.stringify(resp.error ?? resp)}`);
  }
  opts.onSubmitted?.();

  const outcome = await Promise.race([settledPromise.then(() => "settled" as const), timeoutPromise]);
  if (outcome === "timeout") {
    client.kill();
    throw new Error(`pi turn idle timeout after ${idleTimeoutMs}ms`);
  }
  if (watchdog) clearTimeout(watchdog);
  opts.onConsumed?.();
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
