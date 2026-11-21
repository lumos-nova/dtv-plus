import type { LivePlatform } from "@/api";
import {
  DEFAULT_DANMU_SETTINGS,
  normalizeDanmuSettings,
  type DanmuUserSettings,
} from "../player/danmuSettings";

export interface MonitorGridSize {
  columns: 1 | 2 | 3 | 4;
  rows: 1 | 2 | 3 | 4;
}

export interface MonitorTileSize {
  columns: 1 | 2 | 3 | 4;
  rows: 1 | 2 | 3 | 4;
}

export interface GridPosition {
  column: number;
  row: number;
}

export interface MonitorRoom {
  key: string;
  platform: LivePlatform;
  roomId: string;
  position?: GridPosition;
  size: MonitorTileSize;
  lineId: string;
  volume: number;
  danmakuEnabled: boolean;
  danmakuSettings: DanmuUserSettings;
  qualityId: string;
}

export interface GridPlacement {
  column: number;
  row: number;
  columns: number;
  rows: number;
}

const MAX_GRID_SIZE = 4;
const MAX_ROOMS = 16;

export const FOLLOW_ROOM_DRAG_TYPE = "application/x-dtv-follow-room";

export function swapRoomPositionsAndSizes(
  rooms: readonly MonitorRoom[],
  fromKey: string,
  toKey: string,
): MonitorRoom[] {
  const next = [...rooms];
  const fromIndex = next.findIndex((room) => room.key === fromKey);
  const toIndex = next.findIndex((room) => room.key === toKey);
  const from = next[fromIndex];
  const to = next[toIndex];
  if (!from || !to || fromIndex === toIndex) return next;

  const movedTo = { ...to, size: from.size };
  const movedFrom = { ...from, size: to.size };
  if (from.position) movedTo.position = from.position;
  else delete movedTo.position;
  if (to.position) movedFrom.position = to.position;
  else delete movedFrom.position;
  next[fromIndex] = movedTo;
  next[toIndex] = movedFrom;
  return next;
}

function isRoomSize(value: unknown): value is MonitorTileSize {
  if (!value || typeof value !== "object") return false;
  const size = value as Record<string, unknown>;
  const validSizes = [1, 2, 3, 4];
  return validSizes.includes(size.columns as number) && validSizes.includes(size.rows as number);
}

function isGridPosition(value: unknown): value is GridPosition {
  if (!value || typeof value !== "object") return false;
  const position = value as Record<string, unknown>;
  return (
    Number.isInteger(position.column) &&
    Number.isInteger(position.row) &&
    Number(position.column) >= 1 &&
    Number(position.column) <= MAX_GRID_SIZE &&
    Number(position.row) >= 1 &&
    Number(position.row) <= MAX_GRID_SIZE
  );
}

export function packRoomGrid(
  rooms: readonly MonitorRoom[],
  grid: MonitorGridSize,
): Map<string, GridPlacement> | null {
  const occupied = Array.from({ length: grid.rows }, () =>
    Array.from({ length: grid.columns }, () => false),
  );
  const placements = new Map<string, GridPlacement>();
  const orderedRooms = [...rooms].sort(
    (a, b) => Number(Boolean(b.position)) - Number(Boolean(a.position)),
  );

  for (const room of orderedRooms) {
    if (room.size.columns > grid.columns || room.size.rows > grid.rows) return null;
    const columns = room.size.columns;
    const rows = room.size.rows;
    let placement: GridPlacement | null = null;

    const tryPlaceAt = (column: number, row: number): GridPlacement | null => {
      if (
        column < 1 ||
        row < 1 ||
        column + columns - 1 > grid.columns ||
        row + rows - 1 > grid.rows
      ) {
        return null;
      }
      for (let y = row - 1; y < row - 1 + rows; y += 1) {
        for (let x = column - 1; x < column - 1 + columns; x += 1) {
          if (occupied[y]?.[x]) return null;
        }
      }
      return { column, row, columns, rows };
    };

    if (room.position) {
      placement = tryPlaceAt(room.position.column, room.position.row);
    }

    for (let row = 1; row <= grid.rows - rows + 1 && !placement; row += 1) {
      for (let column = 1; column <= grid.columns - columns + 1; column += 1) {
        placement = tryPlaceAt(column, row);
        if (placement) break;
      }
    }

    if (!placement) return null;
    for (let y = placement.row - 1; y < placement.row - 1 + placement.rows; y += 1) {
      for (let x = placement.column - 1; x < placement.column - 1 + placement.columns; x += 1) {
        const row = occupied[y];
        if (row) row[x] = true;
      }
    }
    placements.set(room.key, placement);
  }

  return placements;
}

