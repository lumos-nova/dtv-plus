import { Check, Grid2X2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { PLATFORM_LABEL, type LivePlatform } from "@/api";
import { RoomTile } from "@/features/multiview/RoomTile";
import { useDanmuBlock } from "@/features/player/useDanmuBlock";
import {
  DEFAULT_DANMU_SETTINGS,
  loadDanmuPreferences,
  normalizeDanmuSettings,
  type DanmuUserSettings,
} from "@/features/player/danmuSettings";
import {
  FOLLOW_ROOM_DRAG_TYPE,
  fitRoomGrid,
  packRoomGrid,
  type MonitorRoom,
  type MonitorTileSize,
} from "@/features/multiview/layout";
import { parseLiveRoomUrl } from "@/features/multiview/roomUrl";
import { useMonitorWorkspace } from "@/features/multiview/useMonitorWorkspace";
import { loadAppSettings } from "@/lib/appSettings";
import { cn } from "@/lib/cn";
import {
  exitWindowFullscreen,
  isWailsRuntime,
  isWindowFullscreen,
  onWindowFullscreenChange,
  toggleWindowFullscreen,
} from "@/lib/window";
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
  const { rooms, grid, audioFocusKeys, setWorkspace } = useMonitorWorkspace();
  const danmuBlock = useDanmuBlock();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [globalAudioEnabled, setGlobalAudioEnabled] = useState(
    () => loadAppSettings().globalAudioEnabled,
  );
  const [globalVolume, setGlobalVolume] = useState(() => loadAppSettings().globalVolume);
  const [windowFullscreenRoomKey, setWindowFullscreenRoomKey] = useState<string | null>(null);
  const errorTimerRef = useRef<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const previousAudioFocusRef = useRef<string[] | null>(null);
  const placements = useMemo(() => packRoomGrid(rooms, grid), [grid, rooms]);

  const showError = (message: string) => {
    if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
    setError(message);
    errorTimerRef.current = window.setTimeout(() => {
      errorTimerRef.current = null;
      setError("");
    }, 1_000);
  };

  const clearError = () => {
    if (errorTimerRef.current !== null) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    setError("");
  };

  useEffect(
    () => () => {
      if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
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
    window.addEventListener("dtv:global-audio", onGlobalAudio);
    window.addEventListener("dtv:global-danmaku", onDanmaku);
    window.addEventListener("dtv:global-danmaku-settings", onDanmakuSettings);
    return () => {
      window.removeEventListener("dtv:global-volume", onVolume);
      window.removeEventListener("dtv:global-audio", onGlobalAudio);
      window.removeEventListener("dtv:global-danmaku", onDanmaku);
      window.removeEventListener("dtv:global-danmaku-settings", onDanmakuSettings);
    };
  }, [setWorkspace]);

  useEffect(() => {
    const closeAllRooms = () => {
      setWorkspace((previous) => ({
        ...previous,
        rooms: [],
        audioFocusKeys: [],
      }));
      setNotice("已关闭所有直播间");
      if (previousAudioFocusRef.current) void exitWindowFullscreen();
      previousAudioFocusRef.current = null;
      setWindowFullscreenRoomKey(null);
      if (errorTimerRef.current !== null) {
        window.clearTimeout(errorTimerRef.current);
        errorTimerRef.current = null;
      }
      setError("");
    };
    window.addEventListener("dtv:monitor-close-all", closeAllRooms);
    return () => window.removeEventListener("dtv:monitor-close-all", closeAllRooms);
  }, [setWorkspace]);

  useEffect(
    () =>
      onWindowFullscreenChange(() => {
        void isWindowFullscreen().then((fullscreen) => {
          if (fullscreen || previousAudioFocusRef.current === null) return;
          const previousAudioFocus = previousAudioFocusRef.current;
          previousAudioFocusRef.current = null;
          setWindowFullscreenRoomKey(null);
          setWorkspace((previous) => ({
            ...previous,
            audioFocusKeys: previousAudioFocus.filter((key) =>
              previous.rooms.some((room) => room.key === key),
            ),
          }));
        });
      }),
    [setWorkspace],
  );

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

    const danmakuPreferences = loadDanmuPreferences();
    const nextRooms: MonitorRoom[] = [
      ...rooms,
      {
        key,
        platform,
        roomId,
        size: { columns: 1, rows: 1 },
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
    setWorkspace((previous) => ({
      ...previous,
      rooms: nextRooms,
      grid: nextGrid,
      audioFocusKeys: previous.rooms.length === 0 ? [key] : previous.audioFocusKeys,
    }));
    clearError();
    setNotice(`${platformLabel(platform)}房间 ${roomId} 已加入工作台`);
  };

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

  const moveRoom = (fromKey: string, clientX: number, clientY: number) => {
    const gridElement = gridRef.current;
    if (!gridElement) return;
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
      return;
    }

    const from = rooms.find((room) => room.key === fromKey);
    const currentPlacements = packRoomGrid(rooms, grid);
    const fromPlacement = currentPlacements?.get(fromKey);
    if (!from || !currentPlacements || !fromPlacement) return;
    const target = rooms.find((room) => {
      const placement = currentPlacements?.get(room.key);
      return (
        placement &&
        column >= placement.column &&
        column < placement.column + placement.columns &&
        row >= placement.row &&
        row < placement.row + placement.rows
      );
    });
    if (target?.key === fromKey) return;

    let nextRooms: MonitorRoom[];
    if (target) {
      const targetPlacement = currentPlacements?.get(target.key);
      if (!targetPlacement) return;
      nextRooms = rooms.map((room) => {
        if (room.key === fromKey) {
          return {
            ...room,
            position: { column: targetPlacement.column, row: targetPlacement.row },
            size: target.size,
          };
        }
        if (room.key === target.key) {
          return {
            ...room,
            position: { column: fromPlacement.column, row: fromPlacement.row },
            size: from.size,
          };
        }
        return room;
      });
    } else {
      const position = {
        column: Math.min(column, grid.columns - from.size.columns + 1),
        row: Math.min(row, grid.rows - from.size.rows + 1),
      };
      const overlapsRoom = rooms.some((room) => {
        if (room.key === fromKey) return false;
        const placement = currentPlacements.get(room.key);
        return (
          placement &&
          position.column < placement.column + placement.columns &&
          position.column + from.size.columns > placement.column &&
          position.row < placement.row + placement.rows &&
          position.row + from.size.rows > placement.row
        );
      });
      if (overlapsRoom) {
        showError("该位置无法容纳当前尺寸的直播间");
        setNotice("");
        return;
      }
      nextRooms = rooms.map((room) => (room.key === fromKey ? { ...room, position } : room));
      const nextPlacement = packRoomGrid(nextRooms, grid)?.get(fromKey);
      if (
        !nextPlacement ||
        nextPlacement.column !== position.column ||
        nextPlacement.row !== position.row
      ) {
        showError("该位置无法容纳当前尺寸的直播间");
        setNotice("");
        return;
      }
    }
    setWorkspace((previous) => ({ ...previous, rooms: nextRooms }));
  };

  const toggleWindowFullscreenForRoom = (key: string) => {
    if (!isWailsRuntime()) return;
    if (windowFullscreenRoomKey === key) {
      void toggleWindowFullscreen();
      return;
    }
    if (windowFullscreenRoomKey) return;
    previousAudioFocusRef.current = [...audioFocusKeys];
    setWindowFullscreenRoomKey(key);
    setWorkspace((previous) => ({ ...previous, audioFocusKeys: [key] }));
    void toggleWindowFullscreen();
  };

  const handleResize = (key: string, size: MonitorTileSize) => {
    const nextRooms = rooms.map((room) => (room.key === key ? { ...room, size } : room));
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
    if (windowFullscreenRoomKey === key) void exitWindowFullscreen();
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
      {(error || notice) && (
        <div className={styles.feedback} aria-live="polite">
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          {!error && notice && (
            <p className={styles.notice}>
              <Check size={13} />
              {notice}
            </p>
          )}
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
          style={{
            gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${grid.rows}, minmax(180px, 1fr))`,
          }}
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
                onQualityChange={(key, qualityId) => updateRoom(key, { qualityId })}
                onRemove={removeRoom}
                onMove={moveRoom}
                onResize={handleResize}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
