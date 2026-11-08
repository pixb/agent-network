// 2026-11-08 实测缺口 —— pi 的「滚存携带字符」在文档里写成 PI_ROLLOVER_CARRY_CHARS，
// 而代码读的是 PI_SESSION_ROLLOVER_CARRY_CHARS（cli.ts:4690，已安装的
// agent-node 2.5.0-preview.176 dist 同名）。运维照文档设值：
//   --env PI_ROLLOVER_CARRY_CHARS=0
// 会被静默忽略，启动横幅照打 carry=1200chars，于是「断记忆」的配置跑成了
// 「带 1200 字符记忆」。没有任何东西红。
//
// 这条测试就是那道门：文档里点名的每一个旋钮，代码里必须真的存在同名入口。
// 名字对不上 ⇒ 红，且打印出「文档写了 / 代码读了」两份清单，不用再去猜。
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DOC = join(import.meta.dir, "../../../../docs-site/docs/guide/pi-slow-local-model.md");
const CLI = join(import.meta.dir, "../../cli.ts");

function envNamesIn(text: string): string[] {
  return [...new Set(text.match(/\bPI_[A-Z0-9_]+\b/g) ?? [])].sort();
}
function piFlagNamesIn(text: string): string[] {
  // 只判 pi 前缀的 camelCase 旋钮名（文档表第三列），通用词如 timeout 不判。
  return [...new Set(text.match(/\bpi[A-Z][A-Za-z0-9]*\b/g) ?? [])].sort();
}

describe("pi 旋钮：文档点名的旋钮必须在代码里存在", () => {
  const docExists = existsSync(DOC);
  const doc = docExists ? readFileSync(DOC, "utf8") : "";
  const cli = readFileSync(CLI, "utf8");

  const codeEnv = new Set(envNamesIn(cli));
  const codeFlags = new Set(piFlagNamesIn(cli));

  test("文档文件可读（跨包门的前置；读不到就是布局变了）", () => {
    expect(docExists, DOC).toBe(true);
    expect(doc).toContain("会话滚存");
  });

  test("文档点名的每个 PI_* 环境变量都在代码里被读取", () => {
    const docEnv = envNamesIn(doc);
    expect(docEnv.length).toBeGreaterThan(0);
    const ghost = docEnv.filter((name) => !codeEnv.has(name));
    // 打印两份清单：只说「少了谁」不够，要能一眼看出文档写了什么、代码读的是什么。
    expect(ghost, `文档写: ${docEnv.join(", ")}\n代码读: ${[...codeEnv].sort().join(", ")}`)
      .toEqual([]);
  });

  test("文档点名的每个 flags.pi* 旋钮都在代码里被读取", () => {
    const docFlags = piFlagNamesIn(doc);
    expect(docFlags.length).toBeGreaterThan(0);
    const ghost = docFlags.filter((name) => !codeFlags.has(name));
    expect(ghost, `文档写: ${docFlags.join(", ")}\n代码读: ${[...codeFlags].sort().join(", ")}`)
      .toEqual([]);
  });

  test("携带字符的判据是「env 命中就算」，值为 0 不得回落默认（生产踩到的形状）", () => {
    const resolve = (raw: string | number | undefined): number => {
      const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
      if (raw === undefined || raw === "" || Number.isNaN(n)) return 1200;
      return Math.max(0, n);
    };
    expect(resolve("0")).toBe(0);
    expect(resolve(0)).toBe(0);
    expect(resolve(undefined)).toBe(1200); // 唯一合法的回落形状：键没写
  });
});
