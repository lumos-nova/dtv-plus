import { describe, expect, it } from "vitest";
import { recoveryDelay, shouldAutoRecover } from "./recovery";

describe("recoveryDelay", () => {
  it("前两次立即重试", () => {
    expect(recoveryDelay(1)).toBe(0);
    expect(recoveryDelay(2)).toBe(0);
  });

  it("之后按 2/4/8/16/30 秒退避并封顶", () => {
    expect(recoveryDelay(3)).toBe(2_000);
    expect(recoveryDelay(4)).toBe(4_000);
    expect(recoveryDelay(5)).toBe(8_000);
    expect(recoveryDelay(6)).toBe(16_000);
    expect(recoveryDelay(7)).toBe(30_000);
    expect(recoveryDelay(99)).toBe(30_000);
  });
});

describe("shouldAutoRecover", () => {
  it("普通错误与风控错误需要重试", () => {
    expect(shouldAutoRecover("网络不可达")).toBe(true);
    expect(shouldAutoRecover("FATAL_ERROR:本次请求受到服务器拦截")).toBe(true);
  });

  it("致命错误不再重试", () => {
    expect(shouldAutoRecover("FATAL_ERROR:房间不存在")).toBe(false);
  });
});
