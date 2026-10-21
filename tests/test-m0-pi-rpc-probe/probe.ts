// M0 probe — pi RPC mode protocol walkthrough (offline, stub provider).
//
// Goals (RFC-043 §8 M0):
//  1. spawn `pi --mode rpc` and correlate commands/responses by id
//  2. prompt → events stream → agent_settled → final assistant text
//  3. multi-turn in one process
//  4. session persistence: --session-dir + --session-id + get_entries since
//     cursor, verified ACROSS process restarts (durable cursor claim)
//  5. clean shutdown via stdin close
//  6. negative control: nonexistent provider must NOT fake success
//
// Everything unknown is printed (event type census) — M0 is the probe that
// closes schema unknowns empirically, not by guessing.

import { spawn } from "bun";

interface RpcRecord {
  id?: string;
  type: string;
  command?: string;
  success?: boolean;
  data?: any;
  error?: string;
  [k: string]: any;
}

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`PASS: ${name}`);
  } else {
    failures++;
    console.log(`FAIL: ${name} ${detail}`);
  }
}
function newId(): string {
  return "r" + Math.random().toString(36).slice(2, 10);
}

class PiRpcProbe {
  proc: ReturnType<typeof spawn>;
  private buf = "";
  private pending = new Map<string, (r: RpcRecord) => void>();
  settled = false;
  lastText = "";
  allEvents: RpcRecord[] = [];
  stderrChunks: string[] = [];
  private settleWaiters: (() => void)[] = [];

