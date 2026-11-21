import { describe, expect, it } from "vitest";
import { buildHighlightAss } from "./highlightAss";
import {
  clampSelection,
  defaultSelection,
  formatTimecode,
  timelineTicks,
} from "./highlightTimeline";
import {
  formatRecordingBytes,
  formatRecordingDuration,
  recordingStatusLabel,
} from "./recordingFormat";
import type { RecordingTask } from "../../../bindings/dtv/internal/services/models";

describe("highlight timeline", () => {
  it("clamps and orders selection within duration", () => {
    expect(clampSelection({ start: 80, end: 20 }, 90)).toEqual({ start: 20, end: 80 });
    expect(clampSelection({ start: -5, end: 200 }, 90)).toEqual({ start: 0, end: 90 });
  });

  it("enforces a minimum span", () => {
    const result = clampSelection({ start: 10, end: 10.1 }, 90);
    expect(result.end - result.start).toBeGreaterThanOrEqual(0.5);
  });

  it("defaults to the last five seconds", () => {
    expect(defaultSelection(90)).toEqual({ start: 85, end: 90 });
    expect(defaultSelection(3)).toEqual({ start: 0, end: 3 });
  });

  it("formats timecodes and ticks", () => {
    expect(formatTimecode(95.99)).toBe("01:35.99");
    expect(formatTimecode(0)).toBe("00:00.00");
    expect(timelineTicks(90)).toEqual([0, 15, 30, 45, 60, 75, 90]);
  });
});

describe("buildHighlightAss", () => {
  const base = {
    startMs: 1_000_000,
    endMs: 1_005_000,
    width: 640,
    height: 360,
    includeDanmaku: true,
    includeTitle: false,
  };

  it("emits scrolling dialogues only for chat messages inside the window", () => {
    const ass = buildHighlightAss(
      [
        { content: "窗口内", at: 1_001_000, kind: "chat" },
        { content: "太早了", at: 900_000, kind: "chat" },
        { content: "太晚了", at: 1_010_000, kind: "chat" },
        { content: "礼物", at: 1_001_000, kind: "gift" },
      ],
      base,
    );
    expect(ass).toContain("PlayResX: 640");
    expect(ass).toContain("\\move(");
    expect(ass).toContain("窗口内");
    expect(ass).not.toContain("太早了");
    expect(ass).not.toContain("太晚了");
    expect(ass).not.toContain("礼物");
  });

  it("renders the title for the full selection when enabled", () => {
    const ass = buildHighlightAss([], {
      ...base,
      includeDanmaku: false,
      includeTitle: true,
      title: "今天的直播标题",
    });
    expect(ass).toContain("Dialogue: 1,0:00:00.00,0:00:05.00,Title");
    expect(ass).toContain("今天的直播标题");
  });

  it("escapes braces and newlines in danmaku text", () => {
    const ass = buildHighlightAss(
      [{ content: "a{b}c\nd", at: 1_001_000, kind: "chat" }],
      base,
    );
    expect(ass).toContain("a（b）c d");
  });

  it("converts #RRGGBB colors to ASS &H00BBGGRR&", () => {
    const ass = buildHighlightAss(
      [{ content: "红", at: 1_001_000, kind: "chat", color: "#ff2e2e" }],
      base,
    );
    expect(ass).toContain("&H002E2EFF&");
  });
});

describe("recording task formatting", () => {
  const task = (patch: Partial<RecordingTask>): RecordingTask =>
    ({
      id: "x",
      platform: "douyu",
      roomId: "1",
      nickname: "",
      quality: "best",
      qualityLabel: "",
      status: "stopped",
      startedAt: 0,
      durationSeconds: 0,
      savedBytes: 0,
      bitrateBps: 0,
      estimatedBytesPerHour: 0,
      segmentCount: 0,
      container: "mkv",
      dir: "",
      mergeState: "",
      ...patch,
    }) as RecordingTask;

  it("formats bytes and durations", () => {
    expect(formatRecordingBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatRecordingBytes(2 * 1024 * 1024 * 1024)).toBe("2.00 GB");
    expect(formatRecordingDuration(75)).toBe("01:15");
    expect(formatRecordingDuration(3675)).toBe("1:01:15");
  });

  it("maps status and merge state to labels", () => {
    expect(recordingStatusLabel(task({ status: "recording" }))).toBe("录制中");
    expect(recordingStatusLabel(task({ status: "error" }))).toBe("错误");
    expect(recordingStatusLabel(task({ mergeState: "merging" }))).toBe("合并中");
    expect(recordingStatusLabel(task({ mergeState: "merged" }))).toBe("已合并");
    expect(recordingStatusLabel(task({ mergeState: "failed" }))).toBe("合并失败");
    expect(recordingStatusLabel(task({}))).toBe("已停止");
  });
});