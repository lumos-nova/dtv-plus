import { FolderPlus, History, Share2, Star, Video } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { api, PLATFORM_LABEL, type DanmakuMessage, type StreamInfo } from "@/api";
import { DanmuOverlay } from "@/features/player/DanmuOverlay";
import { DanmuPanel } from "@/features/player/DanmuPanel";
import { isDanmuBlocked, type DanmuUserSettings } from "@/features/player/danmuSettings";
import { PlayerChrome } from "@/features/player/PlayerChrome";
import { useXgPlayer } from "@/features/player/useXgPlayer";
import { cn } from "@/lib/cn";
import { reportLiveEvent } from "@/lib/liveLog";
import { usePortalHost } from "@/lib/portal";
import { BILIBILI_AUTH_EVENT } from "@/state/BilibiliAuthProvider";
import { DOUYU_AUTH_EVENT } from "@/state/DouyuAuthProvider";
import { useFollow } from "@/state/FollowProvider";
import { useToast } from "@/state/ToastProvider";
import {
  resizeGridPlacement,
  type GridPlacement,
  type GridPosition,
  type MonitorRoom,
  type MonitorTileSize,
  type ResizeDirection,
} from "./layout";
import { clearRoomReplayStats, setRoomReplayStats } from "./recordingStats";
import { clearRoomMeta, setRoomMeta } from "./roomDirectory";
import { liveRoomShareUrl } from "./roomUrl";
import { GroupAssignDialog } from "./GroupAssignDialog";
import { ReplayHighlightModal } from "./ReplayHighlightModal";
import { useRoomRecording } from "./useRoomRecording";
import { recoveryDelay, shouldAutoRecover } from "./recovery";
import { pickTileVariant } from "./tileQuality";
import styles from "./RoomTile.module.css";

const MAX_MESSAGES = 120;
const MESSAGE_FLUSH_MS = 150;
const ROOM_DRAG_HOLD_MS = 220;
/** 卡片内鼠标静止多久后自动隐藏控制栏 / 主播信息 */
const CHROME_IDLE_MS = 2000;
/** 取流 IPC 的前端超时；Go 侧最坏 90s，这里提前判定并进入自愈 */
const STREAM_INFO_TIMEOUT_MS = 15_000;
/** 确认离线/无档位后的轮询间隔（旧播放页的 30s 刷新在重构中丢失） */
const OFFLINE_REFRESH_MS = 30_000;
/** 错误与看门狗可能同时触发，短时间内只自愈一次 */
const RECOVER_THROTTLE_MS = 400;
let lastRoomDragEndedAt = 0;

const RESIZE_HANDLES: { direction: ResizeDirection; className: string; label: string }[] = [
  { direction: "n", className: styles.resizeNorth, label: "拖动调整卡片上边缘" },
  { direction: "e", className: styles.resizeEast, label: "拖动调整卡片右边缘" },
  { direction: "s", className: styles.resizeSouth, label: "拖动调整卡片下边缘" },
  { direction: "w", className: styles.resizeWest, label: "拖动调整卡片左边缘" },
  { direction: "nw", className: styles.resizeNorthWest, label: "拖动调整卡片左上角" },
  { direction: "ne", className: styles.resizeNorthEast, label: "拖动调整卡片右上角" },
  { direction: "se", className: styles.resizeSouthEast, label: "拖动调整卡片右下角" },
  { direction: "sw", className: styles.resizeSouthWest, label: "拖动调整卡片左下角" },
];

interface RoomTileProps {
  room: MonitorRoom;
  placement: GridPlacement;
  replayEnabled: boolean;
  replaySeconds: number;
  /** todo02：Ctrl 多选态与切换回调 */
  selected: boolean;
  onToggleSelect: (key: string) => void;
  focused: boolean;
  soundEnabled: boolean;
  globalVolume: number;
  windowFullscreen: boolean;
  onAudioFocus: (key: string, multiple: boolean) => void;
  onToggleWindowFullscreen: (key: string) => void;
  onDanmakuToggle: (key: string) => void;
  onDanmakuSettingsChange: (key: string, patch: Partial<DanmuUserSettings>) => void;
  blockKeywords: string[];
  blockKeywordsLower: string[];
  onAddBlockKeyword: (keyword: string) => boolean;
  onRemoveBlockKeyword: (keyword: string) => void;
  onClearBlockKeywords: () => void;
  onVolumeChange: (key: string, volume: number) => void;
  onLineChange: (key: string, lineId: string) => void;
  onQualityChange: (key: string, qualityId: string) => void;
  onRemove: (key: string) => void;
  onGroupChange: (key: string, group: string) => void;
  onMove: (fromKey: string, clientX: number, clientY: number) => void;
  onDraggingChange: (key: string, dragging: boolean) => void;
  onDragPositionChange: (key: string, clientX: number, clientY: number) => void;
  onResize: (key: string, size: MonitorTileSize, position?: GridPosition) => void;
}

