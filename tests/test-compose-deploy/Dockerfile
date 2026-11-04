# test-compose-deploy 的容器化执行壳：需要宿主 docker sock 挂载
#
#   docker build -t anet-test-compose:dev -f tests/test-compose-deploy/Dockerfile .
#   docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
#     -v "$PWD":/repo -w /repo anet-test-compose:dev
#
# 无 sock 时 run.sh 会输出显式 SKIP marker 并退出（不假装通过）。
# 注意：build context 是仓库根（compose.yaml 的 hub 镜像要拷 server/）。
FROM node:20.20.0@sha256:65b74d0fb42134c49530a8c34e9f3e4a2fb8e1f99ac4a0eb4e6f314b426183a2
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl python3 openssl ca-certificates docker.io docker-compose-v2 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
CMD ["bash", "tests/test-compose-deploy/run.sh"]
