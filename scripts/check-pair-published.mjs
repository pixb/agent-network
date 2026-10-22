#!/usr/bin/env node
// RFC-029 release pairing, published side.
//
// `opencode-agent-node-pair.test.ts` keeps the two constants in lockstep in the
// tree, but a release can still hand out a HALF pair: agent-node@X is on npm and
// agent-network@Y (the CLI that declares PAIRED_AGENT_NODE_VERSION=X) is only
// staged, so `npm i -g agent-node@X` lands next to a CLI that refuses it.
// 2026-10-19: node .150 went out, CLI .186 sat in npm's staging queue, and the
// only installable pair was the older .184/.148.
//
// This script reads the pair from the tree and asks the registry. Exit 1 when
// either half is missing, so the release job fails loudly instead of shipping
// something users cannot pair.
//
//   node scripts/check-pair-published.mjs            # uses the tree + npm
//   node scripts/check-pair-published.mjs --json     # machine readable
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function readPair(text) {
  const net = /PAIRED_AGENT_NETWORK_VERSION\s*=\s*"([^"]+)"/.exec(text)?.[1];
  const node = /PAIRED_AGENT_NODE_VERSION\s*=\s*"([^"]+)"/.exec(text)?.[1];
  return net && node ? { network: net, node } : null;
}

function publishedVersion(pkg) {
  try {
    return execFileSync('npm', ['view', `${pkg}`, 'version'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

export function checkPair({ network, node }, lookup) {
  const networkVersion = lookup('@sleep2agi/agent-network@' + network);
  const nodeVersion = lookup('@sleep2agi/agent-node@' + node);
  const problems = [];
  if (networkVersion !== network) problems.push(`agent-network@${network} is not published (got ${networkVersion ?? 'missing'})`);
  if (nodeVersion !== node) problems.push(`agent-node@${node} is not published (got ${nodeVersion ?? 'missing'})`);
  return { ok: problems.length === 0, pair: { network, node }, problems };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const pair = readPair(readFileSync(join(root, 'agent-network/src/opencode-agent-node-pair.ts'), 'utf8'));
  if (!pair) { console.error('check-pair-published: cannot read the pair constants'); process.exit(2); }
  const result = checkPair(pair, (spec) => publishedVersion(spec));
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) console.log(`pair ok: agent-network@${pair.network} + agent-node@${pair.node}`);
  else {
    console.error(`🔴 half pair: agent-network@${pair.network} + agent-node@${pair.node}`);
    for (const p of result.problems) console.error(`  - ${p}`);
    console.error('  do not announce the surviving half; publish the missing one (or pin users to the previous full pair)');
  }
  process.exit(result.ok ? 0 : 1);
}
