// M0 helper — download node official tarball from npmmirror (CN mirror), SHA256-verified.
// Arch is auto-detected (bun process.arch): arm64 -> linux-arm64, else linux-x64.
// Usage: bun fetch-node.ts <NODE_VERSION>
const [version] = process.argv.slice(2);
if (!version) throw new Error("usage: bun fetch-node.ts <version>");
const arch = process.arch === "arm64" ? "arm64" : "x64";
const name = `node-v${version}-linux-${arch}.tar.gz`;
const base = `https://npmmirror.com/mirrors/node/v${version}`;

console.log(`arch=${arch}`);
const sumsRes = await fetch(`${base}/SHASUMS256.txt`);
if (!sumsRes.ok) throw new Error(`SHASUMS fetch failed: ${sumsRes.status}`);
const sums = await sumsRes.text();
const line = sums.split("\n").find((l) => l.trimEnd().endsWith(`  ${name}`) || l.trimEnd().endsWith(` ${name}`));
if (!line) throw new Error(`SHA256 entry not found for ${name}`);
const expected = line.split(/\s+/)[0];
console.log(`expected sha256 for ${name}: ${expected}`);

const url = `${base}/${name}`;
console.log(`fetching ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
const buf = new Uint8Array(await res.arrayBuffer());
const hash = new Bun.CryptoHasher("sha256").update(buf).digest("hex");
console.log(`sha256 ${hash}`);
if (hash !== expected) throw new Error(`SHA256 mismatch for ${name}`);
await Bun.write("/tmp/node.tgz", buf);
console.log(`saved /tmp/node.tgz (${buf.length} bytes)`);
