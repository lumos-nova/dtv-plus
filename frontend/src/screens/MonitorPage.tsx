import { Check, Grid2X2 } from "lucide-react";
import { useEffect, useCallback, useMemo, useRef, useState, type DragEvent } from "react";
import { Events } from "@wailsio/runtime";
import { LIVE_PLATFORMS, PLATFORM_LABEL, type LivePlatform } from "@/api";
import { useLocation, useNavigate } from "react-router-dom";
import { RoomTile } from "@/features/multiview/RoomTile";
import { RecordingManagerModal } from "@/features/multiview/RecordingManagerModal";
import { useDanmuBlock } from "@/features/player/useDanmuBlock";
import {
  DEFAULT_DANMU_SETTINGS,
  loadDanmuPreferences,
  normalizeDanmuSettings,
  type DanmuUserSettings,
} from "@/features/player/danmuSettings";
import {
  FOLLOW_ROOM_DRAG_TYPE,
  findFreePlacement,
  fitRoomGrid,
  gridPlacementsOverlap,
  moveRoomToCell,
  packRoomGrid,
  type GridPlacement,
  type GridPosition,
  type MonitorRoom,
  type MonitorTileSize,
} from "@/features/multiview/layout";
import { parseLiveRoomUrl } from "@/features/multiview/roomUrl";
import { useMonitorWorkspace } from "@/features/multiview/useMonitorWorkspace";
import { loadAppSettings, normalizeReplaySeconds } from "@/lib/appSettings";
import { cn } from "@/lib/cn";
import { useToast } from "@/state/ToastProvider";
import { isWailsRuntime } from "@/lib/window";
import styles from "./MonitorPage.module.css";

const MAX_ROOMS = 16;

function platformLabel(platform: LivePlatform): string {
  return PLATFORM_LABEL[platform];
}

function droppedLink(event: DragEvent<HTMLElement>): string {
  const uriList = event.dataTransfer.getData("text/uri-list");
  const uri = uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  return uri || event.dataTransfer.getData("text/plain").trim();
}