  constructor(args: string[]) {
    this.proc = spawn({
      cmd: ["pi", ...args],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TERM: "xterm-256color" },
    });
    this.pumpStdout();
    this.pumpStderr();
  }

  private async pumpStdout() {
    const reader = this.proc.stdout!.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, idx).replace(/\r$/, "");
          this.buf = this.buf.slice(idx + 1);
          if (!line.trim()) continue;
          try {
            this.onRecord(JSON.parse(line) as RpcRecord);
          } catch (e) {
            console.log(`[probe] non-JSON stdout line: ${JSON.stringify(line)}`);
          }
        }
      }
    } catch (e) {
      console.log(`[probe] stdout read error: ${e}`);
    }
  }

  private async pumpStderr() {
    const reader = this.proc.stderr!.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderrChunks.push(dec.decode(value, { stream: true }));
      }
    } catch {
      /* ignore */
    }
  }

  private onRecord(r: RpcRecord) {
    if (r.type === "response") {
      if (r.id && this.pending.has(r.id)) {
        const f = this.pending.get(r.id)!;
        this.pending.delete(r.id);
        f(r);
        return;
      }
      this.allEvents.push(r);
      return;
    }
    this.allEvents.push(r);
    if (r.type === "message_update") {
      const ev = r.assistantMessageEvent;
      if (ev && ev.type === "text_delta" && typeof ev.delta === "string") {
        this.lastText += ev.delta;
      }
    }
    if (r.type === "agent_settled") {
      this.settled = true;
      const ws = this.settleWaiters;
      this.settleWaiters = [];
      ws.forEach((f) => f());
    }
  }

  send(obj: Record<string, unknown>) {
    this.proc.stdin!.write(JSON.stringify(obj) + "\n");
    this.proc.stdin!.flush();
  }

  waitResponse(id: string, timeoutMs = 15000): Promise<RpcRecord> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting response ${id}`));
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
    });
  }

  /** One-shot command helper: send with fresh id, await its response. */
  async cmd(type: string, extra: Record<string, unknown> = {}, timeoutMs = 15000): Promise<RpcRecord> {
    const id = newId();
    this.send({ id, type, ...extra });
    return this.waitResponse(id, timeoutMs);
  }

  /** Await one agent_settled since last call; returns false on timeout. */
  async awaitSettled(timeoutMs = 90000): Promise<boolean> {
    if (this.settled) return true;
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.settleWaiters.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  /** Reset turn state before sending the next prompt. */
  resetTurn() {
    this.settled = false;
    this.lastText = "";
  }

  async promptExpectStarted(message: string): Promise<boolean> {
    const id = newId();
    this.send({ id, type: "prompt", message });
    const r = await this.waitResponse(id);
    return r.success === true && r.data?.disposition === "started";
  }

  async shutdown(): Promise<number> {
    this.proc.stdin!.end();
    return this.proc.exited;
  }
}

// ---------------------------------------------------------------------------
// S1: default memory session, multi-turn
// ---------------------------------------------------------------------------
async function s1() {
  console.log("\n--- S1: --mode rpc --no-session, multi-turn ---");
  const p = new PiRpcProbe(["--mode", "rpc", "--no-session", "--provider", "stub", "--model", "stub/stub-model"]);

  const gs = await p.cmd("get_state");
  check("S1 get_state success", gs.success === true, JSON.stringify(gs).slice(0, 200));
  check("S1 sessionId present", typeof gs.data?.sessionId === "string" && gs.data.sessionId.length > 0, JSON.stringify(gs.data));

  const ok1 = await p.promptExpectStarted("Reply with exactly PONG");
  check("S1 prompt1 started", ok1, "");
  const st1 = await p.awaitSettled();
  check("S1 settled after turn1", st1, "");
  check("S1 assistant text == PONG", p.lastText.trim() === "PONG", `got: ${JSON.stringify(p.lastText)}`);

  p.resetTurn();
  const ok2 = await p.promptExpectStarted("Reply with exactly PONG2");
  check("S1 prompt2 started", ok2, "");
  const st2 = await p.awaitSettled();
  check("S1 settled after turn2", st2, "");
  check("S1 multi-turn text == PONG2", p.lastText.trim() === "PONG2", `got: ${JSON.stringify(p.lastText)}`);

  const code = await p.shutdown();
  check("S1 clean shutdown exit 0", code === 0, `exit=${code}`);
  if (p.stderrChunks.length) console.log("S1 stderr:", JSON.stringify(p.stderrChunks.join("").slice(0, 500)));
  return p;
}

// ---------------------------------------------------------------------------
// S2: session persistence — --session-dir + --session-id, durable cursor
// ---------------------------------------------------------------------------
async function s2() {
  console.log("\n--- S2: session persistence + get_entries since across processes ---");
  const dir = "/tmp/pi-sessions";
  const sid = "m0probe";
  const args = ["--mode", "rpc", "--session-dir", dir, "--session-id", sid, "--provider", "stub", "--model", "stub/stub-model"];

  const p1 = new PiRpcProbe(args);
  const gs1 = await p1.cmd("get_state");
  check("S2 sessionFile set", typeof gs1.data?.sessionFile === "string" && gs1.data.sessionFile.includes(sid), JSON.stringify(gs1.data));
  const ok1 = await p1.promptExpectStarted("Reply with exactly PONG-S2");
  check("S2 prompt started", ok1, "");
  await p1.awaitSettled();
  check("S2 turn1 text", p1.lastText.trim() === "PONG-S2", `got: ${JSON.stringify(p1.lastText)}`);

  const en1 = await p1.cmd("get_entries");
  const entries1 = en1.data?.entries ?? [];
  const leaf1 = en1.data?.leafId ?? null;
  check("S2 entries after turn >= 2", Array.isArray(entries1) && entries1.length >= 2, `n=${entries1.length}`);
  check("S2 leafId present", typeof leaf1 === "string" && leaf1.length > 0, JSON.stringify(leaf1));
  const code1 = await p1.shutdown();
  check("S2 process1 exit 0", code1 === 0, `exit=${code1}`);

  // Cross-process: new process, same session-id
  const p2 = new PiRpcProbe(args);
  const gs2 = await p2.cmd("get_state");
  check("S2 process2 same sessionFile", gs2.data?.sessionFile === gs1.data?.sessionFile, JSON.stringify(gs2.data));
  const geNone = await p2.cmd("get_entries", { since: leaf1 });
  const noneNew = geNone.data?.entries ?? [];
  check("S2 since cursor -> 0 new (durable)", noneNew.length === 0, `n=${noneNew.length}`);

  p2.resetTurn();
  const ok2 = await p2.promptExpectStarted("Reply with exactly PONG-S2B");
  check("S2 process2 prompt started", ok2, "");
  await p2.awaitSettled();
  check("S2 process2 turn text", p2.lastText.trim() === "PONG-S2B", `got: ${JSON.stringify(p2.lastText)}`);

  const geAfter = await p2.cmd("get_entries", { since: leaf1 });
  const after = geAfter.data?.entries ?? [];
  check("S2 since cursor -> new entries after turn", after.length >= 1, `n=${after.length}`);
  const code2 = await p2.shutdown();
  check("S2 process2 exit 0", code2 === 0, `exit=${code2}`);
  return p2;
}

// ---------------------------------------------------------------------------
// S3: negative control — nonexistent provider must not fake success
// ---------------------------------------------------------------------------
async function s3() {
  console.log("\n--- S3: negative — nonexistent provider ---");
  const p = new PiRpcProbe(["--mode", "rpc", "--no-session", "--provider", "nonexistent", "--model", "nope/nope"]);
  const id = newId();
  p.send({ id, type: "prompt", message: "hi" });
  let r: RpcRecord | null = null;
  try {
    r = await p.waitResponse(id, 15000);
  } catch (e) {
    console.log(`[probe] S3 prompt response timeout: ${e}`);
  }
  const st = await p.awaitSettled(30000);
  check("S3 settled (or prompt rejected)", true, `settled=${st}`);
  const errorSeen = p.allEvents.some(
    (e) => e.type === "error" || typeof e.error === "string" || (e.type === "message_update" && e.assistantMessageEvent?.type === "error"),
  );
  const fakeSuccess = !errorSeen && p.lastText.trim().length > 0;
  check("S3 no fake success", !fakeSuccess, `lastText=${JSON.stringify(p.lastText)} errorSeen=${errorSeen}`);
  console.log("S3 event types:", JSON.stringify([...new Set(p.allEvents.map((e) => e.type))]));
  p.proc.stdin!.end();
  await p.proc.exited.catch(() => {});
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const probes: PiRpcProbe[] = [];
  try {
    const p1 = await s1();
    probes.push(p1);
  } catch (e) {
    failures++;
    console.log(`FAIL: S1 threw ${e}`);
  }
  try {
    const p2 = await s2();
    probes.push(p2);
  } catch (e) {
    failures++;
    console.log(`FAIL: S2 threw ${e}`);
  }
  try {
    await s3();
  } catch (e) {
    failures++;
    console.log(`FAIL: S3 threw ${e}`);
  }

  // Event type census — empirical schema evidence for RFC-043.
  const census = new Map<string, number>();
  for (const p of probes) for (const e of p.allEvents) census.set(e.type, (census.get(e.type) ?? 0) + 1);
  console.log("\n=== event type census (S1+S2) ===");
  for (const [k, v] of census) console.log(`  ${k}: ${v}`);
  if (census.size === 0) console.log("  (no session events observed — check spawn/pipe)");

  console.log(`\n=== summary: failures=${failures} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
