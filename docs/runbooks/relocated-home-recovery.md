# Home 搬家后 python / npm 静默坏掉：诊断与恢复

> 依据 2026-11-23 在本机实测（home 曾在 `/vol1/1000/pix`，后切回 `/home/pix`，pyenv 是旧路径时期编译的）。

## 症状

`python3` 起不来，但**看起来像 skill / 脚本自己的错**：

```
$ python3 -V
/home/pix/.pyenv/versions/3.12.13/bin/python3: error while loading shared libraries:
libpython3.12.so.1.0: cannot open shared object file: No such file or directory
```

危险之处不是报错本身，而是**上层把「解释器缺失」误报成「被测对象失败」**：agent-network-skill 的
eval 套件当时报 `12 errored`，看着像 skill 坏了，实际是每个 case 都要 shell 出去调 `python3`。
同一时期 `pip`、仓库里的 `.github/scripts/*.py` 也全部不可用。

## 5 秒判据

```bash
python3 -V                                   # 能打印版本 = 解释器活着
readelf -d "$(readlink -f "$(command -v python3)")" | grep -i runpath
```

若 `RUNPATH` 指向一个**不是** `$(dirname $(dirname $(command -v python3)))` 的路径，就是这个病。

## 实测证据（2026-11-23）

| 项 | 值 |
|---|---|
| 触发 | pyenv 3.12.13 于 **2026-10-17** 在 `HOME=/vol1/1000/pix` 下编译；之后 home 切回 `/home/pix` |
| `RUNPATH`（`bin/python3.12`） | `/vol1/1000/pix/.pyenv/versions/3.12.13/lib`（旧前缀） |
| 引用旧前缀的文件数 | **6047** —— 含 `lib/python3.12/lib-dynload/*.so` 全部 79 个扩展的 `RUNPATH`，及 `bin/pip`、`bin/pip3`、`bin/idle3.12`、`bin/pydoc3.12`、`bin/2to3-3.12` 的 shebang |
| 库文件本身 | 一直在（`lib/libpython3.12.so.1.0`，32 MB）⇒ **不是缺库，是找不到** |
| `~/.npmrc` | `prefix=/vol1/1000/pix/.npm-global`（同一批遗留）⇒ `npm i -g` 会装到 PATH 之外 |
| 干净的部分 | `.zshrc/.bashrc/.profile`、`~/.pi`、`~/.claude`、`~/.anet`、systemd 单元、crontab、docker compose 均无旧路径 |

## 两条修法

### A. 快速恢复：恢复旧前缀（分钟级，可逆）

```bash
mkdir -p /vol1/1000/pix
ln -sfn "$HOME/.pyenv" /vol1/1000/pix/.pyenv      # 只链 .pyenv，不暴露整个 home
python3 -V                                        # 期望 3.12.13
```

一次修全 6047 处（`RUNPATH` 和 shebang 都靠它解析），不动二进制、不污染全局环境变量。
回滚：`rm -rf /vol1/1000/pix`。

**代价**：解释器内部仍认为自己在旧路径（`pip --version` 会打印 `/vol1/1000/pix/...`），
换了机器或 `/vol1` 掉挂载就复发。**A 只适合应急。**

### B. 永久修好：在真实 home 下重编译（本文实际采用，构建 278 秒）

```bash
# 1) 预热源码并校验 checksum（定义里写死的 sha256 见 python-build 的 3.12.13 定义）
mkdir -p "$HOME/.pyenv/cache" && cd "$HOME/.pyenv/cache"
curl -sSfo Python-3.12.13.tar.xz https://www.python.org/ftp/python/3.12.13/Python-3.12.13.tar.xz
sha256sum Python-3.12.13.tar.xz   # 期望 c08bc65a81971c1dd5783182826503369466c7e67374d1646519adf05207b684

# 2) 留回滚点（同分区 mv，瞬时）
mv "$HOME/.pyenv/versions/3.12.13" "$HOME/.pyenv/versions/3.12.13.pre-rebuild-$(date +%Y%m%d)"

# 3) 构建 —— 🔴 必须显式传 --enable-shared，见下方「rpath 陷阱」
env -u PKG_CONFIG_PATH -u LD_LIBRARY_PATH -u LDFLAGS -u LIBS -u CPPFLAGS -u CFLAGS \
    MAKE_OPTS="-j$(nproc)" PYTHON_CONFIGURE_OPTS="--enable-shared" \
    "$HOME/.pyenv/bin/pyenv" install 3.12.13

# 4) 拆除旧前缀（这一步才是修好的证明）
rm -rf /vol1/1000/pix
```

