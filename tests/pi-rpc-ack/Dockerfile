FROM oven/bun:1.3.14
WORKDIR /repo

RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 curl make g++ >/dev/null && rm -rf /var/lib/apt/lists/*

# 依赖层与源码层分开：改源码不重新解析依赖树。
COPY server/package.json server/bun.lock ./server/
RUN cd server && bun install --frozen-lockfile
COPY agent-node/package.json agent-node/package-lock.json ./agent-node/
RUN cd agent-node && bun install --frozen-lockfile --no-optional

COPY server ./server
COPY agent-node ./agent-node
COPY tests/pi-rpc-ack/run.sh ./run.sh
# 基线源码（修复前的 agent-node），由 tests/pi-rpc-ack/make-baseline.sh 从 git 历史打出。
# 依赖不在 tar 里：把新树的 node_modules 软链过来（同一份 lock，版本一致）。
COPY tests/pi-rpc-ack/baseline-agent-node.tar /baseline/baseline-agent-node.tar
RUN mkdir -p /baseline && tar -xf /baseline/baseline-agent-node.tar -C /baseline \
  && ln -s /repo/agent-node/node_modules /baseline/agent-node/node_modules

ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
RUN chmod 0755 ./run.sh
CMD ["./run.sh"]
