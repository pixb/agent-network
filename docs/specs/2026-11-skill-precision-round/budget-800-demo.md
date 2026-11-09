# 派工正文预算 800 的现场验收（只读，一轮）

task: verify-pointer-budget-800
runtime: any (pi-cli / manual node)
working directory: the agent-network repository, branch pixb

## 背景（读这一段就够，不必读别处）

skill v0.7.4 把「指针正文」预算从 480 提到 800 字符，唯一来源是
`.agents/skills/agent-network-skill/scripts/budgets.json` 里的 `task_max`。
本文件是这条预算的现场验收规格：worker 只读，不改任何文件。

预算口径（同一份文件里）：指针 800 字符 / ≤8 行 / 第 1 行 ≤100；
brief 1600；交付 result 2400；改派 resend 400；message 3000；context 400；版式行长 120。

## 你要做的事（全部只读）

1. 读 `.agents/skills/agent-network-skill/scripts/budgets.json`，取 `task_max`、
   `brief_max`、`result_max`、`line1_max` 四个值。
2. 读 `.agents/skills/agent-network-skill/SKILL.md` 的预算表，取同一行里写的四个数字。
3. 跑一次边界实测（两条命令，正文必须落在 8 行以内，第二条只比第一条多 1 个字符）：

       export LD_LIBRARY_PATH=/home/pix/.pyenv/versions/3.12.13/lib:${LD_LIBRARY_PATH:-}
       S=.agents/skills/agent-network-skill/scripts/anet_payload.sh
       BODY=$(python3 -c 'head="verdict: 3 tests green "+"h"*77;acc="accept: every item on the acceptance list";unit="- evidence line with text to fill the pointer budget out "+"e"*54;step=len(unit)+1;used=len(head)+1+len(acc);N=800;R=N-used;k=(R-2)//step;t=R-step*k-1;print(chr(10).join([head,acc]+[unit]*k+["t"*t]))')
       bash "$S" guard --body "$BODY" --kind task; echo "at800 exit=$?"
       bash "$S" guard --body "${BODY}t" --kind task; echo "at801 exit=$?"

   指针预算是 800 字符 **且** ≤8 行、第 1 行 ≤100。上一版这条命令用 70 字符单位填满 800，产出 13 行，
   被拒的原因是行数不是字数（实测 exit=2 报 `the body is 13 lines (budget 8)`）；第二条命令加的是 2 个
   字符（实测 802）；写成 `$BODYt` 还会被 shell 解成未赋值的变量 BODYt（实测 guard 收到空正文，
   exit=0 假绿）。现在写 `${BODY}t`：负例只多 1 个字符。

4. 数一下这条正文的实际字符数、行数、第 1 行字符数（`guard` 的 `body ok` 那行就有）。

## 验收清单（逐条回报，给实测数值）

- A1 budgets.json 的四个值，逐条列出（key: value）。
- A2 SKILL.md 预算表里对应的四个数字，逐条列出，并明确回答「与 A1 是否逐项相同」。
- A3 两条边界命令的退出码：800 字符必须 0；801 字符必须非 0。
- A4 800 字符正文的 `guard` 输出原文（body ok 那一行）。
- A5 一句话结论：这条预算在真实脚本里是否真的按 800 生效。

## 边界（必须遵守）

- 只读：不写文件、不 commit、不 push、不调 hub。
- 不修改 `.agents/` 与 `docs/` 下任何文件。
- 指纹只准用脚本核：`bash "$S" verify --file docs/specs/2026-11-skill-precision-round/budget-800-demo.md --sha12 <正文里那个>`。
  `sha1sum` 的前 12 位与 `git hash-object` 不是同一个函数，不要拿它们当 sha12（上一轮工人就是这样误报「指针指纹对不上」的）。
- 命令必须照抄上面给的形式；换别的写法要在结果里说明为什么等价。

## 交付格式

report_completion 的 result ≤ 2400 字符，第 1 行是一句话结论，
然后逐条 A1…A5（key: value 或 `- ` 开头），不要表格、`#`、加粗、反引号。