构建期间 `python3` 不可用（本机实测 278 秒）；Go/Node/bun/Rust 不受影响。

#### rpath 陷阱（本次最容易再次踩）

`python-build` **默认就给你 `--enable-shared`**（脚本 `python-build` 第 2534-2536 行），
但**只在「调用方显式传了 `--enable-shared`」时才补 `-Wl,-rpath,<prefix>/lib`**（第 2543-2546 行）。
所以：不传选项 ⇒ 共享库照建、rpath 没有 ⇒ 构建成功但 `python3` 一跑就 `libpython… not found`，
**和这次手上一模一样的病**。改之前先读那两段。

## 验证矩阵（全过才算修好）

```bash
PY="$(readlink -f "$(command -v python3)")"
readelf -d "$PY" | grep -i runpath                  # 必须是 $HOME 下的 lib，且不含旧前缀
head -1 "$HOME/.pyenv/versions/3.12.13/bin/pip"     # shebang 必须是 $HOME
grep -rl '/vol1/1000/pix' "$HOME/.pyenv/versions/3.12.13" | wc -l   # 期望 0
python3 -c "import ssl,sqlite3,zlib,hashlib,ctypes,tkinter,readline,curses,dbm.gnu"  # 编译扩展
python3 -m pip list --format=freeze                 # 与搬家前的 freeze 逐字对比
python3 -m venv /tmp/v && /tmp/v/bin/python -V && rm -rf /tmp/v
```

本机实测结果（重建后）：`RUNPATH` = `/home/pix/.pyenv/versions/3.12.13/lib`、旧前缀引用 **0**、
79 个 `lib-dynload` 模块与重建前**逐个一致**、`pip==25.0.1` / `setuptools==84.0.0` 与基线逐字相同、
`zhconv==1.4.3` 在 **user site**（`~/.local/lib/python3.12/site-packages`，隔离 venv 本来就看不到它）。

## 搬家后还要一起查的（本次逐一实测，全部干净）

```bash
grep -rn '/vol1/1000/pix' ~/.npmrc ~/.zshrc ~/.bashrc ~/.profile 2>/dev/null   # shell/npm 配置
npm config get prefix && npm ls -g --depth=0                                   # 全局包树是否落在真实 home
grep -rl '/vol1/1000/pix' /etc/systemd/system /etc/cron.d /etc/cron.daily 2>/dev/null
crontab -l 2>/dev/null | grep '/vol1/1000/pix'
grep -rl --include='*.yml' --include='*.env' '/vol1/1000/pix' /vol1/1000/docker | grep -v '/data/'
```

`~/.npmrc` 的修法（本次唯一命中项，改前已备份为 `~/.npmrc.bak-home-move-<日期>`）：

```bash
sed -i 's|^prefix=/vol1/1000/pix/\.npm-global$|prefix='"$HOME"'/.npm-global|' ~/.npmrc
npm config get prefix     # 期望 $HOME/.npm-global
npm ls -g --depth=0       # 修复前这里是空的（prefix 指向不存在的目录），修复后列出真实全局包
```

## 探针

`bash scripts/check-local-env.sh` —— 只读、秒级，把上面这些判据压成一次退出码：

- `$HOME` 与 `getent passwd` 一致
- `python3 -V` 可跑；解释器前缀在 `$HOME` 下（系统解释器也接受）
- `ssl` / `sqlite3` / `ctypes` 可加载
- `npm config get prefix` == `$HOME/.npm-global`（有 npm 时）

它的意义：这次的失败形态是「**12 个 eval case 报 error，看着像被测对象坏了**」。
一个 5 秒的探针能把「环境坏了」和「代码坏了」分开。

## 回滚

| 状态 | 回滚 |
|---|---|
| A（兼容链接） | `rm -rf /vol1/1000/pix` |
| B 构建失败或验证不过 | `rm -rf ~/.pyenv/versions/3.12.13 && mv ~/.pyenv/versions/3.12.13.pre-rebuild-<日期> ~/.pyenv/versions/3.12.13 && pyenv rehash`（旧树的 rpath 指向旧前缀，先按 A 建一次兼容链接即可复活） |
| npmrc | `cp ~/.npmrc.bak-home-move-<日期> ~/.npmrc` |

旧版本目录在确认绿了几天之后再删：它是唯一的回滚点。
