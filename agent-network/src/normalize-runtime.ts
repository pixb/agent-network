// Pure helper — runtime name canonicalization for `anet node` flows.
//
// Extracted from bin/cli.ts so it can be imported by unit tests without
// triggering the CLI side-effects (top-level argv parsing, prompt
// dispatch, etc.).
//
// Per Vincent's "无 Max 军团" directive (2026-06-28): fallback default
// is `claude-agent-sdk` (vendor-neutral, works without Anthropic Max),
// NOT the legacy `claude-code-cli` (Max/Pro-bound, leaves non-
// subscribers with broken nodes). Explicit `claude-code-cli` operator
// choice is preserved. Legacy display/migration call sites keep the old
// unknown->default behavior through `normalizeRuntime()`, while launch and
// create boundaries use `normalizeRuntimeStrict()` so a non-empty typo can
// never silently start a different runtime.

export type RuntimeName =
  | "claude-code-cli"
  | "codex-sdk"
  | "claude-agent-sdk"
  | "grok-build-acp"
  | "grok-build-cli"
  | "opencode-cli"
  | "codex-app-server"
  | "pi-cli";

/** 一个 runtime 复用的是哪种**外部登录态**，而不是 API key。 */
export type ReusedLogin = "claude" | "codex" | "grok";

/**
 * runtime → 它复用的外部登录。**只有一处定义**，VENDORS 的 `requiresAuth`
 * 与登录态探测都引用这里。
 *
 * 不在表里 = 该 runtime 走 API key，不复用任何登录：
 *   · `claude-agent-sdk` —— 走 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY
 *   · `opencode-cli`     —— 走 ANTHROPIC_API_KEY / OPENAI_API_KEY（vendor preset 从 env 读，不 prompt）
 * 这条区分是有意写下来的：Vincent 那句「复用会员登录状态、不用自己输 key 和 url」
 * 点名的是 Claude Code / Codex / Grok 三家，opencode 不在其中，别顺手加进来。
 */
export const RUNTIME_REUSED_LOGIN: Readonly<Partial<Record<RuntimeName, ReusedLogin>>> = {
  "claude-code-cli": "claude",   // claude auth login（订阅，无 model 选择器）
  "codex-sdk": "codex",          // codex login
  "codex-app-server": "codex",   // 同上；TUI 共存走同一个 codex 登录态
  "grok-build-acp": "grok",      // grok login
  "grok-build-cli": "grok",      // 同上；共存 TUI 走同一个 grok 登录态
} as const;

/** 该 runtime 复用哪种登录；返回 undefined 表示它用 API key。 */
export function reusedLoginFor(runtime: RuntimeName): ReusedLogin | undefined {
  return RUNTIME_REUSED_LOGIN[runtime];
}

/** Operator-facing default for a runtime slot that is empty or missing. */
export const DEFAULT_RUNTIME: RuntimeName = "claude-agent-sdk";

export const SUPPORTED_RUNTIME_NAMES: readonly RuntimeName[] = [
  "claude-agent-sdk",
  "claude-code-cli",
  "codex-sdk",
  "codex-app-server",
  "grok-build-acp",
  "grok-build-cli",
  "opencode-cli",
  "pi-cli",
] as const;

/**
 * `anet node start` 会把哪些 runtime 交给 agent-node 子进程。
 *
 * 唯一例外是 `claude-code-cli`：它的执行车道在启动器里（直接 spawn 真正的
 * `claude` CLI），从不过 agent-node。这张表以前在两个地方手写，pi-cli 两次都
 * 漏了（create 的选择器、start 的 spawn 门），症状分别是「建成错 runtime」和
 * `claude: command not found`。表驱动之后新增 runtime 不会再漏。
 */
export const AGENT_NODE_RUNTIMES: readonly RuntimeName[] =
  SUPPORTED_RUNTIME_NAMES.filter((rt) => rt !== "claude-code-cli");

export function launchesAgentNode(runtime: RuntimeName): boolean {
  return AGENT_NODE_RUNTIMES.includes(runtime);
}

/**
 * 「显式 `--runtime` 应该跳过建节点时的 runtime 选择器吗？」
 *
 * 唯一依据是上面那张表 —— 以前这里是手写的 `=== "…" || === "…"` 列表，
 * 新增 runtime（pi-cli）时漏了一行，于是 `anet node create x --runtime pi-cli`
 * 在 TTY 下仍弹出选择器，默认选中 claude-agent-sdk，节点建成了错 runtime。
 * 表驱动能从结构上消灭这一类遗漏。
 */
