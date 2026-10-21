// M0 stub — OpenAI-compatible chat-completions server (bun), mirroring
// tests/test543-opencode-v2-copresence/stub-model.py behavior:
//   "Reply with exactly X" -> X ; "STUB_FAIL" -> HTTP 400 ; streaming + non-streaming.
// Loopback only. Every request is logged (path, model, tools, last user text).
const PORT = Number(process.env.STUB_PORT ?? "32123");
const LOG = process.env.STUB_LOG ?? "/tmp/stub.log";

function lastUser(body: any): string {
  const msgs = body?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === "user") {
      const c = m.content;
      if (Array.isArray(c)) return c.map((p: any) => p?.text ?? "").join(" ");
      return typeof c === "string" ? c : "";
    }
  }
  return "";
}

function log(obj: unknown) {
  try {
    Bun.write(LOG, JSON.stringify(obj) + "\n", { append: true });
  } catch {
    /* ignore */
  }
}

function replyTextFor(u: string): string {
  // 空回复指令（RFC-043 D7 rescue 测试）："Reply with exactly" 无后续词 → 空文本
  if (/Reply with exactly\s*$/.test(u)) return "";
  const m = u.match(/Reply with exactly (\S+)/);
  return m ? m[1] : "STUB_OK";
}

async function handleChat(req: Request): Promise<Response> {
  const body = await req.json();
  const u = lastUser(body);
  log({
    path: new URL(req.url).pathname,
    model: body.model,
    tools: (body.tools ?? []).map((t: any) => t?.function?.name),
    user: u.slice(0, 200),
  });
  if (u.includes("STUB_FAIL")) {
    return Response.json(
      { error: { message: "stub provider refused: STUB_FAIL requested", type: "invalid_request_error" } },
      { status: 400 },
    );
  }
  const text = replyTextFor(u);
  if (!body.stream) {
    return Response.json({
      id: "c1",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "stub-model",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const base = { id: "c1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "stub-model" };
      const ev = (o: unknown) => controller.enqueue(enc.encode("data: " + JSON.stringify(o) + "\n\n"));
      ev({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
      ev({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      ev({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      ev({});
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname.includes("chat/completions")) return handleChat(req);
    if (req.method === "GET" && url.pathname.includes("models")) {
      return Response.json({ object: "list", data: [{ id: "stub-model", object: "model" }] });
    }
    return Response.json({ error: "nf" }, { status: 404 });
  },
});
console.log(`stub listening on 127.0.0.1:${PORT}`);
