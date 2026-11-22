import { describe, expect, it } from "vitest";
import { liveTransitionKind } from "./liveTransitions";

describe("liveTransitionKind", () => {
  it("notifies on offline → live", () => {
    expect(liveTransitionKind({ isLive: false }, { isLive: true })).toBe("live");
  });

  it("notifies on offline → loop with loop kind", () => {
    expect(liveTransitionKind({ isLive: false }, { isLive: true, isLoop: true })).toBe("loop");
  });

  it("stays silent while already live", () => {
    expect(liveTransitionKind({ isLive: true }, { isLive: true })).toBeNull();
    expect(liveTransitionKind({ isLive: true, isLoop: true }, { isLive: true, isLoop: true })).toBeNull();
  });

  it("stays silent on offline → offline and live → offline", () => {
    expect(liveTransitionKind({ isLive: false }, { isLive: false })).toBeNull();
    expect(liveTransitionKind({ isLive: true }, { isLive: false })).toBeNull();
  });

  it("stays silent for newly followed streamers (no previous state)", () => {
    expect(liveTransitionKind(undefined, { isLive: true })).toBeNull();
  });

  it("stays silent when refresh failed (patch without isLive)", () => {
    expect(liveTransitionKind({ isLive: false }, {})).toBeNull();
  });
});