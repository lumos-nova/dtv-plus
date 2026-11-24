import { describe, expect, it } from "vitest";
import type { FollowRecord } from "@/state/FollowProvider";
import { liveRank, sortLiveFirst } from "./followSort";

function record(id: string, status: "live" | "loop" | "off"): FollowRecord {
  return {
    id,
    platform: "douyu",
    nickname: `主播${id}`,
    title: "",
    avatar: "",
    viewers: 0,
    isLive: status !== "off",
    isLoop: status === "loop",
    followedAt: 0,
  };
}

describe("liveRank", () => {
  it("直播中 > 轮播中 > 未开播", () => {
    expect(liveRank(record("1", "live"))).toBeLessThan(liveRank(record("2", "loop")));
    expect(liveRank(record("2", "loop"))).toBeLessThan(liveRank(record("3", "off")));
  });
});

describe("sortLiveFirst", () => {
  it("把直播中的主播排在最前，轮播其次，未开播最后", () => {
    const input = [
      record("a", "off"),
      record("b", "loop"),
      record("c", "live"),
      record("d", "off"),
      record("e", "live"),
    ];
    expect(sortLiveFirst(input).map((item) => item.id)).toEqual(["c", "e", "b", "a", "d"]);
  });

  it("同状态内部保留用户的手动顺序（稳定排序）", () => {
    const input = [
      record("1", "live"),
      record("2", "off"),
      record("3", "live"),
      record("4", "off"),
      record("5", "live"),
    ];
    expect(sortLiveFirst(input).map((item) => item.id)).toEqual(["1", "3", "5", "2", "4"]);
  });

  it("不修改原数组（手动排序的存储顺序不受影响）", () => {
    const input = [record("a", "off"), record("b", "live")];
    const sorted = sortLiveFirst(input);
    expect(input.map((item) => item.id)).toEqual(["a", "b"]);
    expect(sorted).not.toBe(input);
  });

  it("空列表与全同状态列表原样返回", () => {
    expect(sortLiveFirst([])).toEqual([]);
    const input = [record("a", "off"), record("b", "off")];
    expect(sortLiveFirst(input).map((item) => item.id)).toEqual(["a", "b"]);
  });
});
