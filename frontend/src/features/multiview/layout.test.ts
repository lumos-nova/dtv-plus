import { describe, expect, it } from "vitest";
import type { MonitorRoom } from "./layout";
import {
  fitRoomGrid,
  normalizeMonitorWorkspace,
  packRoomGrid,
  swapRoomPositionsAndSizes,
} from "./layout";

function room(
  index: number,
  columns: MonitorRoom["size"]["columns"] = 1,
  rows: MonitorRoom["size"]["rows"] = 1,
): MonitorRoom {
  return {
    key: `douyu:${index}`,
    platform: "douyu",
    roomId: String(index),
    size: { columns, rows },
    volume: 0.7,
    danmakuEnabled: true,
    danmakuSettings: {
      color: "#ffffff",
      strokeColor: "#444444",
      fontSize: "20px",
      duration: 10000,
      area: 0.5,
      mode: "scroll",
      opacity: 1,
      colorful: true,
    },
    qualityId: "",
  };
}

describe("monitor layout", () => {
  it("packs tiles without overlap and rejects insufficient space", () => {
    const rooms = [room(1, 2, 2), room(2), room(3), room(4)];
    const packed = packRoomGrid(rooms, { columns: 3, rows: 3 });
    expect(packed?.size).toBe(4);
    expect(packRoomGrid(rooms, { columns: 2, rows: 2 })).toBeNull();
  });

  it("preserves explicit positions and packs unpositioned rooms into the remaining cells", () => {
    const rooms = [room(1), { ...room(2), position: { column: 3, row: 2 } }, room(3)];
    const packed = packRoomGrid(rooms, { columns: 3, rows: 2 });

    expect(packed?.get("douyu:2")).toMatchObject({ column: 3, row: 2 });
    expect(packed?.get("douyu:1")).toMatchObject({ column: 1, row: 1 });
    expect(packed?.get("douyu:3")).toMatchObject({ column: 2, row: 1 });
  });

  it("keeps explicitly positioned rooms within the selected grid after restore", () => {
    const restored = normalizeMonitorWorkspace({
      grid: { columns: 4, rows: 4 },
      rooms: [{ ...room(1), position: { column: 3, row: 2 } }],
    });

    expect(restored.grid).toEqual({ columns: 3, rows: 2 });
    expect(packRoomGrid(restored.rooms, restored.grid)?.get("douyu:1")).toMatchObject({
      column: 3,
      row: 2,
    });
  });

  it("prioritizes explicit positions and packs out-of-grid positions into available cells", () => {
    const rooms = [
      room(1),
      { ...room(2), position: { column: 1, row: 1 } },
      { ...room(3), position: { column: 4, row: 4 } },
    ];
    const packed = packRoomGrid(rooms, { columns: 2, rows: 2 });

    expect(packed?.get("douyu:2")).toMatchObject({ column: 1, row: 1 });
    expect(packed?.get("douyu:3")).toMatchObject({ column: 2, row: 1 });
    expect(packed?.get("douyu:1")).toMatchObject({ column: 1, row: 2 });
  });

  it("chooses the smallest nearby grid that fits all rooms", () => {
    expect(
      fitRoomGrid(
        Array.from({ length: 5 }, (_, i) => room(i)),
        { columns: 2, rows: 2 },
      ),
    ).toEqual({ columns: 2, rows: 3 });
  });

  it("resets a legacy oversized grid to the preferred automatic 2×2 layout", () => {
    const restored = normalizeMonitorWorkspace({
      grid: { columns: 4, rows: 4 },
      rooms: [room(1), room(2)],
    });

    expect(restored.grid).toEqual({ columns: 2, rows: 2 });
  });

  it("supports tiles spanning up to four grid cells in either direction", () => {
    const packed = packRoomGrid([room(1, 3, 2)], { columns: 4, rows: 4 });
    expect(packed?.get("douyu:1")).toMatchObject({ columns: 3, rows: 2 });
    const restored = normalizeMonitorWorkspace({
      grid: { columns: 4, rows: 4 },
      rooms: [{ ...room(1), size: { columns: 3, rows: 2 } }],
    });
    expect(restored.rooms[0]?.size).toEqual({ columns: 3, rows: 2 });
  });

  it("swaps room positions and sizes while keeping each tile's occupied position", () => {
    const rooms = [
      { ...room(1), position: { column: 1, row: 1 } },
      { ...room(2, 2), position: { column: 2, row: 1 } },
      { ...room(3), position: { column: 4, row: 1 } },
    ];
    const grid = { columns: 4, rows: 2 } as const;
    const before = packRoomGrid(rooms, grid);
    const swapped = swapRoomPositionsAndSizes(rooms, "douyu:1", "douyu:2");
    const after = packRoomGrid(swapped, grid);

    expect(swapped.map((item) => item.key)).toEqual(["douyu:2", "douyu:1", "douyu:3"]);
    expect(after?.get("douyu:1")).toEqual(before?.get("douyu:2"));
    expect(after?.get("douyu:2")).toEqual(before?.get("douyu:1"));
    expect(after?.get("douyu:3")).toEqual(before?.get("douyu:3"));
  });

  it("normalizes persisted data, removes duplicates and caps at 16 rooms", () => {
    const rooms = Array.from({ length: 18 }, (_, i) => room(i));
    const state = normalizeMonitorWorkspace({
      grid: { columns: 1, rows: 1 },
      rooms: [...rooms, rooms[0]],
      globalDanmakuEnabled: false,
      audioFocusKeys: ["douyu:0", "douyu:17"],
    });
    expect(state.rooms).toHaveLength(16);
    expect(state.grid).toEqual({ columns: 4, rows: 4 });
    expect(state).not.toHaveProperty("globalDanmakuEnabled");
    expect(state.audioFocusKeys).toEqual(["douyu:0"]);
  });

  it("normalizes persisted room controls and valid danmaku preferences", () => {
    const restored = normalizeMonitorWorkspace({
      grid: { columns: 2, rows: 2 },
      rooms: [{ ...room(1), qualityId: "invalid", danmakuSettings: { opacity: 4 } }],
    });

    expect(restored.rooms[0]?.qualityId).toBe("invalid");
    expect(restored.rooms[0]?.danmakuSettings.opacity).toBe(1);
    expect(restored.rooms[0]?.danmakuSettings.fontSize).toBe("20px");
  });
});
