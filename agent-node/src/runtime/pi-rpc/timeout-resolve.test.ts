// 分相超时解析：运维要能看出「我写的值到底生效了没有」。
// 形状照 grok #214 维度 5 A6（配置里写了值 ≠ 运行时用了这个值）。

import { describe, expect, it } from "bun:test";
import {
  PI_TIMEOUT_CEILING_MS,
  PI_TIMEOUT_FLOOR_MS,
  describePiTimeout,
  resolvePiSwitch,
  resolvePiTimeout,
} from "./timeout-resolve";

describe("resolvePiTimeout — 优先级 env > flags > default", () => {
  it("三个来源各自胜出时 source 说清是谁", () => {
    expect(resolvePiTimeout({ defaultMs: 900000 }).source).toBe("default");
    expect(
      resolvePiTimeout({ flagValue: 120000, defaultMs: 900000 }).source,
    ).toBe("flags");
    expect(
      resolvePiTimeout({ envValue: "60000", flagValue: 120000, defaultMs: 900000 }).source,
    ).toBe("env");
    expect(
      resolvePiTimeout({ envValue: "60000", flagValue: 120000, defaultMs: 900000 }).valueMs,
    ).toBe(60000);
  });

  it("非法值按未设置处理（不能让一个空串悄悄变成 0）", () => {
    expect(resolvePiTimeout({ envValue: "", flagValue: "abc", defaultMs: 500 }).valueMs).toBe(500);
    expect(resolvePiTimeout({ flagValue: -5, defaultMs: 500 }).valueMs).toBe(500);
    expect(resolvePiTimeout({ flagValue: Number.NaN, defaultMs: 500 }).valueMs).toBe(500);
  });

  it("低于下限被夹住，并且说明是被谁夹的 —— 比一次压缩还短的 ack 等于把压缩判成失败", () => {
    const r = resolvePiTimeout({ flagValue: 1000, defaultMs: 900000 });
    expect(r.valueMs).toBe(PI_TIMEOUT_FLOOR_MS);
    expect(r.source).toBe("floor");
    expect(describePiTimeout("promptAck", r)).toContain("低于下限");
    expect(describePiTimeout("promptAck", r)).toContain("压缩");
  });

  it("超过上限也夹住并说明", () => {
    const r = resolvePiTimeout({ envValue: "99999999999", defaultMs: 1 });
    expect(r.valueMs).toBe(PI_TIMEOUT_CEILING_MS);
    expect(r.source).toBe("ceiling");
  });

  it("floor=0 允许「关掉这一相」（观察窗要能显式关）", () => {
    const r = resolvePiTimeout({ flagValue: 0, defaultMs: 30000, floorMs: 0 });
    expect(r.valueMs).toBe(0);
    expect(r.source).toBe("flags");
  });
});

describe("resolvePiSwitch", () => {
  it("0 显式关闭，未设置 = 未关闭", () => {
    expect(resolvePiSwitch({}).set).toBe(false);
    expect(resolvePiSwitch({ flagValue: 0 }).disabled).toBe(true);
    expect(resolvePiSwitch({ envValue: "0" }).disabled).toBe(true);
    expect(resolvePiSwitch({ envValue: "1" }).disabled).toBe(false);
  });
});

describe("describePiTimeout", () => {
  it("一行里给出值与来源（启动横幅用）", () => {
    expect(describePiTimeout("handshake", resolvePiTimeout({ defaultMs: 45000 }))).toBe(
      "handshake=45000ms(default)",
    );
  });
});
