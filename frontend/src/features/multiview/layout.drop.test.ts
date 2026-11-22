import { describe, expect, it } from "vitest";
import {
  findFreePlacement,
  freezeRoomPlacements,
  gridPlacementsOverlap,
  moveRoomToCell,
  packRoomGrid,
  type GridPosition,
  type MonitorGridSize,
  type MonitorRoom,
  type MonitorTileSize,
} from "./layout";

const GRID: MonitorGridSize = { columns: 4, rows: 4 };

function room(
  key: string,
  size: MonitorTileSize,
  position?: GridPosition,
): MonitorRoom {
  return {
    key,
    platform: "douyu",
    roomId: key,
    size,
    lineId: "",
    volume: 0.7,
    danmakuEnabled: true,
    danmakuSettings: {} as MonitorRoom["danmakuSettings"],
    qualityId: "",
    ...(position ? { position } : {}),
  };
}

describe("moveRoomToCell", () => {
  it("drops into any empty cell exactly, keeping other rooms frozen", () => {
    // 回归：旧实现里显式位置冲突的房间会回退自动打包，
    // 导致空位投放后目标格被占走、被拖房间弹回原位。
    const rooms = [
      room("r0", { columns: 1, rows: 1 }, { column: 3, row: 2 }),
      room("r1", { columns: 1, rows: 1 }, { column: 2, row: 4 }),
      room("r2", { columns: 2, rows: 2 }, { column: 3, row: 1 }),
      room("r3", { columns: 1, rows: 1 }),
    ];
    const before = packRoomGrid(rooms, GRID)!;
    const occupied = new Set<string>();
    for (const placement of before.values()) {
      for (let y = placement.row; y < placement.row + placement.rows; y++) {
        for (let x = placement.column; x < placement.column + placement.columns; x++) {
          occupied.add(`${x},${y}`);
        }
      }
    }
    let tested = 0;
    for (let row = 1; row <= 4; row++) {
      for (let column = 1; column <= 4; column++) {
        if (occupied.has(`${column},${row}`)) continue;
        const result = moveRoomToCell(rooms, GRID, "r3", { column, row });
        expect("rooms" in result).toBe(true);
        if (!("rooms" in result)) continue;
        const after = packRoomGrid(result.rooms, GRID)!;
        expect(after.get("r3")).toMatchObject({ column, row });
        for (const key of ["r0", "r1", "r2"]) {
          expect(after.get(key)).toEqual(before.get(key));
        }
        tested++;
      }
    }
    expect(tested).toBeGreaterThan(0);
  });

  it("swaps placements and sizes when dropped onto another room", () => {
    const rooms = [
      room("a", { columns: 1, rows: 1 }, { column: 1, row: 1 }),
      room("b", { columns: 2, rows: 2 }, { column: 3, row: 3 }),
    ];
    const result = moveRoomToCell(rooms, GRID, "a", { column: 3, row: 3 });
    expect("rooms" in result).toBe(true);
    if (!("rooms" in result)) return;
    const after = packRoomGrid(result.rooms, GRID)!;
    expect(after.get("a")).toEqual({ column: 3, row: 3, columns: 2, rows: 2 });
    expect(after.get("b")).toEqual({ column: 1, row: 1, columns: 1, rows: 1 });
  });

  it("random layouts: every empty-cell drop lands exactly where aimed", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    let drops = 0;
    for (let trial = 0; trial < 2000; trial++) {
      const count = 2 + Math.floor(rand() * 4);
      const rooms: MonitorRoom[] = [];
      for (let i = 0; i < count; i++) {
        const columns = (1 + Math.floor(rand() * 2)) as 1 | 2;
        const rows = (1 + Math.floor(rand() * 2)) as 1 | 2;
        const position =
          rand() < 0.5
            ? { column: 1 + Math.floor(rand() * 4), row: 1 + Math.floor(rand() * 4) }
            : undefined;
        rooms.push(room(`r${i}`, { columns, rows }, position));
      }
      const before = packRoomGrid(rooms, GRID);
      if (!before) continue;
      const fromKey = rooms[Math.floor(rand() * rooms.length)].key;
      const cell = { column: 1 + Math.floor(rand() * 4), row: 1 + Math.floor(rand() * 4) };
      const hit = [...before.entries()].find(
        ([key, p]) =>
          key !== fromKey &&
          cell.column >= p.column && cell.column < p.column + p.columns &&
          cell.row >= p.row && cell.row < p.row + p.rows,
      );
      const result = moveRoomToCell(rooms, GRID, fromKey, cell);
      // 目标格为空但"按尺寸钳制后的落点"与他房重叠 → 合法拒绝（与引导红格一致）
      const fromRoom = rooms.find((r) => r.key === fromKey)!;
      const clamped = {
        column: Math.min(cell.column, GRID.columns - fromRoom.size.columns + 1),
        row: Math.min(cell.row, GRID.rows - fromRoom.size.rows + 1),
        ...fromRoom.size,
      };
      const blocked =
        !hit &&
        [...before.entries()].some(
          ([key, p]) => key !== fromKey && gridPlacementsOverlap(clamped, p),
        );
      if (blocked) {
        expect("error" in result).toBe(true);
        drops++;
        continue;
      }
      expect("rooms" in result).toBe(true);
      if (!("rooms" in result)) continue;
      const after = packRoomGrid(result.rooms, GRID);
      expect(after).not.toBeNull();
      if (!after) continue;
      if (!hit) {
        const from = rooms.find((r) => r.key === fromKey)!;
        expect(after.get(fromKey)).toMatchObject({
          column: Math.min(cell.column, GRID.columns - from.size.columns + 1),
          row: Math.min(cell.row, GRID.rows - from.size.rows + 1),
        });
        // 其余房间一格都不动
        for (const [key, placement] of before) {
          if (key !== fromKey) expect(after.get(key)).toEqual(placement);
        }
      }
      drops++;
    }
    expect(drops).toBeGreaterThan(500);
  });
});

