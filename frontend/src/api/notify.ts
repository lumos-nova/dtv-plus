import { Events } from "@wailsio/runtime";
import * as Notify from "../../bindings/dtv/internal/services/notifyservice";
import type { StatusPatch, WatchItem } from "../../bindings/dtv/internal/notify/models";
import { isWailsRuntime } from "@/lib/window";
import type { LivePlatform } from "./types";

/**
 * 开播提醒引擎适配层。
 *
 * Go 侧常驻批量轮询（B 站 5s 批量 / 抖音 reflow 30s / 斗鱼 30s / 虎牙 60s），
 * 状态变化通过 "notify-status" 事件推回来。前端把关注表推给引擎
 * （SetWatchList），订阅事件即可；浏览器预览 / mock 模式下所有调用
 * 都是 no-op，FollowProvider 会退回旧的 60s 定时刷新。
 */

export type { StatusPatch, WatchItem };

/** 后端状态事件名（与 Go notify.EventName 一致）。 */
const STATUS_EVENT = "notify-status";

/** 构建期开关：与 api/index.ts 的 FORCE_MOCK 一致。 */
const FORCE_MOCK = import.meta.env.VITE_DTV_MOCK === "1";

/** 引擎是否可用（有 Go 后端且未强制 mock）。 */
export function notifyEngineAvailable(): boolean {
  return !FORCE_MOCK && isWailsRuntime();
}

function toPromise<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    p.then(resolve, reject);
  });
}

export const notifyApi = {
  /** 用最新关注表替换引擎的监听列表。 */
  setWatchList(items: { platform: LivePlatform; id: string }[]): Promise<void> {
    if (!notifyEngineAvailable()) return Promise.resolve();
    return toPromise(
      Notify.SetWatchList(items.map((item) => ({ platform: item.platform, id: item.id }))),
    ).catch((error: unknown) => {
      console.warn("[notify] 推送关注表失败", error);
    });
  },

  /** 开/关引擎轮询（对应设置里的"开播提醒"开关）。 */
  setEnabled(enabled: boolean): Promise<void> {
    if (!notifyEngineAvailable()) return Promise.resolve();
    return toPromise(Notify.SetEnabled(enabled)).catch((error: unknown) => {
      console.warn("[notify] 设置引擎开关失败", error);
    });
  },

  /** 拉一次引擎当前已知状态（订阅事件后的初始同步）。 */
  snapshot(): Promise<StatusPatch[]> {
    if (!notifyEngineAvailable()) return Promise.resolve([]);
    return toPromise(Notify.Snapshot())
      .then((list) => list ?? [])
      .catch(() => [] as StatusPatch[]);
  },

  /** 订阅状态事件；返回取消订阅函数。 */
  onStatus(onPatches: (patches: StatusPatch[]) => void): () => void {
    if (!notifyEngineAvailable()) return () => undefined;
    return Events.On(STATUS_EVENT, (ev: { data: StatusPatch[] }) => {
      const patches = ev?.data;
      if (Array.isArray(patches) && patches.length > 0) onPatches(patches);
    });
  },
};