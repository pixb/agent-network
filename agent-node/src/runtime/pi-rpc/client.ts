// RFC-043 — pi RPC mode JSONL client.
//
// Transport layer for `spawn('pi', ['--mode', 'rpc', ...])`.
//
// pi RPC framing (pi.dev/docs/latest/rpc, verified by M0 probe):
//   - stdin: one JSON command per line (LF); optional `id` for correlation
//   - stdout: one JSON record per line — `response` (echoes `id`) + session
//     events (agent_start / turn_start / message_update / agent_end /
//     agent_settled / ...)
//   - stderr: diagnostics only, never protocol data
//   - close stdin = graceful shutdown
//
// What lives here:
//   - subprocess spawn + stdio pump (newline-delimited JSONL in + out)
//   - id-correlated request/response with per-request timeout
//   - every stdout record re-emitted as `"record"` for runtime.ts to reduce
//   - child environment is passed through verbatim (caller isolates it)
//
// What lives in runtime.ts:
//   - think() state machine: prompt → event stream → agent_settled
//   - session persistence (--session-dir / --session-id) across restarts
//   - timeout / capacity retry / empty-reply rescue (M3)

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";

export interface PiRpcClientOptions {
  /** cwd for the spawned pi process (per-node work dir). */
  cwd?: string;
  /** Complete env for the child. NOT merged with process.env. */
  env?: NodeJS.ProcessEnv;
  /** Binary name / path. Defaults to `"pi"` (found via $PATH). */
  binary?: string;
  /** argv after the binary. Defaults to `["--mode", "rpc", "--no-session"]`. */
  args?: string[];
}

/** Any JSONL record on pi stdout: a response, or a session event. */
export interface PiRpcRecord {
  id?: string;
  type: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: unknown;
  [k: string]: unknown;
}

export interface PiRpcExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  cause?: Error;
}

const DEFAULT_ARGS = ["--mode", "rpc", "--no-session"];

export class PiRpcClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<
    string,
    { resolve: (r: PiRpcRecord) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private rxBuffer = "";
  private closed = false;
  private lastIncomingAt = Date.now();

  /** Timestamp (ms since epoch) of the last JSONL record received from pi.
   *  runtime.ts uses this to distinguish a wedged agent from a long
   *  streaming turn. */
  get lastActivityAt(): number {
    return this.lastIncomingAt;
  }

  get isRunning(): boolean {
    return this.child !== null && !this.closed;
  }

  /** Spawn (or re-spawn after a crash) the pi RPC subprocess. */
  spawn(opts: PiRpcClientOptions = {}): void {
    if (this.child) return;
    const binary = opts.binary ?? "pi";
    const args = opts.args ?? DEFAULT_ARGS;
    const child = spawn(binary, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.closed = false;
    this.rxBuffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      this.lastIncomingAt = Date.now();
      this.rxBuffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = this.rxBuffer.indexOf("\n")) >= 0) {
        const line = this.rxBuffer.slice(0, idx).replace(/\r$/, "");
        this.rxBuffer = this.rxBuffer.slice(idx + 1);
        if (!line.trim()) continue;
        let record: PiRpcRecord;
        try {
          record = JSON.parse(line) as PiRpcRecord;
        } catch (e) {
          this.emit("error", new Error(`pi stdout non-JSON line: ${JSON.stringify(line)}`));
          continue;
        }
        this.dispatch(record);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.emit("stderr", chunk.toString("utf8"));
    });

    child.on("error", (err) => {
      const info: PiRpcExitInfo = { code: null, signal: null, cause: err };
      this.teardown(info);
      this.emit("exit", info);
    });
    child.on("exit", (code, signal) => {
      const info: PiRpcExitInfo = { code, signal };
      this.teardown(info);
      this.emit("exit", info);
    });
  }

  private teardown(info: PiRpcExitInfo): void {
    this.child = null;
    const err = new Error(`pi rpc process exited code=${info.code} signal=${info.signal}`);
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  private dispatch(record: PiRpcRecord): void {
    this.emit("record", record);
    if (record.type === "response") {
      const id = record.id;
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.resolve(record);
      }
    }
  }

  /** Send one command and await its id-correlated response. */
  request(type: string, payload: Record<string, unknown> = {}, timeoutMs = 15000): Promise<PiRpcRecord> {
    const child = this.child;
    if (!child || this.closed) return Promise.reject(new Error("pi rpc client not running"));
    const id = `r${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting pi response for ${type} (${id})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const line = JSON.stringify({ id, type, ...payload }) + "\n";
      child.stdin.write(line);
    });
  }

  /** Graceful shutdown: close stdin; resolve with the exit code. */
  async shutdown(timeoutMs = 10000): Promise<number> {
    const child = this.child;
    if (!child) return 0;
    this.closed = true;
    const exit = new Promise<number>((resolve) => {
      child.once("exit", (code) => resolve(code ?? 0));
    });
    child.stdin.end();
    const timer = setTimeout(() => {
      this.kill();
    }, timeoutMs);
    const code = await exit;
    clearTimeout(timer);
    return code;
  }

  /** Hard kill (crash path / shutdown timeout). */
  kill(): void {
    this.child?.kill("SIGKILL");
  }
}
