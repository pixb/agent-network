// RFC-043 M4/L3 — real-model smoke: pi RPC -> host ollama (qwen2.5:14b).
// Requires the host ollama to be running (host.docker.internal:11434).
// The test probes reachability first and skips (with a visible note) when
// ollama is absent — so the whole probe suite stays green offline.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { openPiRuntime, think } from "./pi-rpc/runtime";
import { checkPiAuth } from "./pi-rpc/preflight";

const OLLAMA_BASE = "http://host.docker.internal:11434";
const MODEL = "qwen2.5:14b";

async function ollamaReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_BASE}/v1/models`, { signal: AbortSignal.timeout(4000) });
    return r.status === 200;
  } catch {
    return false;
  }
}

const reachable = await ollamaReachable();
console.log(
  reachable
    ? `L3: host ollama reachable at ${OLLAMA_BASE}`
    : `L3: ollama NOT reachable at ${OLLAMA_BASE} — real-model smoke SKIPPED (offline ok)`,
);

function writePiConfig(): void {
  const dir = join(homedir(), ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  // Custom provider pointing at host ollama's OpenAI-compatible endpoint.
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify(
      {
        providers: {
          ollama: {
            baseUrl: `${OLLAMA_BASE}/v1`,
            // pi 1.3.0 只注册了 "openai-completions"（openai-chat-completions
            // 会报 "No API provider registered" 且被 pi 静默吞成空回复 — M4 实测）。
            models: [{ id: MODEL, api: "openai-completions" }],
          },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ ollama: { type: "api_key", key: "ollama" } }, null, 2),
  );
}

describe("L3: real ollama smoke", () => {
  test.skipIf(!reachable)("preflight: ollama provider ready", async () => {
    writePiConfig();
    const r = await checkPiAuth({ provider: "ollama", model: MODEL, timeoutMs: 15000 });
    expect(r.state).toBe("ready");
  }, 20000);

  test.skipIf(!reachable)(
    "pi think -> qwen2.5:14b replies (real model, non-empty)",
    async () => {
      writePiConfig();
      const session = await openPiRuntime({
        workDir: "/tmp",
        provider: "ollama",
        model: MODEL,
      });
      try {
        const r = await think(session, { prompt: "Reply with exactly OLLAMA_OK", idleTimeoutMs: 180000 });
        console.log(`L3: real reply (${r.replyText.length}ch): ${JSON.stringify(r.replyText.slice(0, 200))}`);
        expect(r.replyText.length).toBeGreaterThan(0);
        expect(r.replyText).toContain("OLLAMA_OK");
      } finally {
        await session.client.shutdown();
      }
    },
    240000,
  );
});
