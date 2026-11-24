import type { StatusPatch } from "@/api/notify";
import { liveTransitionKind, type LiveTransitionKind } from "./liveTransitions";

/**
 * 开播提醒引擎事件 → 关注记录的纯函数转换。
 *
 * 与手动刷新（refreshStatuses）共用同一套跃迁判定（liveTransitionKind），
 * 保证"下播→开播/轮播才提醒"的语义一致。抽成纯函数便于单测。
 */

export interface NotifyRecordLike {
  id: string;
  platform: string;
  nickname: string;
  title: string;
  isLive: boolean;
  isLoop?: boolean;
}

export interface NotifyTransition {
  nickname: string;
  title: string;
  kind: LiveTransitionKind;
}

export interface NotifyApplyResult<T> {
  records: T[];
  transitions: NotifyTransition[];
  /** 是否有任何记录被更新（无更新时调用方应跳过 setState） */
  changed: boolean;
}

/**
 * 把引擎推来的一批状态补丁应用到关注记录上。
 *
 * - known=false 的补丁忽略（查询失败不代表下播）；
 * - 空字符串字段不覆盖已有值（引擎的轻量接口可能缺昵称/头像）；
 * - 跃迁用补丁前的状态判定，和手动刷新一致。
 */
export function applyNotifyPatches<T extends NotifyRecordLike>(
  records: T[],
  patches: StatusPatch[],
): NotifyApplyResult<T> {
  const byKey = new Map<string, StatusPatch>();
  for (const patch of patches) {
    if (patch && patch.known && patch.platform && patch.id) {
      byKey.set(`${patch.platform}:${patch.id}`, patch);
    }
  }
  if (byKey.size === 0) return { records, transitions: [], changed: false };

  const transitions: NotifyTransition[] = [];
  let changed = false;
  const next = records.map((record) => {
    const patch = byKey.get(`${record.platform}:${record.id}`);
    if (!patch) return record;
    const kind = liveTransitionKind(
      { isLive: record.isLive, isLoop: record.isLoop },
      { isLive: patch.isLive, isLoop: patch.isLoop },
    );
    if (kind) {
      transitions.push({
        nickname: patch.nickname || record.nickname || `${record.platform}:${record.id}`,
        title: patch.title || record.title || "",
        kind,
      });
    }
    const updated: T = {
      ...record,
      isLive: patch.isLive,
      isLoop: patch.isLoop,
      nickname: patch.nickname || record.nickname,
      title: patch.title || record.title,
    };
    if (
      updated.isLive !== record.isLive ||
      Boolean(updated.isLoop) !== Boolean(record.isLoop) ||
      updated.nickname !== record.nickname ||
      updated.title !== record.title
    ) {
      changed = true;
      return updated;
    }
    return record;
  });
  return { records: changed ? next : records, transitions, changed };
}