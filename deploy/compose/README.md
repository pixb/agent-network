# CommHub 生产栈（hub + dashboard）—— 可重建定义

## 这份文件为什么存在（2026-11-04 盘点）

现网两个容器都在跑，但它们的构建定义**在磁盘和 git 里都没有副本**：

```
docker inspect anet-hub-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
  → /vol1/1000/docker/nec8-docker/agent-network/deploy/compose/compose.yaml   # 该文件不存在
docker history anet-hub:compose | grep entrypoint
  → COPY deploy/compose/entrypoint.sh ...                                      # 该文件也不存在
```

也就是说：容器活着，定义没了。AGENTS.md 的验收标准是「任一服务器被清空后，只靠仓库能否
恢复出当前运行的软件」，当时的答案是否定的。本目录把这些补成权威副本：`compose.yaml`、
`Dockerfile.hub`、`entrypoint.sh`（从运行中镜像逐字取出）、`.env.example`、
`hub.env.example`、`dashboard.env.example`。

**本轮不改任何运行中的东西**：只补仓库内容。

## 现网实测拓扑（`docker inspect` 的量，不是文档里的理想形状）

| 项 | hub | dashboard |
|---|---|---|
| 容器 | `anet-hub-1` | `anet-dashboard-1` |
| 镜像 | `anet-hub:compose`（`oven/bun:1.4.0` + `COPY server/`） | `anet-dashboard:compose`（**npm 发布包 `0.6.3-preview.56`** 烘进镜像） |
| 镜像建于 | 2026-10-22 | 2026-10-14 |
| 宿主端口 | `9200 → 9200` | **`3200 → 3000`** |
| 网络 | `anet_default`（bridge） | `anet_default` |
| 挂载 | `./data → /data`（生产 SQLite + uploads + backups） | 无（无状态） |
| 密钥来源 | `env_file: ./data/hub.env`（实测 0600，gitignore 覆盖） | `env_file`（`COMMHUB_URL`、`COOKIE_INSECURE`） |
| 健康判定 | `bun -e fetch('/health')`（容器里无 curl） | 镜像无 healthcheck（现网实测） |
| 依赖 | — | `depends_on: hub: service_healthy` |
| 运行身份 | `USER bun` | `USER node` |

两条与旧文档不一致、必须以实测为准的事：

1. **dashboard 的入口是宿主 `:3200`，不是 `:3000`/`:3001`。** `deploy/dashboard/README.md`
   写的 Caddy `:3000` → pm2 → `:3001` 是 **pm2 时代**的形状；现网由 compose 接管，
   端口是 compose 的 `DASH_PORT=3200`，容器内 `HOST=0.0.0.0`、`PORT=3000`。
   实测 `http://192.168.1.3:3000/login` = **404**（宿主 `:3000` 已被 **gitea** 占用，
   它的登录路径是 `/user/login`），`:3200/login` = 200。
2. **`HOST=0.0.0.0` 在容器里是 compose 桥接网络的正常形状**，外部可达性由 `ports:` 决定。
   「只监听 127.0.0.1」那条契约属于 pm2/host-network 路径（dashboard 仓库
   `deploy/compose/README.md` 里写清了两种路径）。**不要把两条契约混成一条。**

## 换版本 / 验证真实生效 / 回滚

分支模型（2026-11-04 定义，见仓库根 `AGENTS.md`）：`pixb` 是生产分支，只在本地部署，
**不发 npm**；`main` 只作为上游同步分支，上游更新用 merge 进 pixb。于是
**部署身份 = 源码提交**，不是 npm 版本号。

```bash
cd deploy/compose
export ANET_SOURCE_REV=$(git -C ../.. rev-parse HEAD)    # 本次部署的 pixb 提交
docker compose build                                      # hub 镜像 label 记下这个提交
docker compose up -d
```

验证生效只问「常驻进程实际加载的是哪份代码」：