export function fitRoomGrid(
  rooms: readonly MonitorRoom[],
  preferred: MonitorGridSize,
): MonitorGridSize | null {
  const candidates: MonitorGridSize[] = [];
  for (let columns = 1; columns <= MAX_GRID_SIZE; columns += 1) {
    for (let rows = 1; rows <= MAX_GRID_SIZE; rows += 1) {
      const candidate = {
        columns: columns as MonitorGridSize["columns"],
        rows: rows as MonitorGridSize["rows"],
      };
      const positionsFit = rooms.every(
        (room) =>
          !room.position ||
          (room.position.column + room.size.columns - 1 <= candidate.columns &&
            room.position.row + room.size.rows - 1 <= candidate.rows),
      );
      if (!positionsFit) continue;
      if (packRoomGrid(rooms, candidate)) candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => {
    const score = (grid: MonitorGridSize) =>
      Math.abs(grid.columns - preferred.columns) * 5 + Math.abs(grid.rows - preferred.rows);
    return score(a) - score(b) || a.rows * a.columns - b.rows * b.columns;
  });
  return candidates[0] ?? null;
}

export function normalizeMonitorWorkspace(raw: unknown): {
  rooms: MonitorRoom[];
  grid: MonitorGridSize;
  audioFocusKeys: string[];
} {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const rooms: MonitorRoom[] = [];
  const platforms: readonly LivePlatform[] = ["douyu", "huya", "douyin", "bilibili"];
  const rawRooms = Array.isArray(source.rooms) ? source.rooms : [];

  for (const item of rawRooms) {
    if (!item || typeof item !== "object") continue;
    const room = item as Record<string, unknown>;
    const platform = room.platform;
    const roomId = typeof room.roomId === "string" ? room.roomId : "";
    if (
      typeof platform !== "string" ||
      !platforms.includes(platform as LivePlatform) ||
      !/^\d+$/.test(roomId)
    ) {
      continue;
    }
    const key = `${platform}:${roomId}`;
    if (seen.has(key) || rooms.length >= MAX_ROOMS) continue;
    seen.add(key);
    const volume =
      typeof room.volume === "number" && Number.isFinite(room.volume)
        ? Math.min(2, Math.max(0, room.volume))
        : 0.7;
    rooms.push({
      key,
      platform: platform as LivePlatform,
      roomId,
      ...(isGridPosition(room.position) ? { position: room.position } : {}),
      size: isRoomSize(room.size) ? room.size : { columns: 1, rows: 1 },
      lineId: typeof room.lineId === "string" ? room.lineId.slice(0, 128) : "",
      volume,
      danmakuEnabled: room.danmakuEnabled !== false,
      danmakuSettings: normalizeDanmuSettings(
        room.danmakuSettings && typeof room.danmakuSettings === "object"
          ? (room.danmakuSettings as Partial<DanmuUserSettings>)
          : DEFAULT_DANMU_SETTINGS,
      ),
      qualityId: typeof room.qualityId === "string" ? room.qualityId.slice(0, 128) : "",
    });
  }

  const validGrid = fitRoomGrid(rooms, { columns: 2, rows: 2 }) ?? { columns: 4, rows: 4 };
  const validKeys = new Set(rooms.map((room) => room.key));
  const rawAudioKeys = Array.isArray(source.audioFocusKeys) ? source.audioFocusKeys : [];
  const audioFocusKeys = [
    ...new Set(rawAudioKeys.filter((key): key is string => typeof key === "string")),
  ].filter((key) => validKeys.has(key));

  return {
    rooms,
    grid: validGrid,
    audioFocusKeys: audioFocusKeys.slice(0, MAX_ROOMS),
  };
}
