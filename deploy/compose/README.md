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

---

## 8. 2026-11-04 恢复记录与现网实测（量出来的，不是转述）

### 8.1 这套定义曾经从分支上消失

本套件的权威副本来自提交 `3bf3150c6`（2026-10-08，"maintained compose suite +
E2E tests; switch local pm2 to compose"）。**该提交不是 pixb 的祖先**
（`git merge-base --is-ancestor 3bf3150c6 HEAD` → 否），2026-10-29 那次 rebase 把它掉出去了
（AGENTS.md 记录的那次：只搬走 tip 修复，丢掉核心提交）。后果是运行中的容器指向的定义
从分支上消失：

```
docker inspect anet-hub-1 → project.config_files = deploy/compose/compose.yaml   # 文件不在
docker history anet-hub:compose → COPY deploy/compose/entrypoint.sh              # 文件不在
```

恢复方式：`git checkout 3bf3150c6 -- deploy/compose tests/test-compose-deploy docs/tests/report-compose-migrate.txt`。
**证据**：现网镜像里的 `/usr/local/bin/anet-hub-entrypoint` 与恢复出来的 `entrypoint.sh`
逐字一致（`tests/compose-rebuild/compose-contract.sh` 里做 diff 校验），说明现网容器
确实是这套定义的产物，不是别的什么定义。

教训写进规则：**分支被重写时，未纳入分支的运维定义会静默消失，而容器照跑不误**。
所以本轮起，compose 定义的完整性由契约测试钉住，不再只靠「目录里应该有文件」。

### 8.2 现网实测（2026-11-04）

| 项 | 实测值 |
|---|---|
| dashboard 容器 | `anet-dashboard-1`，创建 **2026-10-14**，镜像 `sha256:e6b84113b0c2` |
| dashboard 宿主端口 | **3200**（来自 `deploy/compose/.env` 的 `DASH_PORT=3200`；compose.yaml 默认是 3000） |
| dashboard 自报版本 | `0.6.3-preview.56` = `Dockerfile.dashboard` 里钉的 `ARG DASH_VERSION` |
| hub 容器 | `anet-hub-1`，创建 **2026-10-22**，自报 `0.9.0-preview.265` |
| 部署粒度 | 同一份 compose.yaml，两个 service **分别 up**（hub 与 dashboard 创建时间差 8 天） |

> `:3000/login` 返回 404 是**对的**：宿主 `:3000` 是 gitea（它的登录路径是 `/user/login`）。
> dashboard 的入口是 `:3200`。历史文档里写的 Caddy `:3000` → pm2 → `:3001` 是 pm2 时代形状。

### 8.3 演练新增的两条要求（第一遍跑挂才发现）

1. **`./data` 必须能被容器 uid(1000) 写。** 目录不存在时 docker 自动建的是 root owned，
   hub 在 `bun:sqlite` 建库时抛异常，日志只有 `at new Database (bun:sqlite:262:28)`，
   看不出是权限问题。空机重建先 `mkdir -p data && chmod 777 data`。
2. **构建期慢与失败的根因是 electron 的 postinstall，不是 npm 源**（这条先前的归因不准确，已量过）。
   dashboard 侧「一次容器内 `npm ci` 跑 40 分钟未完成」，实测到的是
   `npm error path /src/node_modules/electron` + `RequestError: socket hang up`：
   `npm ci` 默认装 devDependencies，而 `electron`（devDep）的 install.js 要下载二进制包。
   dashboard 仓库加 `ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1` 后，同一条 `npm ci` = 43 秒（冷缓存、官方源）。
   registry 旋钮保留，边界写明：`npm ci` 认 lockfile 里的 resolved URL，换源只部分生效。
   细节与体积数字见 dashboard 仓库 `deploy/compose/README.md`。

### 8.4 旋钮：名称 / 默认 / 现网实测值 / 来源

compose 自动读同目录 `.env`（shell 环境优先）。现网这台机器的 `.env` 内容就是下表第三列，
它是**唯一的运行期事实源**——新机器要复现现网形状，照抄这张表即可。

| 变量 | 定义里的默认 | 现网 `.env` 实测 | 作用 |
|---|---|---|---|
| `COMPOSE_PROJECT_NAME` | `anet` | 未设（= 默认 anet） | 容器/网络名前缀：`anet-hub-1`、`anet-dashboard-1` |
| `HUB_PORT` | `9200` | `9200` | 宿主侧 hub 端口 → 容器 9200 |
| `DASH_PORT` | `3000` | **`3200`** | 宿主侧 dashboard 端口 → 容器 3000 |
| `COMPOSE_DATA_DIR` | `./data` | 未设（= 默认 ./data） | bind mount 宿主侧目录 → 容器 `/data`（hub.env + commhub.db + uploads） |
| `ANET_SOURCE_REV` | 无默认（label 记 `unknown`） | 未设 | hub 镜像 label 里的源码提交（部署身份） |

> `DASH_PORT` 的默认值（3000）与现网值（3200）**不一致是有意的**：3000 是 compose 的
> 中性默认，3200 是本机让 dashboard 与宿主 gitea 共存的运维选择。新机器照抄 `.env`，
> 不要改 compose.yaml 里的默认值。

### 8.5 两条 dashboard 镜像路径（不要混用）

| 路径 | 构建定义 | 部署身份 | 网络/端口 |
|---|---|---|---|
| **本套件**（现网形状） | `deploy/compose/Dockerfile.dashboard`（npm 钉版本） | label `ai.anet.deploy.pinned_npm_version` | 桥接网络，`${DASH_PORT:-3000}:3000` |
| **dashboard 仓库源码构建**（pixb 新代码） | `agent-network-dashboard/deploy/compose/Dockerfile.source` | label `org.opencontainers.image.revision` = pixb 提交 | host 网络，`127.0.0.1:3001` |

两者都会占用 dashboard 的监听端口与镜像标签，**不能同时跑**。pixb 上的新代码只存在于
源码构建路径（我们不发 npm，registry 上没有它）。

### 8.6 新增的契约测试

`tests/compose-rebuild/`：`compose-contract.sh`（定义完整性，含「与镜像内 entrypoint 逐字一致」）
与 `rebuild-drill.sh`（真构建 + fail-closed + 真起 `/health`，全在一次性标签/端口/数据目录上）。
