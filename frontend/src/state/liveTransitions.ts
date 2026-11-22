/**
 * 开播提醒的状态跃迁判定（纯函数，便于单测）。
 *
 * 只有"下播 → 开播/开始轮播"才算一次开播事件；
 * 持续直播、下播、新增关注都不提醒，避免刷新时刷屏。
 */

export interface LivePrevState {
  isLive: boolean;
  isLoop?: boolean;
}

export interface LiveNextState {
  isLive?: boolean;
  isLoop?: boolean;
}

export type LiveTransitionKind = "live" | "loop";

export function liveTransitionKind(
  prev: LivePrevState | undefined,
  next: LiveNextState,
): LiveTransitionKind | null {
  if (!prev || prev.isLive || next.isLive !== true) return null;
  return next.isLoop ? "loop" : "live";
}