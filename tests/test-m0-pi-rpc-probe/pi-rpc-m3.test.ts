// RFC-043 M3 — pi-rpc safety hardening tests (real pi + stub provider).
// Covers D3 (safe tool allowlist / trust args), D5 (preflight) and
// D7 (empty-reply rescue). Runs inside the probe container.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildPiArgs, openPiRuntime, think, type PiRuntimeSession } from "./pi-rpc/runtime";
import { checkPiAuth, parseAuthState } from "./pi-rpc/preflight";

describe("D3: buildPiArgs safety defaults", () => {
  test("safe mode: read-only allowlist + trust boundaries", () => {
    const args = buildPiArgs({});
    expect(args).toContain("--mode");
    expect(args).toContain("rpc");
    expect(args).toContain("--tools");
    const toolsIdx = args.indexOf("--tools");
    expect(args[toolsIdx + 1]).toBe("read,grep,find,ls");
    expect(args).toContain("--no-approve");
    expect(args).toContain("--no-context-files");
  });

  test("unsafe mode: all built-ins, trust boundaries kept", () => {
    const args = buildPiArgs({ unsafeTools: true });
    const toolsIdx = args.indexOf("--tools");
    expect(args[toolsIdx + 1]).toBe("read,bash,edit,write,grep,find,ls");
    expect(args).toContain("--no-approve"); // trust boundaries NOT relaxed
    expect(args).toContain("--no-context-files");
  });

  test("explicit tools override unsafe default", () => {
    const args = buildPiArgs({ tools: ["read", "grep"] });
    const toolsIdx = args.indexOf("--tools");
    expect(args[toolsIdx + 1]).toBe("read,grep");
  });

  test("session args", () => {
    expect(buildPiArgs({ sessionId: "s1" })).toContain("--session-id");
    expect(buildPiArgs({ sessionDir: "/tmp/pi-s" })).toContain("--session-dir");
    expect(buildPiArgs({ model: "stub/stub-model" })).toContain("--model");
  });
});

describe("D5: preflight via pi auth check", () => {
  test("parseAuthState: json first, exit code fallback", () => {
    expect(parseAuthState('{"state":"ready"}', 1)).toBe("ready");
    expect(parseAuthState("", 0)).toBe("ready");
    expect(parseAuthState("", 1)).toBe("not_ready");
    expect(parseAuthState("", 2)).toBe("invalid");
    expect(parseAuthState("", null)).toBe("unknown");
  });

  test("configured stub provider -> ready (fast, no hang)", async () => {
    const r = await checkPiAuth({ provider: "stub", timeoutMs: 10000 });
    expect(r.state).toBe("ready");
  });

  test("nonexistent provider -> not ready (fast, no hang)", async () => {
    const r = await checkPiAuth({ provider: "no-such-provider", timeoutMs: 10000 });
    expect(r.state).not.toBe("ready");
    expect(r.exitCode).not.toBe(null);
  });
});

describe("D7: empty-reply rescue", () => {
  let session: PiRuntimeSession | null = null;

  beforeAll(async () => {
    session = await openPiRuntime({
      workDir: "/tmp",
      model: "stub/stub-model",
      provider: "stub",
    });
  });

  afterAll(async () => {
    if (session) await session.client.shutdown();
  });

  test("empty reply -> rescue re-prompts once and returns text", async () => {
    const r = await think(session!, { prompt: "Reply with exactly", disableRescue: false });
    expect(r.rescued).toBe(true);
    expect(r.replyText.trim()).toBe("STUB_OK"); // rescue prompt answered by stub
  });

  test("disableRescue -> empty reply stays empty", async () => {
    const r = await think(session!, { prompt: "Reply with exactly", disableRescue: true });
    expect(r.rescued).toBe(false);
    expect(r.replyText).toBe("");
  });
});
