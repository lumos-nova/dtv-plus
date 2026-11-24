import { describe, expect, it } from "vitest";
import type { StatusPatch } from "@/api/notify";
import { applyNotifyPatches, type NotifyRecordLike } from "./notifyPatches";

function record(overrides: Partial<NotifyRecordLike> = {}): NotifyRecordLike {
  return {
    id: "1",
    platform: "bilibili",
    nickname: "主播",
    title: "旧标题",
    isLive: false,
    isLoop: false,
    ...overrides,
  };
}

function patch(overrides: Partial<StatusPatch> = {}): StatusPatch {
  return {
    platform: "bilibili",
    id: "1",
    known: true,
    isLive: true,
    isLoop: false,
    ...overrides,
  };
}

describe("applyNotifyPatches", () => {
  it("下播→开播产生 live 跃迁并更新记录", () => {
    const result = applyNotifyPatches([record()], [patch({ title: "新标题" })]);
    expect(result.changed).toBe(true);
    expect(result.records[0].isLive).toBe(true);
    expect(result.records[0].title).toBe("新标题");
    expect(result.transitions).toEqual([{ nickname: "主播", title: "新标题", kind: "live" }]);
  });

  it("下播→轮播产生 loop 跃迁", () => {
    const result = applyNotifyPatches([record()], [patch({ isLoop: true })]);
    expect(result.transitions[0].kind).toBe("loop");
    expect(result.records[0].isLoop).toBe(true);
  });

  it("持续直播不产生跃迁，但标题变化仍更新", () => {
    const result = applyNotifyPatches(
      [record({ isLive: true })],
      [patch({ title: "换了标题" })],
    );
    expect(result.transitions).toEqual([]);
    expect(result.changed).toBe(true);
    expect(result.records[0].title).toBe("换了标题");
  });

  it("known=false 的补丁被忽略（失败不代表下播）", () => {
    const before = [record({ isLive: true })];
    const result = applyNotifyPatches(before, [patch({ known: false, isLive: false })]);
    expect(result.changed).toBe(false);
    expect(result.records).toBe(before);
    expect(result.transitions).toEqual([]);
  });

  it("空字段不覆盖已有昵称/标题", () => {
    const result = applyNotifyPatches(
      [record({ nickname: "有名字", title: "有标题" })],
      [patch({ nickname: "", title: "" })],
    );
    expect(result.records[0].nickname).toBe("有名字");
    expect(result.records[0].title).toBe("有标题");
  });

  it("无匹配补丁时原样返回", () => {
    const before = [record()];
    const result = applyNotifyPatches(before, [patch({ id: "999" })]);
    expect(result.changed).toBe(false);
    expect(result.records).toBe(before);
  });

  it("下播更新不产生跃迁", () => {
    const result = applyNotifyPatches(
      [record({ isLive: true })],
      [patch({ isLive: false })],
    );
    expect(result.changed).toBe(true);
    expect(result.records[0].isLive).toBe(false);
    expect(result.transitions).toEqual([]);
  });

  it("一批补丁只更新对应平台+ID 的记录", () => {
    const records = [
      record({ id: "1", platform: "bilibili" }),
      record({ id: "1", platform: "douyu", isLive: true }),
    ];
    const result = applyNotifyPatches(records, [patch()]);
    expect(result.records[0].isLive).toBe(true);
    expect(result.records[1]).toBe(records[1]);
    expect(result.transitions).toHaveLength(1);
  });
});