describe("findFreePlacement (ctrl+滚轮方向自适应)", () => {
  it("prefers growing right/down from the current anchor when free", () => {
    const rooms = [room("a", { columns: 1, rows: 1 }, { column: 1, row: 1 })];
    expect(findFreePlacement(rooms, GRID, "a", { columns: 2, rows: 2 })).toEqual({
      column: 1, row: 1, columns: 2, rows: 2,
    });
  });

  it("grows left when the right side is blocked", () => {
    const rooms = [
      room("a", { columns: 1, rows: 1 }, { column: 3, row: 2 }),
      room("block", { columns: 1, rows: 1 }, { column: 4, row: 2 }),
    ];
    expect(findFreePlacement(rooms, GRID, "a", { columns: 2, rows: 1 })).toEqual({
      column: 2, row: 2, columns: 2, rows: 1,
    });
  });

  it("grows up when the bottom is blocked", () => {
    const rooms = [
      room("a", { columns: 1, rows: 1 }, { column: 2, row: 3 }),
      room("block", { columns: 1, rows: 1 }, { column: 2, row: 4 }),
    ];
    expect(findFreePlacement(rooms, GRID, "a", { columns: 1, rows: 2 })).toEqual({
      column: 2, row: 2, columns: 1, rows: 2,
    });
  });

  it("grows diagonally when only a diagonal area is free", () => {
    const rooms = [
      room("a", { columns: 1, rows: 1 }, { column: 2, row: 2 }),
      room("n", { columns: 1, rows: 1 }, { column: 2, row: 1 }),
      room("w", { columns: 1, rows: 1 }, { column: 1, row: 2 }),
      room("e", { columns: 1, rows: 1 }, { column: 3, row: 2 }),
      room("s", { columns: 1, rows: 1 }, { column: 2, row: 3 }),
    ];
    expect(findFreePlacement(rooms, GRID, "a", { columns: 2, rows: 2 })).toEqual({
      column: 3, row: 3, columns: 2, rows: 2,
    });
  });

  it("returns null when no direction has space", () => {
    const rooms = [
      room("a", { columns: 1, rows: 1 }, { column: 1, row: 1 }),
      room("wall", { columns: 3, rows: 4 }, { column: 2, row: 1 }),
    ];
    expect(findFreePlacement(rooms, GRID, "a", { columns: 2, rows: 1 })).toBeNull();
  });

  it("keeps the anchor when shrinking", () => {
    const rooms = [room("a", { columns: 2, rows: 2 }, { column: 3, row: 3 })];
    expect(findFreePlacement(rooms, GRID, "a", { columns: 1, rows: 1 })).toEqual({
      column: 3, row: 3, columns: 1, rows: 1,
    });
  });
});

describe("freezeRoomPlacements", () => {
  it("makes every placement explicit so packing is deterministic", () => {
    const rooms = [
      room("a", { columns: 1, rows: 1 }),
      room("b", { columns: 2, rows: 2 }),
    ];
    const frozen = freezeRoomPlacements(rooms, GRID)!;
    expect(frozen.every((r) => r.position)).toBe(true);
    const first = packRoomGrid(frozen, GRID)!;
    const second = packRoomGrid(frozen, GRID)!;
    for (const [key, placement] of first) {
      expect(second.get(key)).toEqual(placement);
    }
  });
});