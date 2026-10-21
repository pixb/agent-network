// RFC-043 M1 — pi-rpc adapter integration tests.
// Runs inside the M0/M1 probe container: real `pi --mode rpc` + stub provider.
// Imports the adapter source from /fixture/pi-rpc (COPY of agent-node/src/runtime/pi-rpc).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openPiRuntime, think, type PiRuntimeSession } from "./pi-rpc/runtime";

let session: PiRuntimeSession | null = null;

describe("pi-rpc happy path (real pi binary + stub provider)", () => {
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

  test("openPiRuntime returns a sessionId", () => {
    expect(session!.sessionId.length).toBeGreaterThan(0);
  });

  test("think turn1 -> PONG", async () => {
    const r = await think(session!, { prompt: "Reply with exactly PONG" });
    expect(r.replyText.trim()).toBe("PONG");
  });

  test("think turn2 -> PONG2 (same process, multi-turn)", async () => {
    const r = await think(session!, { prompt: "Reply with exactly PONG2" });
    expect(r.replyText.trim()).toBe("PONG2");
  });

  test("shutdown exits cleanly", async () => {
    const code = await session!.client.shutdown();
    expect(code).toBe(0);
  });
});
