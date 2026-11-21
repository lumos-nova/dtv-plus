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
  group?: string;
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

export type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const MAX_GRID_SIZE = 4;
const MAX_ROOMS = 16;

export const FOLLOW_ROOM_DRAG_TYPE = "application/x-dtv-follow-room";

export function gridPlacementsOverlap(a: GridPlacement, b: GridPlacement): boolean {
  return (
    a.column < b.column + b.columns &&
    a.column + a.columns > b.column &&
    a.row < b.row + b.rows &&
    a.row + a.rows > b.row
  );
}

export function resizeGridPlacement(
  placement: GridPlacement,
  direction: ResizeDirection,
  columns: number,
  rows: number,
): GridPlacement | null {
  if (
    !Number.isInteger(columns) ||
    !Number.isInteger(rows) ||
    columns < 1 ||
    rows < 1 ||
    columns > MAX_GRID_SIZE ||
    rows > MAX_GRID_SIZE
  ) {
    return null;
  }

  const column = direction.includes("w")
    ? placement.column + placement.columns - columns
    : placement.column;
  const row = direction.includes("n") ? placement.row + placement.rows - rows : placement.row;
  if (
    column < 1 ||
    row < 1 ||
    column + columns - 1 > MAX_GRID_SIZE ||
    row + rows - 1 > MAX_GRID_SIZE
  ) {
    return null;
  }

  return { column, row, columns, rows };
}

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

/**
 * 把每个房间的显式 position 冻结为当前打包结果。
 *
 * packRoomGrid 对「显式位置冲突」的房间会回退到自动打包，导致拖拽投放后
 * 目标格可能被别的房间的回退占走、被拖房间弹回原位（引导绿了却投放失败）。
 * 拖拽 / 缩放前先冻结所有房间的位置，之后的打包就完全是确定性的。
 */
export function freezeRoomPlacements(
  rooms: readonly MonitorRoom[],
  grid: MonitorGridSize,
): MonitorRoom[] | null {
  const placements = packRoomGrid(rooms, grid);
  if (!placements) return null;
  return rooms.map((room) => {
    const placement = placements.get(room.key);
    return placement
      ? { ...room, position: { column: placement.column, row: placement.row } }
      : room;
  });
}

export type RoomMoveResult = { rooms: MonitorRoom[] } | { error: string };

/**
 * 拖拽投放的纯逻辑：投到别的房间上 → 交换位置与尺寸；
 * 投到空格 → 精确落在该格（其余房间全部冻结，不再隐式重排）。
 */
export function moveRoomToCell(
  rooms: readonly MonitorRoom[],
  grid: MonitorGridSize,
  fromKey: string,
  cell: GridPosition,
): RoomMoveResult {
  const placements = packRoomGrid(rooms, grid);
  const fromPlacement = placements?.get(fromKey);
  const from = rooms.find((room) => room.key === fromKey);
  if (!placements || !fromPlacement || !from) return { error: "网格布局无效" };

  const frozen = freezeRoomPlacements(rooms, grid);
  if (!frozen) return { error: "网格布局无效" };

  const targetEntry = [...placements.entries()].find(
    ([key, placement]) =>
      key !== fromKey &&
      cell.column >= placement.column &&
      cell.column < placement.column + placement.columns &&
      cell.row >= placement.row &&
      cell.row < placement.row + placement.rows,
  );

  if (targetEntry) {
    const [targetKey, targetPlacement] = targetEntry;
    const targetRoom = rooms.find((room) => room.key === targetKey);
    if (!targetRoom) return { error: "网格布局无效" };
    return {
      rooms: frozen.map((room) => {
        if (room.key === fromKey) {
          return {
            ...room,
            position: { column: targetPlacement.column, row: targetPlacement.row },
            size: targetRoom.size,
          };
        }
        if (room.key === targetKey) {
          return {
            ...room,
            position: { column: fromPlacement.column, row: fromPlacement.row },
            size: from.size,
          };
        }
        return room;
      }),
    };
  }

  const position = {
    column: Math.min(cell.column, grid.columns - from.size.columns + 1),
    row: Math.min(cell.row, grid.rows - from.size.rows + 1),
  };
  const candidate = { ...position, ...from.size };
  const overlaps = [...placements.entries()].some(
    ([key, placement]) => key !== fromKey && gridPlacementsOverlap(candidate, placement),
  );
  if (overlaps) return { error: "该位置无法容纳当前尺寸的直播间" };
  return {
    rooms: frozen.map((room) => (room.key === fromKey ? { ...room, position } : room)),
  };
}

/**
 * 为调整尺寸后的房间找落点：枚举网格内所有能放下新尺寸的位置，
 * 排除与其它房间重叠的，按「离当前锚点最近」排序——优先原地向右/下扩，
 * 右/下被挡时向左/上或任意有空间的方向扩（ctrl+滚轮 / 拖拽缩放手柄共用）。
 * 缩小时距离 0 的原锚点必然可用，因此保持原地。
 */
export function findFreePlacement(
  rooms: readonly MonitorRoom[],
  grid: MonitorGridSize,
  key: string,
  size: MonitorTileSize,
): GridPlacement | null {
  const placements = packRoomGrid(rooms, grid);
  const current = placements?.get(key);
  if (!placements || !current) return null;
  const others = [...placements.entries()]
    .filter(([otherKey]) => otherKey !== key)
    .map(([, placement]) => placement);

  const candidates: GridPlacement[] = [];
  for (let row = 1; row + size.rows - 1 <= grid.rows; row += 1) {
    for (let column = 1; column + size.columns - 1 <= grid.columns; column += 1) {
      candidates.push({ column, row, columns: size.columns, rows: size.rows });
    }
  }
  const distance = (placement: GridPlacement) =>
    Math.abs(placement.column - current.column) + Math.abs(placement.row - current.row);
  const columnsChanged = size.columns !== current.columns;
  const rowsChanged = size.rows !== current.rows;
  candidates.sort((a, b) => {
    const diff = distance(a) - distance(b);
    if (diff !== 0) return diff;
    // 同距离：只改一个维度时优先沿该维度扩（保持另一维坐标不变），
    // 例如只加宽 → 优先同行向左/右；只加高 → 优先同列向上/下。
    const rowChangedA = a.row === current.row ? 0 : 1;
    const rowChangedB = b.row === current.row ? 0 : 1;
    const colChangedA = a.column === current.column ? 0 : 1;
    const colChangedB = b.column === current.column ? 0 : 1;
    const primaryA = rowsChanged && !columnsChanged ? colChangedA : rowChangedA;
    const primaryB = rowsChanged && !columnsChanged ? colChangedB : rowChangedB;
    if (primaryA !== primaryB) return primaryA - primaryB;
    const secondaryA = rowsChanged && !columnsChanged ? rowChangedA : colChangedA;
    const secondaryB = rowsChanged && !columnsChanged ? rowChangedB : colChangedB;
    if (secondaryA !== secondaryB) return secondaryA - secondaryB;
    return a.row - b.row || a.column - b.column;
  });
  return (
    candidates.find(
      (candidate) => !others.some((other) => gridPlacementsOverlap(candidate, other)),
    ) ?? null
  );
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
      ...(typeof room.group === "string" && room.group.trim()
        ? { group: room.group.trim().slice(0, 40) }
        : {}),
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

  const validGrid = { columns: 4, rows: 4 } as const;
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
