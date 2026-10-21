// RFC-043 M4/L2 — minimal curl replacement for the E2E runner.
// Usage: HUB_TOKEN=<token> bun http-cli.ts <METHOD> <URL> [JSON_BODY]
// Output: "<statusCode>\t<body>" on one line (body newlines intact).
const method = (process.argv[2] ?? "GET").toUpperCase();
const url = process.argv[3] ?? "";
const body = process.argv[4];
const token = process.env.HUB_TOKEN;
const headers: Record<string, string> = {
  accept: "application/json, text/event-stream",
};
if (body) headers["content-type"] = "application/json";
if (token) headers.authorization = `Bearer ${token}`;
const r = await fetch(url, { method, headers, body: body || undefined });
const text = await r.text();
console.log(r.status + "\t" + text);
