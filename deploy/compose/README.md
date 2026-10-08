# 生产部署 — Docker Compose 套件（Git 权威）

> **任何一台机器被夷平后，只凭这个仓库 + 加密备份，就要能把 Hub 与 Dashboard 重建出来。**
> 本目录是 `docs-site/docs/deploy/clean-server.md` §「在容器里跑」所指向的受维护套件。
> 数据不在此列：SQLite 内容与 vault 密钥从备份恢复，见下文第 3、6 问。

服务拓扑：

```text
宿主机
  ├─ docker compose
  │    ├─ hub        :9200 ──► bun + commhub-server（源码构建，server/）
  │    └─ dashboard  :3000 ──► node + @sleep2agi/agent-network-dashboard（npm 钉版本）
  ├─ ./data/         ← 全部状态：hub.env（密钥）+ commhub.db + uploads/
  └─ agent 节点、Caddy/frp 隧道等：仍在宿主机上（边界见文末）
```

## 0. 快速开始（新机器）

```bash
# 前置：docker + compose v2（`docker compose version` 能跑）；首次 build 需联网
git clone <本仓库> && cd agent-network

mkdir -p deploy/compose/data
cp deploy/compose/hub.env.example deploy/compose/data/hub.env
$EDITOR deploy/compose/data/hub.env        # 填入 ANET_HUB_SECRET_VAULT_KEY（从加密备份取原值）
chmod 600 deploy/compose/data/hub.env
# 可选：cp deploy/compose/.env.example deploy/compose/.env 改端口

docker compose -f deploy/compose/compose.yaml up -d --build
curl -s localhost:9200/health              # ok:true + version = server/package.json 的版本
```

**整机迁移** = 把整个项目目录（含 `data/`）拷到新机器 → `up -d --build`。
新机器首次会现场构建镜像（源码在仓里，需联网拉基础镜像/装依赖）。

## 1. 常驻服务如何启动、脚本在哪里

- **权威文件就是本目录**：`compose.yaml`（进程定义）、`Dockerfile.hub` / `Dockerfile.dashboard`
  （构建）、`entrypoint.sh`（vault fail-closed 预检）。启动命令：
  `docker compose -f deploy/compose/compose.yaml up -d`
- `restart: unless-stopped` 负责崩溃自愈与开机跟随 docker daemon 自启（需 docker 服务 enabled，
  Ubuntu 桌面版默认如此；服务器确认 `systemctl is-enabled docker`）。
- 就绪判据是 hub healthcheck（`/health`），不是「容器在跑」：dashboard 被
  `depends_on: service_healthy` 挡在 hub 健康之后。
- 对应 pm2 时代的 `hub-daemon.sh` / `dash-start.sh` 的预检，本套件由两处承接：
  vault 密钥 → `entrypoint.sh`（缺了拒启）；端口冲突/版本钉 → compose 本身
  （一个 compose 项目不会起两个 hub；版本钉在 Dockerfile 与 `server/package.json`）。

## 2. 端口、反向代理、隧道写在哪里

- **端口映射只在 `compose.yaml`**（默认 `9200:9200`、`3000:3000`，可用 `.env` 的
  `HUB_PORT` / `DASH_PORT` 覆盖）。宿主机对外绑定即 docker 的发布地址。
- TLS 终结、域名、frp 隧道**不在本套件**（与 pm2 时代相同的边界：在 Caddy/frpc 层）。
  改了入口先改反代，再动这里。Dashboard 若在纯 HTTP 下访问需 `COOKIE_INSECURE=1`
  （`compose.yaml` 已设；上 TLS 后应去掉）。

## 3. 环境变量和密钥从何处安全获取

| 内容 | 位置 | 获取方式 |
|---|---|---|
| vault 主密钥 `ANET_HUB_SECRET_VAULT_KEY` | `data/hub.env`（0600，不进 git） | **只从加密备份恢复原值**。重新生成的新值解不开既有密文 —— 那不是恢复 |
| 可选调参（retention/SSE 等） | 同上，`hub.env.example` 列了全部变量名 | 变量名见 example；值不进仓库 |
| 端口/数据目录 | `.env`（可选，不进 git） | `.env.example` |

`data/` 整目录被根 `.gitignore` 忽略。**备份出的 `data/` 含主密钥与全量数据，按密件对待。**

## 4. 如何换版本并验证真实生效

Hub（源码版本）：

```bash
git pull                              # server/package.json 的 version 即新版本号
docker compose -f deploy/compose/compose.yaml up -d --build hub
curl -s localhost:9200/health         # version 必须 == server/package.json 的 version
```

Dashboard（npm 钉版本）：

```bash
# 改 deploy/compose/Dockerfile.dashboard 的 ARG DASH_VERSION=<新版本>
docker compose -f deploy/compose/compose.yaml up -d --build dashboard
# 验证看真跑的产物：进入容器核对安装目录版本，不只看自报 footer
docker compose -f deploy/compose/compose.yaml exec dashboard \
  node -p "require('./node_modules/@sleep2agi/agent-network-dashboard/package.json').version"
```

版本号自报可以骗人，**构建产物核对不骗人**（与 `deploy/dashboard/README.md` §四同一判据）。

## 5. 如何回滚

