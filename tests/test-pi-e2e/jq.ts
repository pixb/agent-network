// RFC-043 M4/L2 — minimal jq replacement for the E2E runner.
// Reads JSON from stdin, prints the value at a dot path (array index ok):
//   echo '{"a":[{"b":1}]}' | bun jq.ts "a[0].b"   -> 1
// Objects are printed as JSON; missing path prints empty line.
let s = "";
for await (const c of Bun.stdin.stream()) s += new TextDecoder().decode(c);
const path = process.argv[2] ?? "";
let v: unknown;
try { v = JSON.parse(s); } catch { console.log(""); process.exit(0); }
for (const raw of path.split(".")) {
  if (v == null) { console.log(""); process.exit(0); }
  const m = raw.match(/^(.+)\[(\d+)\]$/);
  if (m) v = (v as Record<string, unknown>)[m[1]]?.[Number(m[2])];
  else v = (v as Record<string, unknown>)[raw];
}
console.log(typeof v === "object" ? JSON.stringify(v) : String(v ?? ""));
