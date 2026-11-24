import { describe, expect, it } from "vitest";
import type { StreamVariant } from "@/api";
import { pickTileVariant } from "./tileQuality";

function variant(id: string, label: string): StreamVariant {
  return { id, label, url: `https://example.com/${id}.flv`, format: "flv" };
}

const bilibiliTiers = [
  variant("origin", "原画"),
  variant("bluray", "蓝光"),
  variant("ultra", "超清"),
  variant("high", "高清"),
  variant("smooth", "流畅"),
];

describe("pickTileVariant", () => {
  it("默认选中最低档而不是原画", () => {
    expect(pickTileVariant(bilibiliTiers, "")?.id).toBe("smooth");
  });

  it("用户手动选择的档位优先", () => {
    expect(pickTileVariant(bilibiliTiers, "origin")?.id).toBe("origin");
  });

  it("手动选择失效时回落到自动选择", () => {
    expect(pickTileVariant(bilibiliTiers, "gone")?.id).toBe("smooth");
  });

  it("只有原画一档时仍可用（如 B 站轮播）", () => {
    const loop = [variant("loop", "轮播 720P")];
    expect(pickTileVariant(loop, "")?.id).toBe("loop");
  });

  it("抖音英文档位按实际清晰度归档（SD1 最低、SD2 是高清）", () => {
    const douyin = [
      variant("origin", "原画"),
      variant("uhd", "FULL_HD1"),
      variant("hd", "HD1"),
      variant("sd", "SD2"),
      variant("ld", "SD1"),
    ];
    expect(pickTileVariant(douyin, "")?.id).toBe("ld");
  });

  it("虎牙档位选标清", () => {
    const huya = [
      variant("source", "原画"),
      variant("high", "高清 2000K"),
      variant("standard", "标清 500K"),
    ];
    expect(pickTileVariant(huya, "")?.id).toBe("standard");
  });

  it("抖音无中文档位名时按 key 归档", () => {
    const douyin = [
      variant("origin", "origin"),
      variant("uhd", "uhd"),
      variant("hd", "hd"),
      variant("sd", "sd"),
      variant("ld", "ld"),
    ];
    expect(pickTileVariant(douyin, "")?.id).toBe("ld");
  });

  it("未知档位名不误降级", () => {
    const unknown = [variant("a", "原画"), variant("b", "神秘档位")];
    expect(pickTileVariant(unknown, "")?.id).toBe("b");
  });

  it("空列表返回 undefined", () => {
    expect(pickTileVariant([], "")).toBeUndefined();
  });
});