# M0 探针 — pi RPC mode 协议走查（全离线，stub provider）
#
# 网络策略（2026-10-22）：容器内一律走国内镜像，不依赖 apt：
#   - node 官方二进制（含 npm）：npmmirror.com/mirrors/node（bun fetch 下载，SHA256 校验）
#   - npm registry：registry.npmmirror.com
#   - stub 用 bun 实现（免 python3，Dockerfile 无 apt 步骤）
# pi 1.3.0 要求 node >= 22.19.0 → node v22.19.0（pin + SHA256 校验）。
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
USER root
ENV npm_config_audit=false npm_config_fund=false
ARG NODE_VERSION=22.19.0
COPY tests/test-m0-pi-rpc-probe/fetch-node.ts /tmp/fetch-node.ts
RUN bun /tmp/fetch-node.ts "${NODE_VERSION}" \
    && tar -xzf /tmp/node.tgz -C /usr/local --strip-components=1 \
    && node --version && npm --version \
    && rm -f /tmp/node.tgz /tmp/fetch-node.ts
ARG PI_VERSION=1.3.0
RUN npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" \
      --registry=https://registry.npmmirror.com --no-audit --no-fund \
    && test "$(pi --version)" = "${PI_VERSION}"
RUN install -d -m 0755 /run/user && install -d -m 0700 -o bun -g bun /run/user/1000
WORKDIR /fixture
COPY agent-node/src/runtime/pi-rpc/ /fixture/pi-rpc/
COPY tests/test-m0-pi-rpc-probe/probe.ts /fixture/probe.ts
COPY tests/test-m0-pi-rpc-probe/pi-rpc-unit.test.ts /fixture/pi-rpc-unit.test.ts
COPY tests/test-m0-pi-rpc-probe/pi-rpc-m3.test.ts /fixture/pi-rpc-m3.test.ts
COPY tests/test-m0-pi-rpc-probe/pi-ollama-smoke.test.ts /fixture/pi-ollama-smoke.test.ts
COPY tests/test-m0-pi-rpc-probe/stub-server.ts /fixture/stub-server.ts
COPY tests/test-m0-pi-rpc-probe/run.sh /fixture/run.sh
RUN chmod -R a+rX /fixture && chmod 0755 /fixture/run.sh && chown -R bun:bun /fixture
ENV TERM=xterm-256color
USER bun
CMD ["bash", "/fixture/run.sh"]