- **代码回滚**：`git checkout <上个好 commit>` → `up -d --build`。
  Docker 会保留旧镜像层，回滚即重新构建；不需要时旧镜像也可手动保留
  （`docker images | grep anet-`）。
- **数据回滚**：见第 6 问的备份恢复。**先停容器再恢复**：
  `docker compose stop hub` → 恢复 `data/commhub.db` → `up -d`。
- 两层独立：镜像回滚不动数据，数据回滚不动镜像；搞混了会「进程是新的、数据是旧的」
  或反之 —— 回滚后按第 4 问重新验证一次。

## 6. 哪些状态只能从数据备份恢复

**软件**（git 可复现）：compose 文件、两个 Dockerfile、server 源码、DASH_VERSION 坐标。

**数据**（git 没有，只有备份能救），全部在 `data/` 一个目录：

| 文件 | 内容 | 备份 |
|---|---|---|
| `data/hub.env` | vault 主密钥 + 调参 | 加密备份；`0600`；只有原值有效 |
| `data/commhub.db` | 用户/网络/任务/会话/令牌（SQLite WAL） | 热备份用 `VACUUM INTO`，停机后可直接拷文件 |
| `data/uploads/` | 上传的文件与 `.index/` | 直接拷 |

热备份（不停机，推荐例行）：

```bash
docker compose -f deploy/compose/compose.yaml exec hub \
  bun -e "new (require('bun:sqlite').Database)('/data/commhub.db',{readonly:true}).exec(\"VACUUM INTO '/data/backups/commhub-$(date +%Y%m%d-%H%M%S).db'\")"
```

> 🔴 **不要在容器运行时直接 `cp commhub.db`** —— WAL 在写，普通文件拷贝不一致
> （`deploy/hub/README.md` 同规则）。冷备份（`docker compose stop` 之后）直接拷整个
> `data/` 即可。

恢复 = 停 hub → 用备份覆盖 `data/commhub.db` → `up -d` → 按第 4 问验证
（`sessions_count` 行数对得上备份、登录后任务/令牌都在）。

## 从 pm2 旧机迁移到本套件

前提：本套件已在测试套件里全链路验证（`tests/test-compose-deploy/`）。步骤：

```bash
# 1. 热备份（pm2 hub 还在跑时，先拿一致快照）
mkdir -p deploy/compose/data/backups
bun -e "new (require('bun:sqlite').Database)('$HOME/.commhub/commhub.db',{readonly:true}).exec(\"VACUUM INTO '$PWD/deploy/compose/data/backups/pre-compose.db'\")"

# 2. 停旧进程，释放端口（pm2 定义保留 = 回滚路径）
pm2 stop commhub-hub anet-dashboard

# 3. 汇集数据（密钥原样搬、快照当主库、上传目录整体搬）
cp -p "$HOME/.commhub/hub.env" deploy/compose/data/hub.env
cp deploy/compose/data/backups/pre-compose.db deploy/compose/data/commhub.db
cp -a "$HOME/.anet/server/uploads" deploy/compose/data/uploads 2>/dev/null || true
chmod 600 deploy/compose/data/hub.env

# 4. 起 + 验证（见下）
docker compose -f deploy/compose/compose.yaml up -d --build
```

验证清单（全过才算迁移完成）：

1. `/health`：`ok:true`、`version` 对、`sessions_count` 与备份一致；
2. 老 `atok_`/`utok_` 调 REST/MCP 照常 200（令牌在库里，跟着数据走）；
3. Dashboard `/login` 200 且能登录进看板；
4. **节点心跳恢复**：`get_all_status` 里在线数恢复（节点连的还是 `host:9200`，
   SSE 断线自动重连）；
5. 历史上传文件能下载（验 `COMMHUB_UPLOADS_DIR` 换根没破坏索引）。

回滚到 pm2：`pm2 stop` compose 侧没必要 —— `docker compose down` 后
`pm2 start commhub-hub anet-dashboard`（原 `~/.local/bin/*` 与 runtime 目录一律没动）。

```bash
docker compose -f deploy/compose/compose.yaml down      # 停并删容器，data/ 不动
```

## 明确不覆盖（诚实边界）

- **agent 节点生命周期**：节点（tmux/TUI/各厂商运行时）留在宿主机，照旧连
  `host:9200`。反过来，**hub 容器内没有宿主机的 `anet`/tmux**，`create_node`
  主机侧 fan-out 在容器里不可用 —— 节点请在宿主机上 `anet node create/start`。
- **Caddy / frp 隧道 / weixin**：不在本套件，边界与 pm2 时代相同。
- **镜像仓库发布**：不发 GHCR，新机器现场 build（这是「拷项目即部署」的代价，
  换来的是不依赖任何 registry 的可复现性）。
- **备份的异地存放**：本套件只给出备份命令，备份件存哪、保留多久由运维决定
  （`data/` 含主密钥，别进任何公开仓库/明文网盘）。

## 验证与演练

- 套件级 E2E（含迁移演练）：`tests/test-compose-deploy/`，报告见
  `docs/tests/report-test-compose-deploy.txt`。本地跑：`bash tests/test-compose-deploy/run.sh`
  （需要 docker；不动生产端口与生产数据）。
