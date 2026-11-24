import { describe, expect, it } from "vitest";
import { isFatalError, isRiskControlError, stripFatalPrefix } from "./errors";

describe("isRiskControlError", () => {
  it("识别带 FATAL 前缀的拦截错误", () => {
    expect(isRiskControlError("FATAL_ERROR:本次请求受到服务器拦截，请稍后再试")).toBe(true);
  });

  it("识别风控冷却中的拦截错误", () => {
    expect(isRiskControlError("FATAL_ERROR:本次请求受到服务器拦截（风控冷却中），请稍后再试")).toBe(true);
  });

  it("识别 HTTP 拦截错误", () => {
    expect(isRiskControlError("FATAL_ERROR:本次请求受到服务器拦截 (HTTP 444)，请稍后再试")).toBe(true);
  });

  it("普通致命错误不算风控", () => {
    expect(isRiskControlError("FATAL_ERROR:房间不存在")).toBe(false);
  });

  it("普通错误不算风控", () => {
    expect(isRiskControlError("网络不可达")).toBe(false);
  });
});

describe("fatal 前缀语义保持不变", () => {
  it("拦截错误仍带 FATAL 前缀（由播放页特判长退避）", () => {
    const msg = "FATAL_ERROR:本次请求受到服务器拦截，请稍后再试";
    expect(isFatalError(msg)).toBe(true);
    expect(stripFatalPrefix(msg)).toBe("本次请求受到服务器拦截，请稍后再试");
  });
});