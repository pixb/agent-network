// RFC-043 D5 — pi preflight: `pi auth check` before spawn.
//
// M0 probe S3 proved that a nonexistent provider makes `pi --mode rpc`
// HANG the prompt (no response, no events) instead of failing fast.
// Therefore the adapter MUST gate every runtime open with a preflight so
// a bad provider/model surfaces as a readable error before any turn can
// wedge. The probe also confirmed `pi auth check --provider X --json`
// returns quickly and classifies ready/not_ready/invalid.
//
// pi docs (cli): `pi auth check` prints `ready`, `not_ready`, or
// `invalid` and exits 0, 1, or 2 respectively; `--json` adds a
// structured payload; `--no-refresh` skips model-catalog refresh.

import { spawn } from "child_process";

export type PiAuthState = "ready" | "not_ready" | "invalid" | "unknown";

export interface PiAuthCheckOptions {
  binary?: string;
  /** Either provider or model must be set (pi requires one). */
  provider?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

export interface PiAuthCheckResult {
  state: PiAuthState;
  exitCode: number | null;
  stdout: string;
}

export async function checkPiAuth(opts: PiAuthCheckOptions): Promise<PiAuthCheckResult> {
  const binary = opts.binary ?? "pi";
  if (!opts.provider && !opts.model) {
    throw new Error("checkPiAuth requires provider or model");
  }
  const args = ["auth", "check"];
  if (opts.model) args.push("--model", opts.model);
  else args.push("--provider", opts.provider!);
  args.push("--json", "--no-refresh");

  const { exitCode, stdout, stderr } = await runCaptured(binary, args, opts);
  const state = parseAuthState(stdout, exitCode);
  return { state, exitCode, stdout };
}

/** Parse the auth-check result: structured JSON first, exit code fallback. */
export function parseAuthState(stdout: string, exitCode: number | null): PiAuthState {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>;
    for (const key of ["state", "status"] as const) {
      const v = j[key];
      if (v === "ready" || v === "not_ready" || v === "invalid") return v;
    }
  } catch {
    // not JSON — fall through to exit code
  }
  if (exitCode === 0) return "ready";
  if (exitCode === 1) return "not_ready";
  if (exitCode === 2) return "invalid";
  return "unknown";
}

/** Readable error for a non-ready preflight result. */
export function piAuthFailureMessage(result: PiAuthCheckResult, provider?: string, model?: string): string {
  const target = model ? `model ${JSON.stringify(model)}` : `provider ${JSON.stringify(provider)}`;
  switch (result.state) {
    case "not_ready":
      return `pi auth: ${target} is not ready — check credentials/models.json (pi auth check)`;
    case "invalid":
      return `pi auth: ${target} is invalid — verify the provider/model id and credentials`;
    default:
      return `pi auth: cannot verify ${target} (state=${result.state}, exit=${result.exitCode})`;
  }
}

interface Captured {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runCaptured(
  binary: string,
  args: string[],
  opts: PiAuthCheckOptions,
): Promise<Captured> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi auth check timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}
