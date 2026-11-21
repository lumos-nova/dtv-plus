import { describe, expect, it } from "vitest";
import {
  clearRoomReplayStats,
  getRecordingStatsSnapshot,
  setRoomReplayStats,
  subscribeRecordingStats,
  summarizeRecordingStats,
} from "./recordingStats";
import { DEFAULT_REPLAY_SECONDS, normalizeReplaySeconds } from "@/lib/appSettings";

describe("summarizeRecordingStats", () => {
  it("sums buffered bytes and estimates target from per-room bitrate", () => {
    const summary = summarizeRecordingStats(
      [
        { bytes: 1_000_000, seconds: 10 }, // 100 KB/s
        { bytes: 600_000, seconds: 30 }, // 20 KB/s
      ],
      90,
    );
    expect(summary.bufferedBytes).toBe(1_600_000);
    expect(summary.estimatedTargetBytes).toBeCloseTo(120_000 * 90);
  });

  it("ignores rooms without buffered data in the estimate", () => {
    const summary = summarizeRecordingStats(
      [
        { bytes: 0, seconds: 0 },
        { bytes: 500_000, seconds: 10 },
      ],
      60,
    );
    expect(summary.bufferedBytes).toBe(500_000);
    expect(summary.estimatedTargetBytes).toBeCloseTo(50_000 * 60);
  });

  it("returns zeros for an empty workspace", () => {
    expect(summarizeRecordingStats([], 120)).toEqual({
      bufferedBytes: 0,
      estimatedTargetBytes: 0,
    });
  });
});

describe("recording stats store", () => {
  it("publishes snapshots on set/clear and keeps identity when unchanged", () => {
    let notifications = 0;
    const unsubscribe = subscribeRecordingStats(() => {
      notifications += 1;
    });
    const empty = getRecordingStatsSnapshot();

    setRoomReplayStats("douyu:1", { bytes: 10, seconds: 1 });
    expect(notifications).toBe(1);
    const first = getRecordingStatsSnapshot();
    expect(first).toEqual([{ bytes: 10, seconds: 1 }]);

    // 相同数据不重复发布，snapshot 引用保持稳定（useSyncExternalStore 要求）。
    setRoomReplayStats("douyu:1", { bytes: 10, seconds: 1 });
    expect(notifications).toBe(1);
    expect(getRecordingStatsSnapshot()).toBe(first);

    setRoomReplayStats("huya:2", { bytes: 20, seconds: 2 });
    expect(getRecordingStatsSnapshot()).toHaveLength(2);

    clearRoomReplayStats("douyu:1");
    clearRoomReplayStats("huya:2");
    expect(getRecordingStatsSnapshot()).toHaveLength(0);
    expect(getRecordingStatsSnapshot()).not.toBe(empty);

    clearRoomReplayStats("missing");
    expect(notifications).toBe(4);
    unsubscribe();
  });
});

describe("normalizeReplaySeconds", () => {
  it.each([
    [90, 90],
    [30, 30],
    [300, 300],
    [10, 30],
    [9999, 600],
    [89.6, 90],
  ])("clamps %s to %s", (input, expected) => {
    expect(normalizeReplaySeconds(input)).toBe(expected);
  });

  it.each([undefined, null, "90", Number.NaN])("falls back for %s", (input) => {
    expect(normalizeReplaySeconds(input)).toBe(DEFAULT_REPLAY_SECONDS);
  });
});