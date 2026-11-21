/**
 * 工作台房间的展示元信息（昵称 / 标题）。
 *
 * RoomTile 拿到 StreamInfo 后上报；「独立录制」弹窗挂在 MonitorPage 上，
 * 需要显示各房间主播昵称，但 MonitorPage 本身不取流，所以走模块级 store。
 */

export interface RoomMeta {
  nickname: string;
  title: string;
}

const metas = new Map<string, RoomMeta>();
let snapshot: ReadonlyMap<string, RoomMeta> = new Map();
const listeners = new Set<() => void>();

function publish() {
  snapshot = new Map(metas);
  for (const listener of listeners) listener();
}

export function setRoomMeta(key: string, meta: RoomMeta) {
  const previous = metas.get(key);
  if (previous && previous.nickname === meta.nickname && previous.title === meta.title) return;
  metas.set(key, meta);
  publish();
}

export function clearRoomMeta(key: string) {
  if (metas.delete(key)) publish();
}

export function subscribeRoomDirectory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRoomDirectorySnapshot(): ReadonlyMap<string, RoomMeta> {
  return snapshot;
}