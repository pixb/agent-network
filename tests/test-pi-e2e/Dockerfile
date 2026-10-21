# RFC-043 M4/L2 — pi-cli full-chain E2E: CommHub + agent-node + pi RPC.
# Base: anet-m0-pi-rpc-probe (node + bun + pi 1.3.0 + stub + pi-rpc src).
# Adds the three package sources + deps so hub and agent-node can run.
FROM anet-m0-pi-rpc-probe
USER root
COPY agent-node /check/agent-node
COPY agent-network /check/agent-network
COPY server /check/server
# --ignore-scripts: node-pty (agent-network devDep) needs a toolchain; we
# never execute PTY code in this suite.
# chmod: workspace-created sources may be 600 (host umask); relax for USER bun.
RUN chmod -R a+rX /check \
  && cd /check/agent-node && bun install --ignore-scripts >/dev/null 2>&1 \
  && cd /check/agent-network && bun install --ignore-scripts >/dev/null 2>&1 \
  && cd /check/server && bun install --ignore-scripts >/dev/null 2>&1
WORKDIR /e2e
COPY tests/test-pi-e2e/ /e2e/
RUN chmod -R a+rX /e2e && chmod 0755 /e2e/run.sh && chown -R bun:bun /e2e
USER bun
CMD ["bash", "/e2e/run.sh"]
