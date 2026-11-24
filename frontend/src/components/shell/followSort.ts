import type { FollowRecord } from "@/state/FollowProvider";

/** 「直播中优先」的排序权重：直播中 > 轮播中 > 未开播（与行内状态徽章一致） */
export function liveRank(record: FollowRecord): number {
  if (record.isLoop) return 1;
  return record.isLive ? 0 : 2;
}

/** 稳定排序：同状态内部仍保留用户的手动顺序；只改显示，不落盘。 */
export function sortLiveFirst(records: FollowRecord[]): FollowRecord[] {
  return [...records].sort((a, b) => liveRank(a) - liveRank(b));
}