export function skipsCreateRuntimePicker(runtime: RuntimeName | undefined): boolean {
  return !!runtime && (SUPPORTED_RUNTIME_NAMES as readonly string[]).includes(runtime);
}

// Subset of Profile fields this helper inspects. Keeping it narrow so
// the test fixture doesn't need the full Profile shape and so callers
// (bin/cli.ts uses the full Profile) can pass anything structurally
// compatible.
type ProfileLike = {
  runtime?: string;
  codexRuntime?: string;
};

function canonicalizeRuntime(runtime: string): RuntimeName | undefined {
  // RFC-030 — codex TUI bridge (standalone `codex app-server`). Aliases:
  // `codex-cli` / `codex-tui` / `codex-app-server` / `codex-appserver`. Checked BEFORE
  // the `codex`/`codex-sdk` branch so the more specific names win.
  if (
    runtime === "codex-app-server" ||
    runtime === "codex-appserver" ||
    runtime === "codex-cli" ||
    runtime === "codex-tui"
  ) return "codex-app-server";
  if (runtime === "codex" || runtime === "codex-sdk") return "codex-sdk";
  if (
    runtime === "grok" ||
    runtime === "grok-build" ||
    runtime === "grok-build-acp"
  ) return "grok-build-acp";
  // Grok shared-TUI lane is explicit opt-in. Legacy `grok` aliases stay on
  // ACP so an existing profile can never silently change execution mode.
  if (
    runtime === "grok-build-cli" ||
    runtime === "grok-cli" ||
    runtime === "grok-tui"
  ) return "grok-build-cli";
  if (
    runtime === "claude" ||
    runtime === "claude-sdk" ||
    runtime === "claude-agent-sdk"
  ) return "claude-agent-sdk";
  if (runtime === "agent-sdk") return "claude-agent-sdk";
  // Preserve EXPLICIT `claude-code-cli` choice — operators who
  // actually want CC-CLI still get it.
  if (runtime === "claude-code-cli") return "claude-code-cli";
  // RFC-029 — opencode CLI runtime (public sst/opencode). Aliases:
  // `opencode` (short), `opencode-cli` (canonical, matches
  // claude-code-cli precedent).
  if (runtime === "opencode" || runtime === "opencode-cli") return "opencode-cli";
  // RFC-043 — pi coding agent (public @earendil-works/pi-coding-agent,
  // command `pi`, pi.dev). Aliases: `pi` (short), `pi-cli` (canonical).
  // BYOK — no RUNTIME_REUSED_LOGIN entry (it uses an API key / custom
  // provider, never an external login state).
  if (runtime === "pi" || runtime === "pi-cli") return "pi-cli";
  return undefined;
}

function runtimeValue(profileOrRuntime?: ProfileLike | string): string | undefined {
  if (typeof profileOrRuntime === "string") return profileOrRuntime;
  const profile = profileOrRuntime;
  if (!profile) return undefined;
  if (profile.runtime === "agent-sdk" && profile.codexRuntime === "codex") {
    return "codex-sdk";
  }
  return profile.runtime;
}

/**
 * Legacy normalization used by display and migration code. Missing, empty,
 * and unknown values all use the safe default for backward compatibility.
 * Security-sensitive create/start paths must call `normalizeRuntimeStrict`.
 */
export function normalizeRuntime(profileOrRuntime?: ProfileLike | string): RuntimeName {
  const raw = runtimeValue(profileOrRuntime);
  if (!raw) return DEFAULT_RUNTIME;
  return canonicalizeRuntime(raw) ?? DEFAULT_RUNTIME;
}

/**
 * Canonicalize a runtime at an execution boundary. Missing/empty still means
 * the documented default, but any non-empty unknown value is rejected so a
 * typo or future runtime cannot silently execute as Claude.
 */
export function normalizeRuntimeStrict(profileOrRuntime?: ProfileLike | string): RuntimeName {
  const raw = runtimeValue(profileOrRuntime);
  if (!raw) return DEFAULT_RUNTIME;
  const runtime = canonicalizeRuntime(raw);
  if (!runtime) {
    throw new Error(
      `unsupported runtime ${JSON.stringify(raw)}; expected one of: ` +
      SUPPORTED_RUNTIME_NAMES.join(", "),
    );
  }
  return runtime;
}