export function MonitorPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { rooms, grid, audioFocusKeys, setWorkspace } = useMonitorWorkspace();
  const danmuBlock = useDanmuBlock();
  const { toast } = useToast();
  const [notice, setNotice] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [draggingRoom, setDraggingRoom] = useState(false);
  const [gridSelection, setGridSelection] = useState<{ cells: number[]; valid: boolean } | null>(
    null,
  );
  const [globalAudioEnabled, setGlobalAudioEnabled] = useState(
    () => loadAppSettings().globalAudioEnabled,
  );
  const [globalVolume, setGlobalVolume] = useState(() => loadAppSettings().globalVolume);
  const [replayEnabled, setReplayEnabled] = useState(() => loadAppSettings().replayEnabled);
  const [replaySeconds, setReplaySeconds] = useState(() => loadAppSettings().replaySeconds);
  const [windowFullscreenRoomKey, setWindowFullscreenRoomKey] = useState<string | null>(null);
  const [recordingManager, setRecordingManager] = useState<{
    open: boolean;
    preselect: string | null;
  }>({ open: false, preselect: null });
  // todo02：Ctrl+左键多选直播间；关闭按钮优先关选中，无选中才关全部
  const [selectedRoomKeys, setSelectedRoomKeys] = useState<Set<string>>(() => new Set());

  const toggleRoomSelected = useCallback((key: string) => {
    setSelectedRoomKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const gridRef = useRef<HTMLDivElement>(null);
  const previousAudioFocusRef = useRef<string[] | null>(null);
  const handledMonitorRequestRef = useRef<string | null>(null);
  const addRoomRef = useRef<(platform: LivePlatform, roomId: string) => void>(() => undefined);
  const placements = useMemo(() => packRoomGrid(rooms, grid), [grid, rooms]);

  // 房间右键「独立录制…」→ 打开录制管理器并预勾选该房间；
  // 后端录制异常 → 气泡通知（Wails 事件总线，录制不经过播放器）。
  useEffect(() => {
    const onOpenRecordingManager = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string }>).detail;
      setRecordingManager({ open: true, preselect: detail?.key ?? null });
    };
    window.addEventListener("dtv:open-recording-manager", onOpenRecordingManager);
    let off: (() => void) | null = null;
    if (isWailsRuntime()) {
      off = Events.On(
        "dtv:recording-error",
        (ev: { data?: { message?: string; nickname?: string } }) => {
          const detail = ev?.data;
          if (!detail?.message) return;
          toast(
            `独立录制异常${detail.nickname ? `（${detail.nickname}）` : ""}：${detail.message}`,
            "error",
          );
        },
      );
    }
    return () => {
      window.removeEventListener("dtv:open-recording-manager", onOpenRecordingManager);
      off?.();
    };
  }, [toast]);

  // 用户要求：右上角不再弹红色错误提示。保留调用点接口，静默忽略。
  const showError = (message: string) => {
    void message;
  };

  const clearError = () => {};

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const onReplayEnabled = (event: Event) => {
      const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
      if (typeof detail?.enabled === "boolean") setReplayEnabled(detail.enabled);
    };
    const onReplaySeconds = (event: Event) => {
      const detail = (event as CustomEvent<{ seconds?: number }>).detail;
      if (typeof detail?.seconds === "number") setReplaySeconds(normalizeReplaySeconds(detail.seconds));
    };
    const onVolume = (event: Event) => {
      const detail = (event as CustomEvent<{ volume?: number }>).detail;
      if (!detail || typeof detail.volume !== "number") return;
      setGlobalVolume(Math.max(0, Math.min(2, detail.volume)));
    };
    const onGlobalAudio = (event: Event) => {
      const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
      if (typeof detail?.enabled === "boolean") setGlobalAudioEnabled(detail.enabled);
    };
    const onDanmaku = (event: Event) => {
      const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
      if (!detail || typeof detail.enabled !== "boolean") return;
      const enabled = detail.enabled;
      setWorkspace((previous) => ({
        ...previous,
        rooms: previous.rooms.map((room) => ({ ...room, danmakuEnabled: enabled })),
      }));
    };
    const onDanmakuSettings = (event: Event) => {
      const detail = (event as CustomEvent<Partial<DanmuUserSettings>>).detail;
      if (!detail) return;
      setWorkspace((previous) => ({
        ...previous,
        rooms: previous.rooms.map((room) => ({
          ...room,
          danmakuSettings: normalizeDanmuSettings({
            ...room.danmakuSettings,
            ...detail,
          }),
        })),
      }));
    };
    window.addEventListener("dtv:global-volume", onVolume);
    window.addEventListener("dtv:replay-enabled", onReplayEnabled);
    window.addEventListener("dtv:replay-seconds", onReplaySeconds);
    window.addEventListener("dtv:global-audio", onGlobalAudio);
    window.addEventListener("dtv:global-danmaku", onDanmaku);
    window.addEventListener("dtv:global-danmaku-settings", onDanmakuSettings);
    return () => {
      window.removeEventListener("dtv:global-volume", onVolume);
      window.removeEventListener("dtv:replay-enabled", onReplayEnabled);
      window.removeEventListener("dtv:replay-seconds", onReplaySeconds);
      window.removeEventListener("dtv:global-audio", onGlobalAudio);
      window.removeEventListener("dtv:global-danmaku", onDanmaku);
      window.removeEventListener("dtv:global-danmaku-settings", onDanmakuSettings);
    };
  }, [setWorkspace]);

  /**
   * 退出工作台内全屏并恢复进入前的音频焦点。
   * 纯 CSS 展开（不再动操作系统窗口），没有原生全屏事件可依赖，
   * 所有退出路径（再点按钮 / 移除房间 / 关闭全部 / 加新房间 / Esc）都直接走这里。
   */
  const exitWindowFullscreenForRoom = useCallback(() => {
    const previousAudioFocus = previousAudioFocusRef.current;
    previousAudioFocusRef.current = null;
    setWindowFullscreenRoomKey(null);
    if (previousAudioFocus) {
      setWorkspace((previous) => ({
        ...previous,
        audioFocusKeys: previousAudioFocus.filter((key) =>
          previous.rooms.some((room) => room.key === key),
        ),
      }));
    }
  }, [setWorkspace]);

  // Esc：清空多选；处于工作台内全屏时同时退出（与播放页 Esc 退全屏的习惯一致）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSelectedRoomKeys(new Set());
      exitWindowFullscreenForRoom();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exitWindowFullscreenForRoom]);

  useEffect(() => {
    const closeAllRooms = () => {
      const selected = selectedRoomKeys;
      setWorkspace((previous) => {
        const rooms =
          selected.size > 0 ? previous.rooms.filter((room) => !selected.has(room.key)) : [];
        return {
          ...previous,
          rooms,
          audioFocusKeys: previous.audioFocusKeys.filter((key) =>
            rooms.some((room) => room.key === key),
          ),
        };
      });
      setNotice(selected.size > 0 ? `已关闭 ${selected.size} 个选中直播间` : "已关闭所有直播间");
      setSelectedRoomKeys(new Set());
      exitWindowFullscreenForRoom();
    };
    window.addEventListener("dtv:monitor-close-all", closeAllRooms);
    return () => window.removeEventListener("dtv:monitor-close-all", closeAllRooms);
  }, [setWorkspace, selectedRoomKeys, exitWindowFullscreenForRoom]);

  const addRoom = (platform: LivePlatform, rawRoomId: string) => {
    const roomId = rawRoomId.replace(/^0+(?=\d)/, "");
    const key = `${platform}:${roomId}`;
    if (rooms.some((room) => room.key === key)) {
      setNotice(`${platformLabel(platform)}房间 ${roomId} 已在工作台中`);
      clearError();
      return;
    }
    if (rooms.length >= MAX_ROOMS) {
      showError("工作台最多同时监看 16 个不同房间");
      setNotice("");
      return;
    }

    // 打开新直播时若已有卡片处于工作台内全屏：把该卡片缩到最小（1×1）
    // 再添加新房间 —— 新直播不会被藏在全屏画面后面，原全屏卡片也不再
    // 占着大格子。缩小必须并入下面的 nextRooms 计算：单独 setWorkspace
    // 会被最终的 rooms 写入覆盖。
    const fullscreenKey = windowFullscreenRoomKey;
    const baseRooms: MonitorRoom[] = fullscreenKey
      ? rooms.map((room): MonitorRoom =>
          room.key === fullscreenKey ? { ...room, size: { columns: 1, rows: 1 } } : room,
        )
      : rooms;

    const danmakuPreferences = loadDanmuPreferences();
    const nextRooms: MonitorRoom[] = [
      ...baseRooms,
      {
        key,
        platform,
        roomId,
        size: { columns: 1, rows: 1 },
        lineId: "",
        volume: 0.7,
        danmakuEnabled: danmakuPreferences.enabled,
        danmakuSettings: { ...DEFAULT_DANMU_SETTINGS, ...danmakuPreferences.settings },
        qualityId: "",
      },
    ];
    const nextGrid = fitRoomGrid(nextRooms, grid);
    if (!nextGrid) {
      showError("当前网格无法容纳更多房间");
      setNotice("");
      return;
    }
    // 新房间落在第一个空格，其余房间冻结在当前格，避免加房时整体重排。
    const packed = packRoomGrid(nextRooms, nextGrid);
    const positionedRooms = packed
      ? nextRooms.map((room) => {
          const placement = packed.get(room.key);
          return placement
            ? { ...room, position: { column: placement.column, row: placement.row } }
            : room;
        })
      : nextRooms;
    // 退出工作台内全屏并恢复进入前的音频焦点（该卡片已在上面缩到 1×1）；
    // DOM 单卡全屏直接退出即可。
    if (fullscreenKey) exitWindowFullscreenForRoom();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    setWorkspace((previous) => ({
      ...previous,
      rooms: positionedRooms,
      grid: nextGrid,
      audioFocusKeys: previous.rooms.length === 0 ? [key] : previous.audioFocusKeys,
    }));
    clearError();
    setNotice(`${platformLabel(platform)}房间 ${roomId} 已加入工作台`);
  };
  addRoomRef.current = addRoom;

  useEffect(() => {
    if (!location.state || typeof location.state !== "object") return;
    const request = (location.state as Record<string, unknown>).dtvMonitorRoom;
    if (!request || typeof request !== "object") return;
    const payload = request as Record<string, unknown>;
    if (
      typeof payload.platform !== "string" ||
      !LIVE_PLATFORMS.includes(payload.platform as LivePlatform) ||
      typeof payload.roomId !== "string" ||
      !/^\d+$/.test(payload.roomId) ||
      handledMonitorRequestRef.current === location.key
    ) {
      return;
    }

    handledMonitorRequestRef.current = location.key;
    addRoomRef.current(payload.platform as LivePlatform, payload.roomId);
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: null,
    });
  }, [location.hash, location.key, location.pathname, location.search, location.state, navigate]);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const followPayload = event.dataTransfer.getData(FOLLOW_ROOM_DRAG_TYPE);
    if (followPayload) {
      event.preventDefault();
      event.stopPropagation();
      setDragOver(false);
      try {
        const value: unknown = JSON.parse(followPayload);
        if (
          !value ||
          typeof value !== "object" ||
          !("platform" in value) ||
          !("roomId" in value) ||
          typeof value.platform !== "string" ||
          typeof value.roomId !== "string" ||
          !/^\d+$/.test(value.roomId) ||
          !["douyu", "huya", "douyin", "bilibili"].includes(value.platform)
        ) {
          throw new Error("关注列表拖拽数据无效");
        }
        addRoom(value.platform as LivePlatform, value.roomId);
      } catch (reason) {
        showError(reason instanceof Error ? reason.message : "无法添加拖入的关注主播");
        setNotice("");
      }
      return;
    }

    const url = droppedLink(event);
    if (!url) return;
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
    clearError();
    setNotice("");
    try {
      const parsed = parseLiveRoomUrl(url);
      addRoom(parsed.platform, parsed.roomId);
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : "无法识别拖入的直播间链接");
    }
  };

  const gridCellAtPoint = (clientX: number, clientY: number): GridPosition | null => {
    const gridElement = gridRef.current;
    if (!gridElement) return null;
    const rect = gridElement.getBoundingClientRect();
    const style = window.getComputedStyle(gridElement);
    const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
    const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const paddingTop = Number.parseFloat(style.paddingTop) || 0;
    const gapX = Number.parseFloat(style.columnGap) || 0;
    const gapY = Number.parseFloat(style.rowGap) || 0;
    const left = rect.left + borderLeft + paddingLeft;
    const top = rect.top + borderTop + paddingTop;
    const trackSizes = (rawTracks: string, count: number, extent: number, gap: number) => {
      const tracks = rawTracks.split(/\s+/).map((value) => Number.parseFloat(value));
      if (tracks.length === count && tracks.every(Number.isFinite)) return tracks;
      const fallbackSize = Math.max(0, (extent - gap * (count - 1)) / count);
      return Array.from({ length: count }, () => fallbackSize);
    };
    const columns = trackSizes(
      style.gridTemplateColumns,
      grid.columns,
      gridElement.scrollWidth - borderLeft * 2 - paddingLeft * 2,
      gapX,
    );
    const rows = trackSizes(
      style.gridTemplateRows,
      grid.rows,
      gridElement.scrollHeight - borderTop * 2 - paddingTop * 2,
      gapY,
    );
    const trackAt = (
      coordinate: number,
      start: number,
      tracks: number[],
      gap: number,
      scrollOffset: number,
    ) => {
      let offset = coordinate - start + scrollOffset;
      for (let index = 0; index < tracks.length; index += 1) {
        const size = tracks[index] ?? 0;
        if (offset <= size) return index + 1;
        offset -= size;
        if (index < tracks.length - 1) {
          if (offset < gap) return index + 2;
          offset -= gap;
        }
      }
      return -1;
    };
    const column = trackAt(clientX, left, columns, gapX, gridElement.scrollLeft);
    const row = trackAt(clientY, top, rows, gapY, gridElement.scrollTop);
    if (
      clientX < left ||
      clientY < top ||
      column < 1 ||
      column > grid.columns ||
      row < 1 ||
      row > grid.rows
    ) {
      return null;
    }

    return { column, row };
  };

  const updateGridSelection = (key: string, clientX: number, clientY: number) => {
    const cell = gridCellAtPoint(clientX, clientY);
    const room = rooms.find((item) => item.key === key);
    const currentPlacement = placements?.get(key);
    if (!cell || !room || !currentPlacement || !placements) {
      setGridSelection(null);
      return;
    }

    const target = rooms.find((item) => {
      const placement = placements.get(item.key);
      return (
        placement &&
        cell.column >= placement.column &&
        cell.column < placement.column + placement.columns &&
        cell.row >= placement.row &&
        cell.row < placement.row + placement.rows
      );
    });

    let candidate: GridPlacement;
    let valid = true;
    if (target?.key === key) {
      candidate = currentPlacement;
    } else if (target) {
      const targetPlacement = placements.get(target.key);
      if (!targetPlacement) return;
      candidate = targetPlacement;
    } else {
      candidate = {
        column: Math.min(cell.column, grid.columns - room.size.columns + 1),
        row: Math.min(cell.row, grid.rows - room.size.rows + 1),
        columns: room.size.columns,
        rows: room.size.rows,
      };
      valid = ![...placements.entries()].some(
        ([otherKey, placement]) => otherKey !== key && gridPlacementsOverlap(candidate, placement),
      );
    }

    const cells = Array.from({ length: candidate.rows }, (_, rowOffset) =>
      Array.from(
        { length: candidate.columns },
        (_, columnOffset) =>
          (candidate.row + rowOffset - 1) * grid.columns + candidate.column + columnOffset - 1,
      ),
    ).flat();
    setGridSelection((previous) =>
      previous?.valid === valid &&
      previous.cells.length === cells.length &&
      previous.cells.every((selectedCell, index) => selectedCell === cells[index])
        ? previous
        : { cells, valid },
    );
  };

  const moveRoom = (fromKey: string, clientX: number, clientY: number) => {
    const cell = gridCellAtPoint(clientX, clientY);
    if (!cell) return;
    const result = moveRoomToCell(rooms, grid, fromKey, cell);
    if ("error" in result) {
      showError(result.error);
      setNotice("");
      return;
    }
    setWorkspace((previous) => ({ ...previous, rooms: result.rooms }));
    clearError();
  };

  /* 工作台内全屏：只让卡片铺满工作台内容区（RoomTile 的 CSS 展开），
   * 绝不触碰操作系统窗口 —— 不最大化、不盖任务栏。
   * 真正的系统级全屏是旁边的「直播间全屏」按钮（DOM Fullscreen API）。 */
  const toggleWindowFullscreenForRoom = (key: string) => {
    if (windowFullscreenRoomKey === key) {
      exitWindowFullscreenForRoom();
      return;
    }
    if (windowFullscreenRoomKey) return;
    previousAudioFocusRef.current = [...audioFocusKeys];
    setWindowFullscreenRoomKey(key);
    setWorkspace((previous) => ({ ...previous, audioFocusKeys: [key] }));
  };

  const handleResize = (key: string, size: MonitorTileSize, position?: GridPosition) => {
    const currentPlacements = packRoomGrid(rooms, grid);
    if (!currentPlacements) {
      showError("网格布局无效");
      setNotice("");
      return;
    }
    let nextPosition = position;
    if (!nextPosition) {
      // ctrl+滚轮：向任意有空间的方向扩（右/下被挡时向左/上等）。
      const free = findFreePlacement(rooms, grid, key, size);
      if (!free) {
        showError("周围没有足够空间，请先移动卡片或缩小尺寸");
        setNotice("");
        return;
      }
      nextPosition = { column: free.column, row: free.row };
    } else {
      const candidate = { ...nextPosition, ...size };
      const overlaps = [...currentPlacements.entries()].some(([otherKey, other]) => {
        if (otherKey === key) return false;
        return gridPlacementsOverlap(candidate, other);
      });
      if (overlaps) return;
    }

    // 其余房间冻结在当前格，避免隐式重排把别的卡片挤走。
    const nextRooms = rooms.map((room) => {
      const placement = currentPlacements.get(room.key);
      const frozen = placement
        ? { ...room, position: { column: placement.column, row: placement.row } }
        : room;
      return room.key === key ? { ...frozen, size, position: nextPosition } : frozen;
    });
    const nextGrid = fitRoomGrid(nextRooms, grid);
    if (!nextGrid) {
      showError("卡片尺寸与当前网格不兼容，请缩小卡片或扩大网格");
      setNotice("");
      return;
    }
    setWorkspace((previous) => ({ ...previous, rooms: nextRooms, grid: nextGrid }));
    clearError();
  };

  const handleAudioFocus = (key: string, multiple: boolean) => {
    setWorkspace((previous) => {
      if (!multiple) return { ...previous, audioFocusKeys: [key] };
      const selected = previous.audioFocusKeys.includes(key);
      return {
        ...previous,
        audioFocusKeys: selected
          ? previous.audioFocusKeys.filter((item) => item !== key)
          : [...previous.audioFocusKeys, key],
      };
    });
  };

  const updateRoom = (key: string, patch: Partial<MonitorRoom>) => {
    setWorkspace((previous) => ({
      ...previous,
      rooms: previous.rooms.map((room) => (room.key === key ? { ...room, ...patch } : room)),
    }));
  };

  const removeRoom = (key: string) => {
    if (windowFullscreenRoomKey === key) exitWindowFullscreenForRoom();
    setWorkspace((previous) => ({
      ...previous,
      rooms: previous.rooms.filter((room) => room.key !== key),
      audioFocusKeys: previous.audioFocusKeys.filter((roomKey) => roomKey !== key),
    }));
    clearError();
    setNotice("房间已从工作台移除");
  };

  const handleGridDrop = (event: DragEvent<HTMLDivElement>) => {
    setDragOver(false);
    handleDrop(event);
  };

  return (
    <section className={styles.page}>
      {notice && (
        <div className={styles.feedback} aria-live="polite">
          <p className={styles.notice}>
            <Check size={13} />
            {notice}
          </p>
        </div>
      )}

      {rooms.length === 0 ? (
        <div
          className={cn(styles.empty, dragOver && styles.dropActive)}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleGridDrop}
        >
          <div className={styles.emptyIcon}>
            <Grid2X2 size={22} />
          </div>
          <p className={styles.emptyTitle}>添加第一个直播间</p>
          <p className={styles.emptyHint}>将左侧关注列表中的主播拖到这里即可开始播放</p>
        </div>
      ) : (
        <div
          ref={gridRef}
          className={cn(styles.grid, dragOver && styles.dropActive)}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDragOver(true);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) setDragOver(false);
          }}
          onDrop={handleGridDrop}
        >
          {rooms.map((room) => {
            const placement = placements?.get(room.key);
            if (!placement) return null;
            return (
              <RoomTile
                key={room.key}
                room={room}
                placement={placement}
                replayEnabled={replayEnabled}
                replaySeconds={replaySeconds}
                selected={selectedRoomKeys.has(room.key)}
                onToggleSelect={toggleRoomSelected}
                focused={audioFocusKeys.includes(room.key)}
                soundEnabled={globalAudioEnabled}
                globalVolume={globalVolume}
                windowFullscreen={windowFullscreenRoomKey === room.key}
                onAudioFocus={handleAudioFocus}
                onToggleWindowFullscreen={toggleWindowFullscreenForRoom}
                onDanmakuToggle={(key) =>
                  setWorkspace((previous) => ({
                    ...previous,
                    rooms: previous.rooms.map((item) =>
                      item.key === key ? { ...item, danmakuEnabled: !item.danmakuEnabled } : item,
                    ),
                  }))
                }
                onDanmakuSettingsChange={(key, patch) =>
                  setWorkspace((previous) => ({
                    ...previous,
                    rooms: previous.rooms.map((item) =>
                      item.key === key
                        ? { ...item, danmakuSettings: { ...item.danmakuSettings, ...patch } }
                        : item,
                    ),
                  }))
                }
                blockKeywords={danmuBlock.keywords}
                blockKeywordsLower={danmuBlock.keywordsLower}
                onAddBlockKeyword={danmuBlock.addKeyword}
                onRemoveBlockKeyword={danmuBlock.removeKeyword}
                onClearBlockKeywords={danmuBlock.clearKeywords}
                onVolumeChange={(key, volume) => updateRoom(key, { volume })}
                onLineChange={(key, lineId) => updateRoom(key, { lineId })}
                onQualityChange={(key, qualityId) => updateRoom(key, { qualityId })}
                onRemove={removeRoom}
                onGroupChange={(key, group) =>
                  setWorkspace((previous) => ({
                    ...previous,
                    rooms: previous.rooms.map((item) =>
                      item.key === key ? { ...item, group: group || undefined } : item,
                    ),
                  }))
                }
                onMove={moveRoom}
                onDraggingChange={(_key, dragging) => {
                  setDraggingRoom(dragging);
                  if (!dragging) setGridSelection(null);
                }}
                onDragPositionChange={updateGridSelection}
                onResize={handleResize}
              />
            );
          })}
          {draggingRoom && (
            <div className={styles.gridGuideOverlay} aria-hidden="true">
              {Array.from({ length: 16 }, (_, index) => {
                const selected = gridSelection?.cells.includes(index) ?? false;
                return (
                  <span
                    key={index}
                    className={cn(
                      styles.gridGuideCell,
                      selected && styles.gridGuideSelected,
                      selected && gridSelection && !gridSelection.valid && styles.gridGuideBlocked,
                    )}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}
      {recordingManager.open && (
        <RecordingManagerModal
          rooms={rooms}
          preselectKey={recordingManager.preselect}
          onClose={() => setRecordingManager({ open: false, preselect: null })}
        />
      )}
    </section>
  );
}
