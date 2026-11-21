/**
 * 工作台各房间回溯缓冲的全局统计（模块级外部 store）。
 *
 * RoomTile 每秒上报一次自己的缓冲字节数 / 秒数；「存储设置」弹窗通过
 * useSyncExternalStore 读取汇总，用于显示「当前实际缓存」和
 * 「按近期码率估算目标」。设置弹窗挂在全局 Navbar 上，拿不到
 * MonitorPage 的组件树，所以这里不走 Context。
 */

export interface RoomReplayStats {
  bytes: number;
  seconds: number;
}

const roomStats = new Map<string, RoomReplayStats>();
let snapshot: readonly RoomReplayStats[] = [];
const listeners = new Set<() => void>();

function publish() {
  snapshot = [...roomStats.values()];
  for (const listener of listeners) listener();
}

export function setRoomReplayStats(key: string, stats: RoomReplayStats) {
  const previous = roomStats.get(key);
  if (previous && previous.bytes === stats.bytes && previous.seconds === stats.seconds) return;
  roomStats.set(key, stats);
  publish();
}

export function clearRoomReplayStats(key: string) {
  if (roomStats.delete(key)) publish();
}

export function subscribeRecordingStats(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRecordingStatsSnapshot(): readonly RoomReplayStats[] {
  return snapshot;
}

export interface ReplayBufferSummary {
  bufferedBytes: number;
  estimatedTargetBytes: number;
}

/**
 * 汇总所有房间的缓冲：实际字节数直接求和；目标估算按每个房间
 * 「近期平均码率 × 目标时长」求和（只统计已有数据的房间）。
 */
export function summarizeRecordingStats(
  entries: readonly RoomReplayStats[],
  targetSeconds: number,
): ReplayBufferSummary {
  let bufferedBytes = 0;
  let bytesPerSecond = 0;
  for (const entry of entries) {
    const bytes = Math.max(0, entry.bytes);
    bufferedBytes += bytes;
    if (entry.seconds > 0) bytesPerSecond += bytes / entry.seconds;
  }
  return {
    bufferedBytes,
    estimatedTargetBytes: bytesPerSecond * Math.max(0, targetSeconds),
  };
}