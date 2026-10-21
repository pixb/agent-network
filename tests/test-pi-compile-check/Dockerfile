# RFC-043 M2 — compile check for pi-cli enum wiring across the three
# packages (agent-node / agent-network / server). Pure Docker; host is
# never touched. Network strategy copied from test-m0-pi-rpc-probe:
# npm registry via npmmirror (fast in CN).
FROM oven/bun:1.3.14
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com

WORKDIR /check
COPY agent-node /check/agent-node
COPY agent-network /check/agent-network
COPY server /check/server

# --ignore-scripts: node-pty (agent-network devDep) needs a native build
# toolchain; type-checking only needs its type declarations. We never
# execute node-pty in this suite.
RUN bun add -g typescript@5.9.3 \
  && cd /check/agent-node && bun install --ignore-scripts >/dev/null 2>&1 \
  && cd /check/agent-network && bun install --ignore-scripts >/dev/null 2>&1 \
  && cd /check/server && bun install --ignore-scripts >/dev/null 2>&1

COPY tests/test-pi-compile-check/run.sh /check/run.sh
RUN chmod 0755 /check/run.sh
CMD ["bash", "/check/run.sh"]