```bash
docker inspect anet-hub:compose --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
docker inspect anet-hub-1     --format '{{.Image}}'   # 容器实际用的镜像 id
docker compose ps             # hub 应为 healthy
curl -fsS http://127.0.0.1:9200/health >/dev/null && echo hub-ready
# dashboard 同理：镜像由 agent-network-dashboard 仓库构建，
# 它的 label 里带 dashboard 侧的提交；只量「网页能开」不算数。
```

回滚 = 检出旧提交重建。源码在 git 里，旧提交永远构建得到；不依赖 registry 上还剩哪个版本。

dashboard 镜像在本目录之外构建：

```bash
cd ../agent-network-dashboard/deploy/compose
export ANET_DASHBOARD_SOURCE_REV=$(git -C ../.. rev-parse HEAD)
docker compose build           # 产出 anet-dashboard:<tag>，label 带提交
# 回到本目录：ANET_DASHBOARD_IMAGE_TAG=<tag> docker compose up -d
```

## 数据与密钥（哪些不能从 git 恢复）

- **hub 的 SQLite 在 `./data/`**（bind mount 到 `/data`）：`commhub.db` + `-wal`/`-shm` +
  `uploads/` + `backups/` + `hub.env`。`data/` 整条被根 `.gitignore` 排除（本轮补的），
  所以 clone 仓库 **不会**带来任何生产数据。
- **`data/hub.env` 里是 vault 主密钥**，权限 0600。恢复必须用**原值**（加密备份 / owner
  安全交付）：新生成一个 64 hex 解不开既有密文，那不是恢复，是把数据变成砖。
  entrypoint 对此 fail-closed（不设就拒绝启动）。
- 登录账号本身在 hub 数据库里（dashboard 网页登录走 `/api/auth/v3` → hub 用户校验），
  所以「谁能登录」也只能从数据备份恢复。

## 启动（空机重建）

```bash
git clone <repo> && cd agent-network && git checkout pixb
cd deploy/compose
cp .env.example .env                     # 端口等
cp dashboard.env.example dashboard.env   # 填 COMMHUB_URL 等
mkdir -p data && cp hub.env.example data/hub.env && chmod 600 data/hub.env
# 填入 ANET_HUB_SECRET_VAULT_KEY 的**原值**（来自加密备份）；没有原值就先别 up
docker compose build
docker compose up -d
docker compose ps                        # hub healthy 后 dashboard 才会起
```

全新空栈（无数据备份）时，hub 会建空库：需要重新注册用户、网络、节点 token —— 这条路径
只恢复软件，不恢复数据。

### 第一条启动就会踩的坑：数据目录必须能被容器 uid 写

镜像是 `USER bun`（uid 1000）。`docker compose up` 时如果 `./data` 不存在，docker 会
自动建一个 **root owned** 的目录，hub 会在建库时直接抛异常：

```
at new Database (bun:sqlite:262:28)
  at createAdapter (/app/server/src/db-adapter.ts:549:17)
```

日志里看不到「权限」两个字，看起来像数据库坏了。空机重建时先做：

```bash
mkdir -p data && chmod 777 data     # 或 chown 到容器 uid 1000
```

演练脚本里就是这么写的（`tests/compose-rebuild/rebuild-drill.sh` 头部记录了这条实测发现）。

### 演练

```bash
bash tests/compose-rebuild/rebuild-drill.sh   # 构建 + fail-closed + 真起 /health，全在隔离资源上
bash tests/compose-rebuild/compose-contract.sh
```

演练脚本用 `anet-hub:drill` 标签与 `19323` 端口，**不覆盖现网镜像、不抢 9200、不读 `data/`**。

## 契约测试

`tests/compose-rebuild/compose-contract.sh` 钉住：镜像层与 lockfile 参与安装、
`SOURCE_REV` label、探针用 bun 发（容器无 curl）、`data/` bind mount 存在、
env 模板不含密钥值、`.env.example`/`hub.env.example` 名字齐全、
`docker compose config` 能解析本文件（并用故意写重键的样张自检这条检查有牙）、
README 记录实测端口 `3200` 与数据目录权限要求。