export function RoomTile({
  room,
  placement,
  replayEnabled,
  replaySeconds,
  selected,
  onToggleSelect,
  focused,
  soundEnabled,
  globalVolume,
  windowFullscreen,
  onAudioFocus,
  onToggleWindowFullscreen,
  onDanmakuToggle,
  onDanmakuSettingsChange,
  blockKeywords,
  blockKeywordsLower,
  onAddBlockKeyword,
  onRemoveBlockKeyword,
  onClearBlockKeywords,
  onVolumeChange,
  onLineChange,
  onQualityChange,
  onRemove,
  onGroupChange,
  onMove,
  onDraggingChange,
  onDragPositionChange,
  onResize,
}: RoomTileProps) {
  const tileRef = useRef<HTMLElement>(null);
  const playerHostRef = useRef<HTMLDivElement>(null);
  const resizeGestureRef = useRef<{
    pointerId: number;
    direction: ResizeDirection;
    startX: number;
    startY: number;
    startPlacement: GridPlacement;
    lastPlacement: GridPlacement;
    stepX: number;
    stepY: number;
  } | null>(null);
  const moveGestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    timer: number;
    active: boolean;
  } | null>(null);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onDraggingChangeRef = useRef(onDraggingChange);
  onDraggingChangeRef.current = onDraggingChange;
  const onDragPositionChangeRef = useRef(onDragPositionChange);
  onDragPositionChangeRef.current = onDragPositionChange;
  const messageBufferRef = useRef<DanmakuMessage[]>([]);
  const blockKeywordsLowerRef = useRef(blockKeywordsLower);
  blockKeywordsLowerRef.current = blockKeywordsLower;
  const reconnectAttemptRef = useRef(0);
  const backoffTimerRef = useRef<number | null>(null);
  const lastRecoverAtRef = useRef(0);
  // 统一自愈入口：在下方 render 期间填充，取流 effect 通过 ref 调用。
  const recoverRef = useRef<(reason: string) => void>(() => {});
  const [info, setInfo] = useState<StreamInfo | null>(null);
  const [infoError, setInfoError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [messages, setMessages] = useState<DanmakuMessage[]>([]);
  const [longPressDragging, setLongPressDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);
  const [moveOffset, setMoveOffset] = useState({ x: 0, y: 0 });
  const [danmakuPanelOpen, setDanmakuPanelOpen] = useState(false);
  const [tileFullscreen, setTileFullscreen] = useState(false);
  // todo05：单卡 DOM 全屏时右键菜单要挂进全屏元素，否则 body 上的菜单不可见。
  const portalHost = usePortalHost();
  const { toast } = useToast();
  const { folders, isFollowing, toggleFollow, createFolder, moveToFolder, removeFromFolder } =
    useFollow();
  // 分组 = 侧边栏关注文件夹：实时反查当前主播所在文件夹，
  // 侧栏重命名 / 删除 / 拖动都会立刻反映到卡片徽章上。
  const currentFolder = folders.find((folder) => folder.keys.includes(room.key));

  useEffect(() => {
    const tileAtPoint = (event: globalThis.PointerEvent) =>
      document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-monitor-room-key]");

    const onPointerMove = (event: globalThis.PointerEvent) => {
      const resize = resizeGestureRef.current;
      if (resize?.pointerId === event.pointerId) {
        event.preventDefault();
        const horizontalDelta = Math.round((event.clientX - resize.startX) / resize.stepX);
        const verticalDelta = Math.round((event.clientY - resize.startY) / resize.stepY);
        const horizontalFactor = resize.direction.includes("e")
          ? 1
          : resize.direction.includes("w")
            ? -1
            : 0;
        const verticalFactor = resize.direction.includes("s")
          ? 1
          : resize.direction.includes("n")
            ? -1
            : 0;
        const columns = Math.max(
          1,
          Math.min(4, resize.startPlacement.columns + horizontalDelta * horizontalFactor),
        ) as MonitorTileSize["columns"];
        const rows = Math.max(
          1,
          Math.min(4, resize.startPlacement.rows + verticalDelta * verticalFactor),
        ) as MonitorTileSize["rows"];
        const nextPlacement = resizeGridPlacement(
          resize.startPlacement,
          resize.direction,
          columns,
          rows,
        );
        if (!nextPlacement) return;
        if (
          nextPlacement.column === resize.lastPlacement.column &&
          nextPlacement.row === resize.lastPlacement.row &&
          nextPlacement.columns === resize.lastPlacement.columns &&
          nextPlacement.rows === resize.lastPlacement.rows
        ) {
          return;
        }
        resize.lastPlacement = nextPlacement;
        onResizeRef.current(
          room.key,
          {
            columns: nextPlacement.columns as MonitorTileSize["columns"],
            rows: nextPlacement.rows as MonitorTileSize["rows"],
          },
          { column: nextPlacement.column, row: nextPlacement.row },
        );
        return;
      }

      const gesture = moveGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      if (!gesture.active) {
        if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 8) {
          window.clearTimeout(gesture.timer);
          moveGestureRef.current = null;
        }
        return;
      }
      setMoveOffset({
        x: event.clientX - gesture.startX,
        y: event.clientY - gesture.startY,
      });
      onDragPositionChangeRef.current(room.key, event.clientX, event.clientY);
      const targetKey = tileAtPoint(event)?.dataset.monitorRoomKey;
      setDropTarget(Boolean(targetKey && targetKey !== room.key));
    };

    const onPointerEnd = (event: globalThis.PointerEvent) => {
      const resize = resizeGestureRef.current;
      if (resize?.pointerId === event.pointerId) {
        resizeGestureRef.current = null;
        setResizing(false);
        onDraggingChangeRef.current(room.key, false);
        return;
      }

      const gesture = moveGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      window.clearTimeout(gesture.timer);
      moveGestureRef.current = null;
      setLongPressDragging(false);
      setDropTarget(false);
      setMoveOffset({ x: 0, y: 0 });
      if (gesture.active) onDraggingChangeRef.current(room.key, false);
      if (!gesture.active || event.type === "pointercancel") return;
      event.preventDefault();
      lastRoomDragEndedAt = Date.now();
      onMoveRef.current(room.key, event.clientX, event.clientY);
    };

    const onWindowBlur = () => {
      if (!resizeGestureRef.current) return;
      resizeGestureRef.current = null;
      setResizing(false);
      onDraggingChangeRef.current(room.key, false);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    window.addEventListener("blur", onWindowBlur);
    const onFullscreenChange = () =>
      setTileFullscreen(document.fullscreenElement === tileRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (moveGestureRef.current) {
        window.clearTimeout(moveGestureRef.current.timer);
        if (moveGestureRef.current.active) onDraggingChangeRef.current(room.key, false);
      }
      if (resizeGestureRef.current) {
        resizeGestureRef.current = null;
        onDraggingChangeRef.current(room.key, false);
      }
    };
  }, [room.key]);

  const beginMove = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("button, input, select, textarea, label, [role='slider'], [draggable='true']")
    ) {
      return;
    }
    if (moveGestureRef.current) window.clearTimeout(moveGestureRef.current.timer);
    const gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timer: 0,
      active: false,
    };
    gesture.timer = window.setTimeout(() => {
      if (moveGestureRef.current !== gesture) return;
      gesture.active = true;
      setMoveOffset({ x: 0, y: 0 });
      setLongPressDragging(true);
      onDraggingChangeRef.current(room.key, true);
      onDragPositionChangeRef.current(room.key, gesture.startX, gesture.startY);
    }, ROOM_DRAG_HOLD_MS);
    moveGestureRef.current = gesture;
  };

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;
    setInfo(null);
    setInfoError("");

    // IPC 没有内建超时；上游 HTTP 最坏约 90s，超过 15s 就当失败进入自愈。
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(
        () => reject(new Error("取流超时，正在自动重试")),
        STREAM_INFO_TIMEOUT_MS,
      );
    });
    void Promise.race([
      api.getStreamInfo(room.platform, room.roomId, room.lineId),
      timeout,
    ])
      .then((next) => {
        if (!cancelled) {
          setInfo(next);
          setInfoError("");
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "直播信息加载失败";
        setInfoError(message);
        reportLiveEvent("stream.info.error", room.platform, room.roomId, message);
        // 房间不存在等致命错误不重试；风控是临时状态，走长退避自愈。
        if (shouldAutoRecover(message)) {
          recoverRef.current("取流失败");
        }
      })
      .finally(() => {
        if (timeoutId != null) window.clearTimeout(timeoutId);
      });

    return () => {
      cancelled = true;
      if (timeoutId != null) window.clearTimeout(timeoutId);
    };
  }, [retryKey, room.lineId, room.platform, room.roomId]);

  // 小窗默认中低档省内存/带宽；用户手动选过的清晰度优先（见 tileQuality）
  const variant = pickTileVariant(info?.variants ?? [], room.qualityId);
  const source =
    info?.isLive && variant ? { url: variant.url, format: variant.format, nonce: retryKey } : null;
  const player = useXgPlayer(playerHostRef, source, true, {
    volume: Math.min(2, room.volume * globalVolume),
    muted: !focused || !soundEnabled,
  });
  const recording = useRoomRecording(player.mediaElement, replayEnabled, replaySeconds);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [highlight, setHighlight] = useState<{
    blob: Blob;
    seconds: number;
    messages: DanmakuMessage[];
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // 把本房间的回溯缓冲上报到全局统计，供「存储设置」弹窗汇总展示。
  useEffect(() => {
    setRoomReplayStats(room.key, {
      bytes: recording.bufferedBytes,
      seconds: recording.bufferedSeconds,
    });
  }, [room.key, recording.bufferedBytes, recording.bufferedSeconds]);

  useEffect(() => () => clearRoomReplayStats(room.key), [room.key]);

  useEffect(() => {
    if (!contextMenu) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (recording.error) toast(recording.error, "error");
  }, [recording.error, toast]);

  // 上报主播昵称 / 标题，供「独立录制」管理器显示。
  useEffect(() => {
    setRoomMeta(room.key, {
      nickname: info?.nickname ?? "",
      title: info?.title ?? "",
    });
  }, [room.key, info?.nickname, info?.title]);

  useEffect(() => () => clearRoomMeta(room.key), [room.key]);

  const openHighlight = () => {
    setContextMenu(null);
    const blob = recording.replayBlob();
    if (!blob) {
      toast("回溯缓冲尚未准备好", "info");
      return;
    }
    setHighlight({
      blob,
      seconds: recording.bufferedSeconds,
      messages: [...messages],
    });
  };

  const openRecordingManager = () => {
    setContextMenu(null);
    window.dispatchEvent(
      new CustomEvent("dtv:open-recording-manager", { detail: { key: room.key } }),
    );
  };

  // 右键「分享主播」：复制规范直播间链接，可直接粘贴回添加框或发给别人。
  const shareRoom = async () => {
    setContextMenu(null);
    const url = liveRoomShareUrl(room.platform, room.roomId);
    const name = info?.nickname || `房间 ${room.roomId}`;
    try {
      await navigator.clipboard.writeText(url);
      toast(`已复制 ${name} 的直播间链接`, "success");
    } catch {
      toast("复制失败，请检查系统剪贴板权限", "error");
    }
  };

  // 右键「关注主播 / 取消关注」：与侧边栏关注列表同步。
  const toggleFollowRoom = () => {
    setContextMenu(null);
    toggleFollow({
      id: room.roomId,
      platform: room.platform,
      nickname: info?.nickname || `房间 ${room.roomId}`,
      title: info?.title ?? "",
      cover: "",
      avatar: info?.avatar ?? "",
      viewers: 0,
      categoryName: "",
      isLive: info?.isLive ?? true,
      isLoop: info?.isLoop,
    });
  };

  // 未关注的主播先自动关注，才能进侧边栏文件夹。
  const ensureFollowed = () => {
    if (isFollowing(room.platform, room.roomId)) return;
    toggleFollow({
      id: room.roomId,
      platform: room.platform,
      nickname: info?.nickname || `房间 ${room.roomId}`,
      title: info?.title ?? "",
      cover: "",
      avatar: info?.avatar ?? "",
      viewers: 0,
      categoryName: "",
      isLive: info?.isLive ?? true,
      isLoop: info?.isLoop,
    });
  };

  const assignToFolder = (folderId: string) => {
    const folder = folders.find((item) => item.id === folderId);
    if (!folder) return;
    ensureFollowed();
    moveToFolder(room.key, folderId);
    onGroupChange(room.key, folder.name);
    toast(`已移入文件夹「${folder.name}」，侧边栏关注列表已同步`, "success");
  };

  const createAndAssign = (name: string) => {
    const existing = folders.find((folder) => folder.name === name);
    if (existing) {
      assignToFolder(existing.id);
      return;
    }
    const folderId = createFolder(name);
    if (!folderId) return;
    ensureFollowed();
    moveToFolder(room.key, folderId);
    onGroupChange(room.key, name);
    toast(`已创建文件夹「${name}」并移入，侧边栏关注列表已同步`, "success");
  };

  const removeFromGroup = () => {
    if (currentFolder) removeFromFolder(room.key, currentFolder.id);
    onGroupChange(room.key, "");
  };

  const beginResize = (event: PointerEvent<HTMLButtonElement>, direction: ResizeDirection) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    event.stopPropagation();
    const tile = tileRef.current;
    if (!tile || resizeGestureRef.current) return;
    const rect = tile.getBoundingClientRect();
    const computed = getComputedStyle(tile.parentElement ?? tile);
    const gapX = Number.parseFloat(computed.columnGap) || 0;
    const gapY = Number.parseFloat(computed.rowGap) || 0;
    const cellWidth = (rect.width - gapX * (placement.columns - 1)) / placement.columns;
    const cellHeight = (rect.height - gapY * (placement.rows - 1)) / placement.rows;
    const startPlacement = {
      column: placement.column,
      row: placement.row,
      columns: placement.columns,
      rows: placement.rows,
    };
    resizeGestureRef.current = {
      pointerId: event.pointerId,
      direction,
      startX: event.clientX,
      startY: event.clientY,
      startPlacement,
      lastPlacement: startPlacement,
      stepX: Math.max(1, cellWidth + gapX),
      stepY: Math.max(1, cellHeight + gapY),
    };
    setResizing(true);
    onDraggingChangeRef.current(room.key, true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  /** 清空失败计数并撤销尚未触发的退避定时器。 */
  const resetRecovery = useCallback(() => {
    reconnectAttemptRef.current = 0;
    lastRecoverAtRef.current = 0;
    if (backoffTimerRef.current != null) {
      window.clearTimeout(backoffTimerRef.current);
      backoffTimerRef.current = null;
    }
  }, []);

  /* 手动切换清晰度 / 线路、播放成功、组件卸载 = 新的开始。 */
  useEffect(() => {
    resetRecovery();
  }, [room.qualityId, room.lineId, resetRecovery]);
  useEffect(() => () => resetRecovery(), [resetRecovery]);

  /* 错误回调里读最新的档位信息（effect 只按 errorNonce/state 重跑，
   * 与 useXgPlayer 的重建节奏保持一致，避免切档位时误计一次失败）。 */
  const qualityFallbackRef = useRef({
    qualityId: room.qualityId,
    nickname: info?.nickname ?? "",
    onQualityChange,
  });
  qualityFallbackRef.current = {
    qualityId: room.qualityId,
    nickname: info?.nickname ?? "",
    onQualityChange,
  };

  /* 线路自愈用的状态：已试过的坏线路集合 + 卡住看门狗定时器 + 换线函数。
   * 换线函数读最新的 info/room（用 ref 承载，避免 effect 闭包过期）。 */
  const stallTriedRef = useRef<Set<string>>(new Set());
  const stallWatchdogRef = useRef<number | null>(null);
  const switchToNextLineRef = useRef<() => boolean>(() => false);
  switchToNextLineRef.current = () => {
    const lines = info?.lines ?? [];
    if (!info || lines.length <= 1) return false;
    const currentId = (lines.find((l) => l.id === room.lineId) ?? lines[0]).id;
    stallTriedRef.current.add(currentId);
    const next = lines.find((l) => !stallTriedRef.current.has(l.id));
    if (!next) return false;
    toast(
      `${info.nickname || `房间 ${room.roomId}`}：当前线路卡顿，已切换到「${next.label}」`,
      "info",
    );
    onLineChange(room.key, next.id);
    return true;
  };

  /* 异常自愈统一入口。错误 / 持续缓冲 / 取流失败都走这里：
   *   前两次立即重新取流；再失败依次换线、回退清晰度；都不可用时
   *   2s→4s→8s→16s→30s 退避。
   *
   * 每次自愈都显式 bump retryKey —— 不能依赖"URL 可能变了"：若回退后的
   * 自动档恰好等于原档位，URL 不变会让 useXgPlayer 不重建，播放器永远停在 error。 */
  recoverRef.current = (reason: string) => {
    const now = Date.now();
    // 播放器 error 与看门狗可能在同一次故障里先后触发，短时间内只处理一次。
    // 取流失败是独立的链路（播放器此时已销毁），不能被前一次恢复节流挡掉，
    // 否则一次"播放出错 → 重新取流也失败"会永久停摆。
    if (reason !== "取流失败" && now - lastRecoverAtRef.current < RECOVER_THROTTLE_MS) return;
    lastRecoverAtRef.current = now;
    if (backoffTimerRef.current != null) {
      window.clearTimeout(backoffTimerRef.current);
      backoffTimerRef.current = null;
    }

    reconnectAttemptRef.current += 1;
    const attempt = reconnectAttemptRef.current;
    const refresh = () => setRetryKey((key) => key + 1);

    if (attempt <= 2) {
      console.info(`[recover] ${reason}：立即重新取流（${attempt}/2）`);
      reportLiveEvent("recover", room.platform, room.roomId, `${reason} attempt=${attempt} action=retry-now`);
      refresh();
      return;
    }
    // 刷新 >2 次：换一条没试过的线路。
    if (switchToNextLineRef.current()) {
      resetRecovery();
      reportLiveEvent("recover", room.platform, room.roomId, `${reason} attempt=${attempt} action=switch-line`);
      refresh();
      return;
    }
    // 没有可换的线路：手动选过清晰度时回退自动档。
    const fallback = qualityFallbackRef.current;
    if (fallback.qualityId) {
      resetRecovery();
      reportLiveEvent("recover", room.platform, room.roomId, `${reason} attempt=${attempt} action=fallback-quality`);
      fallback.onQualityChange(room.key, "");
      refresh();
      toast(
        `${fallback.nickname || `房间 ${room.roomId}`}：所选清晰度暂不可用，已切回默认清晰度`,
        "info",
      );
      return;
    }
    // 已无线路/档位可换：退避刷新，避免对永久失效的流疯狂打上游。
    const delay = recoveryDelay(attempt);
    console.info(`[recover] ${reason}：${delay / 1000}s 后重试`);
    reportLiveEvent("recover", room.platform, room.roomId, `${reason} attempt=${attempt} action=backoff delayMs=${delay}`);
    backoffTimerRef.current = window.setTimeout(() => {
      backoffTimerRef.current = null;
      refresh();
    }, delay);
  };

  useEffect(() => {
    if (player.state === "playing") {
      resetRecovery();
      return;
    }
    if (player.state !== "error") return;
    reportLiveEvent("player.error", room.platform, room.roomId, player.error ?? "播放器错误");
    recoverRef.current("播放器断开");
  }, [player.errorNonce, player.state, resetRecovery, room.platform, room.roomId, player.error]);

  /* ---------------------------------------------------- 线路自愈（卡住换线）
   * 实测：虎牙 TX CDN 会给特定房间返回损坏的 FLV（头声明纯视频却混着音频
   * tag，且立刻断连），xgplayer 按头建纯视频缓冲，播几秒就卡死且不再恢复；
   * 同房间切到 AL 线路即正常。这类坏线路不会必然报 error，可能一直停在
   * buffering/loading，所以需要一个看门狗：持续缓冲/加载超时就换下一条线路。
   * 已试遍所有线路则重置后重新取流（等网络/上游恢复），避免无限换线循环。 */
  useEffect(() => {
    const clear = () => {
      if (stallWatchdogRef.current != null) {
        window.clearTimeout(stallWatchdogRef.current);
        stallWatchdogRef.current = null;
      }
    };
    if (player.state === "playing") {
      stallTriedRef.current = new Set();
      resetRecovery();
      clear();
      return;
    }
    // 只对直播生效；轮播/未开播的加载不触发换线。
    if (!info?.isLive || info.isLoop) {
      clear();
      return;
    }
    if (player.state !== "buffering" && player.state !== "loading") {
      clear();
      return;
    }
    // 播过再卡（buffering）8s 即判卡；首次加载（loading）放宽到 15s，
    // 避免慢网正常起播被误判换线。
    const delay = player.state === "buffering" ? 8_000 : 15_000;
    clear();
    stallWatchdogRef.current = window.setTimeout(() => {
      stallWatchdogRef.current = null;
      // 与出错走同一套自愈：先刷新，刷新 >2 次再换线。
      recoverRef.current("播放卡住");
    }, delay);
    return clear;
  }, [player.state, info?.isLive, info?.isLoop, resetRecovery]);

  /* 已确认为离线 / 无可用档位时每 30s 探测一次。
   * 旧播放页的"30 秒自动刷新"在多房间重构中丢失，曾导致一次瞬时 offline
   * 就让卡片永久停在空态；取流失败（infoError）由自愈退避负责，不叠加轮询。 */
  useEffect(() => {
    if (!info || infoError) return;
    if (info.isLive && variant) return;
    const timer = window.setInterval(() => setRetryKey((key) => key + 1), OFFLINE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [info, infoError, variant]);

  /* 登录态变化后重新取流：B 站 403 / 斗鱼高低档切换都依赖登录 Cookie。 */
  useEffect(() => {
    if (room.platform !== "douyu" && room.platform !== "bilibili") return;
    const refresh = () => setRetryKey((key) => key + 1);
    window.addEventListener(BILIBILI_AUTH_EVENT, refresh);
    window.addEventListener(DOUYU_AUTH_EVENT, refresh);
    return () => {
      window.removeEventListener(BILIBILI_AUTH_EVENT, refresh);
      window.removeEventListener(DOUYU_AUTH_EVENT, refresh);
    };
  }, [room.platform]);

  /* 轮播稿件自然播完：重新取流拿下一条。 */
  useEffect(() => {
    if (!player.endedNonce || !info?.isLoop) return;
    setRetryKey((key) => key + 1);
  }, [player.endedNonce, info?.isLoop]);

  useEffect(() => {
    if (!info?.roomId || !room.danmakuEnabled) {
      setMessages([]);
      messageBufferRef.current = [];
      return;
    }
    const flush = window.setInterval(() => {
      if (messageBufferRef.current.length === 0) return;
      const batch = messageBufferRef.current;
      messageBufferRef.current = [];
      setMessages((previous) => [...previous, ...batch].slice(-MAX_MESSAGES));
    }, MESSAGE_FLUSH_MS);
    const unsubscribe = api.subscribeDanmaku(info.platform, info.roomId, (message) => {
      if (isDanmuBlocked(message.content, blockKeywordsLowerRef.current)) return;
      const buffer = messageBufferRef.current;
      buffer.push(message);
      if (buffer.length > MAX_MESSAGES) buffer.splice(0, buffer.length - MAX_MESSAGES);
    });
    return () => {
      window.clearInterval(flush);
      messageBufferRef.current = [];
      unsubscribe();
    };
  }, [info?.platform, info?.roomId, room.danmakuEnabled]);

  useEffect(() => {
    const tile = tileRef.current;
    if (!tile) return;
    const handleWheel = (event: globalThis.WheelEvent) => {
      if (!event.ctrlKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest("button, input, select, label")) return;
      event.preventDefault();
      const delta = event.deltaY < 0 ? 1 : -1;
      const columns = Math.max(
        1,
        Math.min(4, room.size.columns + delta),
      ) as MonitorTileSize["columns"];
      const rows = Math.max(1, Math.min(4, room.size.rows + delta)) as MonitorTileSize["rows"];
      if (columns !== room.size.columns || rows !== room.size.rows) {
        onResize(room.key, { columns, rows });
      }
    };
    tile.addEventListener("wheel", handleWheel, { passive: false });
    return () => tile.removeEventListener("wheel", handleWheel);
  }, [onResize, room.key, room.size.columns, room.size.rows]);

  // 右键菜单必须用捕获阶段的原生监听：xgplayer 的 PC 插件在 video 上
  // 注册了 contextmenu → preventDefault + stopPropagation，冒泡阶段的
  // React onContextMenu 在视频区域永远收不到事件。捕获阶段先于 video
  // 的监听器执行，任何区域右键都能弹出自定义菜单。
  useEffect(() => {
    const tile = tileRef.current;
    if (!tile) return;
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      setContextMenu({
        x: Math.min(event.clientX, window.innerWidth - 236),
        y: Math.min(event.clientY, window.innerHeight - 200),
      });
    };
    tile.addEventListener("contextmenu", handleContextMenu, true);
    return () => tile.removeEventListener("contextmenu", handleContextMenu, true);
  }, []);

  /* ------------------------------------------- 悬浮 chrome 的空闲自动隐藏
   * 卡片的显隐原本纯靠 CSS :hover —— 鼠标停在卡片上不动时 chrome 永远常显。
   * 用户要求：鼠标静止 2s 就隐藏顶部主播信息 + 底部控制条。
   * 这里监听卡片内的鼠标活动，静止超时后给 PlayerChrome 传 hidden
   *（.hidden 带 !important，能压过 :hover / :focus-within 的常显规则）。
   * 弹层打开 / 拖拽缩放中 / 非播放态不隐藏（暂停时保留"找得到播放键"的设计）。 */
  const [chromeHidden, setChromeHidden] = useState(false);
  const [chromeMenuOpen, setChromeMenuOpen] = useState(false);
  /** 每次进入空闲隐藏 +1：通知 chrome 收掉悬停展开的下拉/面板 */
  const [chromeCloseSignal, setChromeCloseSignal] = useState(0);
  const chromeIdleTimerRef = useRef<number | null>(null);
  const chromeIdleBlocked =
    player.state !== "playing" ||
    chromeMenuOpen ||
    Boolean(contextMenu) ||
    groupDialogOpen ||
    Boolean(highlight) ||
    longPressDragging ||
    resizing;

  useEffect(() => {
    const tile = tileRef.current;
    const clearTimer = () => {
      if (chromeIdleTimerRef.current != null) {
        window.clearTimeout(chromeIdleTimerRef.current);
        chromeIdleTimerRef.current = null;
      }
    };
    if (!tile || chromeIdleBlocked) {
      clearTimer();
      setChromeHidden(false);
      return clearTimer;
    }
    const arm = () => {
      clearTimer();
      chromeIdleTimerRef.current = window.setTimeout(() => {
        chromeIdleTimerRef.current = null;
        setChromeHidden(true);
        setChromeCloseSignal((n) => n + 1);
      }, CHROME_IDLE_MS);
    };
    const onActivity = () => {
      setChromeHidden(false);
      arm();
    };
    // 鼠标离开卡片：交还给 CSS :not(:hover) 隐藏，复位状态等下次进入重新计时
    const onLeave = () => {
      clearTimer();
      setChromeHidden(false);
    };
    // 捕获阶段监听：xgplayer / 弹幕层可能在中途 stopPropagation，
    // 冒泡阶段会漏掉鼠标活动。
    tile.addEventListener("mousemove", onActivity, { passive: true, capture: true });
    tile.addEventListener("mousedown", onActivity, { passive: true, capture: true });
    tile.addEventListener("pointermove", onActivity, { passive: true, capture: true });
    tile.addEventListener("pointerleave", onLeave);
    arm();
    return () => {
      tile.removeEventListener("mousemove", onActivity, { capture: true });
      tile.removeEventListener("mousedown", onActivity, { capture: true });
      tile.removeEventListener("pointermove", onActivity, { capture: true });
      tile.removeEventListener("pointerleave", onLeave);
      clearTimer();
    };
  }, [chromeIdleBlocked]);

  const displayName = info?.nickname || `房间 ${room.roomId}`;
  const active = room.danmakuEnabled;
  const qualityOptions = (info?.variants ?? []).map((item) => ({
    id: item.id,
    label: /蓝光|bluray/i.test(item.label) ? "蓝光" : item.label,
  }));
  const activeLine = info?.lines.find((item) => item.id === room.lineId) ?? info?.lines[0];
  const toggleTileFullscreen = async () => {
    const tile = tileRef.current;
    if (!tile) return;
    try {
      if (document.fullscreenElement === tile) {
        await document.exitFullscreen();
      } else {
        await tile.requestFullscreen();
      }
    } catch (error) {
      toast(error instanceof Error ? `无法切换全屏：${error.message}` : "无法切换全屏", "error");
    }
  };

  return (
    <article
      ref={tileRef}
      onPointerDown={beginMove}
      className={cn(
        styles.tile,
        focused && styles.audioFocused,
        player.state === "playing" && styles.playing,
        info && !info.isLive && styles.offline,
        selected && styles.tileSelected,
        longPressDragging && styles.tileDragging,
        resizing && styles.resizing,
        dropTarget && styles.tileDropTarget,
        chromeHidden && styles.tileIdle,
        (windowFullscreen || tileFullscreen) && styles.tileFull,
      )}
      data-monitor-room-key={room.key}
      onClickCapture={(event) => {
        const target = event.target;
        if (event.button !== 0) return;
        // todo02：Ctrl+左键 = 多选切换，不触发音频焦点 / 播放交互
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          event.stopPropagation();
          onToggleSelect(room.key);
          return;
        }
        if (Date.now() - lastRoomDragEndedAt < 250) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (
          target instanceof Element &&
          target.closest("button, input, select, label, [role='slider'], [draggable='true']")
        )
          return;
        onAudioFocus(room.key, event.shiftKey);
      }}
      style={{
        gridColumn: windowFullscreen ? "1 / -1" : `${placement.column} / span ${placement.columns}`,
        gridRow: windowFullscreen ? "1 / -1" : `${placement.row} / span ${placement.rows}`,
        transform: longPressDragging
          ? `translate3d(${moveOffset.x}px, ${moveOffset.y}px, 0)`
          : undefined,
        zIndex: windowFullscreen ? 25 : undefined,
      }}
      aria-label={`${PLATFORM_LABEL[room.platform]}房间 ${room.roomId}`}
      aria-haspopup="menu"
    >
      <div className={styles.media}>
        <div ref={playerHostRef} className={styles.playerHost} />
        {/* 常驻合成哨兵：防止控制条隐藏后视频被提升成硬件叠加平面，
            盖住唤回的 header/footer（直播间全屏无按键的根因）。 */}
        <div className={styles.compositeGuard} aria-hidden="true" />
        {info?.isLive && (
          <DanmuOverlay
            messages={messages}
            enabled={active}
            settings={room.danmakuSettings}
            colorfulSupported={["douyu", "huya", "bilibili"].includes(room.platform)}
            platform={room.platform}
          />
        )}
        {danmakuPanelOpen && (
          <div className={styles.danmakuPanel}>
            <DanmuPanel
              messages={messages}
              platform={room.platform}
              width={240}
              onClose={() => setDanmakuPanelOpen(false)}
            />
          </div>
        )}
        {infoError || (info && !info.isLive) || (info?.isLive && !variant) ? (
          <div className={styles.status} role={infoError ? "alert" : "status"}>
            <span>{infoError || (!info?.isLive ? "当前未开播" : "暂无可播放清晰度")}</span>
            <button
              type="button"
              className={styles.retryButton}
              onClick={() => setRetryKey((key) => key + 1)}
            >
              重新获取
            </button>
          </div>
        ) : !info || player.state === "loading" ? (
          <div className={styles.status} role="status">
            正在连接直播间…
          </div>
        ) : null}
        {player.state === "error" && !infoError && (
          <div className={styles.playerError} role="status">
            播放中断，正在尝试重连
          </div>
        )}

        {/* 播放器 chrome（顶部信息栏 + 底部控制条），
            显隐由 .tile 的 :hover / :focus-within CSS 驱动；
            鼠标停在卡片上静止 2s 再由宿主加 hidden 淡出。 */}
        <PlayerChrome
          platform={room.platform}
          roomId={room.roomId}
          nickname={displayName}
          groupBadge={currentFolder?.name}
          hidden={chromeHidden}
          closeSignal={chromeCloseSignal}
          onMenuOpenChange={setChromeMenuOpen}
          onClose={() => onRemove(room.key)}
          closeTitle="从工作台移除（独立录制不受影响）"
          closeLabel="移除房间"
          playState={player.state}
          playDisabled={!info?.isLive}
          playTitle={player.state === "paused" ? "继续播放" : "暂停"}
          onTogglePlay={player.togglePlay}
          onReload={() => setRetryKey((key) => key + 1)}
          volume={room.volume}
          volumeMax={2}
          volumeLabel="房间音量"
          onVolume={(volume) => {
            if (volume > 1) player.activateAudioBoost();
            onVolumeChange(room.key, volume);
          }}
          volumeActive={focused}
          volumeIconByActive
          volumeButtonTitle={focused ? "关闭本房间声音" : "开启本房间声音"}
          volumeButtonLabel={focused ? "关闭本房间声音" : "开启本房间声音"}
          onVolumeButton={() => {
            if (room.volume > 1) player.activateAudioBoost();
            onAudioFocus(room.key, true);
          }}
          boostWarning={room.volume > 1 && !player.audioBoostSupported}
          danmuEnabled={room.danmakuEnabled}
          onToggleDanmu={() => onDanmakuToggle(room.key)}
          danmuSettings={room.danmakuSettings}
          onDanmuSettingsChange={(patch) => onDanmakuSettingsChange(room.key, patch)}
          colorfulSupported={["douyu", "huya", "bilibili"].includes(room.platform)}
          blockKeywords={blockKeywords}
          onAddBlockKeyword={onAddBlockKeyword}
          onRemoveBlockKeyword={onRemoveBlockKeyword}
          onClearBlockKeywords={onClearBlockKeywords}
          danmuPanelOpen={danmakuPanelOpen}
          onToggleDanmuPanel={() => setDanmakuPanelOpen((open) => !open)}
          lines={info?.lines ?? []}
          lineId={activeLine?.id ?? ""}
          onLine={(lineId) => onLineChange(room.key, lineId)}
          qualities={qualityOptions}
          qualityId={variant?.id ?? ""}
          qualityLabel={variant?.label ?? "清晰度"}
          onQuality={(qualityId) => onQualityChange(room.key, qualityId)}
          windowFullscreen={windowFullscreen}
          onToggleWindowFullscreen={() => onToggleWindowFullscreen(room.key)}
          fullscreen={tileFullscreen}
          onToggleFullscreen={() => void toggleTileFullscreen()}
        />
        {RESIZE_HANDLES.map(({ direction, className, label }) => (
          <button
            key={direction}
            type="button"
            className={cn(styles.resizeHandle, className)}
            onPointerDown={(event) => beginResize(event, direction)}
            aria-label={label}
            title={label}
          />
        ))}
        {contextMenu &&
          createPortal(
            <div
              ref={contextMenuRef}
              className={styles.contextMenu}
              role="menu"
              aria-label={`${displayName}房间操作`}
              style={{
                left: Math.max(8, contextMenu.x),
                top: Math.max(8, contextMenu.y),
              }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <div className={styles.contextMenuTitle}>
                {currentFolder ? `分组：${currentFolder.name}` : "直播间操作"}
              </div>
              <button type="button" role="menuitem" onClick={toggleFollowRoom}>
                <Star
                  size={14}
                  fill={isFollowing(room.platform, room.roomId) ? "currentColor" : "none"}
                />
                {isFollowing(room.platform, room.roomId) ? "取消关注" : "关注主播"}
              </button>
              <button type="button" role="menuitem" onClick={() => void shareRoom()}>
                <Share2 size={14} />
                分享主播
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  setGroupDialogOpen(true);
                }}
              >
                <FolderPlus size={14} />
                添加分组…
              </button>
              <button type="button" role="menuitem" onClick={openRecordingManager}>
                <Video size={14} />
                独立录制…
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!replayEnabled || recording.bufferedSeconds === 0}
                onClick={openHighlight}
              >
                <History size={14} />
                回溯精彩…
              </button>
              <div className={styles.contextMenuFooter}>
                {replayEnabled
                  ? `回溯缓存 ${recording.bufferedSeconds}/${replaySeconds} 秒`
                  : "请在设置中开启回溯功能"}
              </div>
            </div>,
            portalHost,
          )}
        {groupDialogOpen && (
          <GroupAssignDialog
            folders={folders}
            currentFolderId={currentFolder?.id}
            roomLabel={`${PLATFORM_LABEL[room.platform]} · ${displayName} · ${room.roomId}`}
            onAssign={assignToFolder}
            onCreateAndAssign={createAndAssign}
            onRemove={removeFromGroup}
            onClose={() => setGroupDialogOpen(false)}
          />
        )}
        {highlight && (
          <ReplayHighlightModal
            blob={highlight.blob}
            bufferedSeconds={highlight.seconds}
            messages={highlight.messages}
            nickname={displayName}
            title={info?.title ?? ""}
            onClose={() => setHighlight(null)}
          />
        )}
      </div>
    </article>
  );
}
