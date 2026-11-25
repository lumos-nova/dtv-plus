import { Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import * as DataTransfer from "../../../bindings/dtv/internal/services/datatransferservice";
import * as StorageSettings from "../../../bindings/dtv/internal/services/storagesettingsservice";
import type { DanmakuMessage } from "@/api";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/cn";
import { isWailsRuntime } from "@/lib/window";
import { useToast } from "@/state/ToastProvider";
import { buildHighlightAss } from "./highlightAss";
import {
  clampSelection,
  defaultSelection,
  formatClock,
  formatTimecode,
  timelineTicks,
  type HighlightSelection,
} from "./highlightTimeline";
import { exportHighlight } from "./replayExport";
import { saveRecording } from "./saveRecording";
import styles from "./ReplayHighlightModal.module.css";

const GIF_WIDTHS = [320, 480, 640];
const MP4_WIDTHS = [480, 720, 1080];
const GIF_FPS = [10, 15, 24];
const GIF_COLORS = [
  { value: 256, label: "最佳 · 256 色" },
  { value: 128, label: "良好 · 128 色" },
  { value: 64, label: "一般 · 64 色" },
];
const MP4_BITRATES = [
  { value: 8, label: "高清 · 8 Mbps" },
  { value: 4, label: "标准 · 4 Mbps" },
  { value: 2, label: "流畅 · 2 Mbps" },
];

interface ReplayHighlightModalProps {
  blob: Blob;
  bufferedSeconds: number;
  messages: DanmakuMessage[];
  nickname: string;
  title: string;
  onClose: () => void;
}

/**
 * 「回溯精彩」：预览内存回溯缓冲，用双滑块时间轴选一段，
 * 导出 GIF / 短视频；可选把历史弹幕与当前标题烧录进画面。
 */
export function ReplayHighlightModal({
  blob,
  bufferedSeconds,
  messages,
  nickname,
  title,
  onClose,
}: ReplayHighlightModalProps) {
  const { toast } = useToast();
  const duration = Math.max(0.5, bufferedSeconds);
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const selectionPlayRef = useRef(false);
  const dragHandleRef = useRef<"start" | "end" | null>(null);

  const [selection, setSelection] = useState<HighlightSelection>(() =>
    defaultSelection(duration),
  );
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [format, setFormat] = useState<"gif" | "mp4">("gif");
  const [widthPx, setWidthPx] = useState(480);
  const [fps, setFps] = useState(15);
  const [colors, setColors] = useState(256);
  const [videoMbps, setVideoMbps] = useState(8);
  const [includeDanmaku, setIncludeDanmaku] = useState(true);
  const [includeTitle, setIncludeTitle] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportedPath, setExportedPath] = useState("");
  const [recordingsDir, setRecordingsDir] = useState("");
  // 缓冲起点对应的墙上时钟：挂载时估算（render 阶段不能读时钟）。
  const [bufferStartAt, setBufferStartAt] = useState(0);

  useEffect(() => {
    setBufferStartAt(Date.now() - bufferedSeconds * 1000);
  }, [bufferedSeconds]);

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  useEffect(() => {
    if (!isWailsRuntime()) return;
    void StorageSettings.GetPaths().then((paths) => setRecordingsDir(paths.recordingsDir));
  }, []);

  const switchFormat = (next: "gif" | "mp4") => {
    setFormat(next);
    setWidthPx(next === "gif" ? 480 : 720);
  };

  const onTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
    if (selectionPlayRef.current && video.currentTime >= selection.end) {
      video.pause();
      selectionPlayRef.current = false;
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    selectionPlayRef.current = false;
    if (video.paused) void video.play();
    else video.pause();
  };

  const playSelection = () => {
    const video = videoRef.current;
    if (!video) return;
    selectionPlayRef.current = true;
    video.currentTime = selection.start;
    void video.play();
  };

  const secondsAtPointer = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return ((clientX - rect.left) / Math.max(1, rect.width)) * duration;
  };

  const beginHandleDrag = (
    event: PointerEvent<HTMLButtonElement>,
    handle: "start" | "end",
  ) => {
    event.preventDefault();
    event.stopPropagation();
    dragHandleRef.current = handle;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveHandleDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const handle = dragHandleRef.current;
    if (!handle) return;
    const seconds = secondsAtPointer(event.clientX);
    setSelection((previous) =>
      clampSelection({ ...previous, [handle]: seconds }, duration),
    );
  };

  const endHandleDrag = () => {
    dragHandleRef.current = null;
  };

  const onTrackClick = (event: PointerEvent<HTMLDivElement>) => {
    if (dragHandleRef.current) return;
    const seconds = secondsAtPointer(event.clientX);
    setSelection((previous) => {
      const handle =
        Math.abs(seconds - previous.start) <= Math.abs(seconds - previous.end)
          ? "start"
          : "end";
      return clampSelection({ ...previous, [handle]: seconds }, duration);
    });
  };

  const generate = async () => {
    setExporting(true);
    try {
      const ass =
        includeDanmaku || includeTitle
          ? buildHighlightAss(messages, {
              startMs: bufferStartAt + selection.start * 1000,
              endMs: bufferStartAt + selection.end * 1000,
              width: widthPx,
              height: Math.round((widthPx * 9) / 16),
              title: title || nickname,
              includeDanmaku,
              includeTitle,
            })
          : null;
      const output = await exportHighlight(blob, {
        format,
        startSec: selection.start,
        durationSec: selection.end - selection.start,
        widthPx,
        fps,
        colors,
        videoMbps,
        ass,
        onWarning: (message) => toast(message, "info"),
      });
      const filename = `dtv-highlight-${Date.now()}.${format === "gif" ? "gif" : "mp4"}`;
      const saved = await saveRecording(output, filename, "highlights");
      if (saved) {
        setExportedPath(saved);
        if (isWailsRuntime()) toast(`精彩片段已保存：${saved}`, "success");
      }
    } catch (error) {
      toast(error instanceof Error ? `导出失败：${error.message}` : "导出失败", "error");
    } finally {
      setExporting(false);
    }
  };

  const copyFile = async () => {
    if (!exportedPath) return;
    try {
      await DataTransfer.CopyFileToClipboard(exportedPath);
      toast("文件已复制，可直接粘贴到文件夹", "success");
    } catch {
      try {
        await navigator.clipboard.writeText(exportedPath);
        toast("已复制文件路径", "success");
      } catch {
        toast("复制失败", "error");
      }
    }
  };

  const openFolder = async () => {
    if (!recordingsDir) return;
    try {
      await StorageSettings.OpenDirectory(recordingsDir);
    } catch (error) {
      toast(error instanceof Error ? error.message : "打开文件夹失败", "error");
    }
  };

  const selectionPercent = {
    left: `${(selection.start / duration) * 100}%`,
    width: `${((selection.end - selection.start) / duration) * 100}%`,
  };
  const playheadPercent = `${Math.min(100, (currentTime / duration) * 100)}%`;
  const ticks = timelineTicks(duration);
  const widths = format === "gif" ? GIF_WIDTHS : MP4_WIDTHS;

  return (
    <Modal
      title="回溯精彩"
      onClose={onClose}
      width={1080}
      footer={
        <div className={styles.footer}>
          <div className={styles.footerGroup}>
            <button
              type="button"
              className={styles.action}
              disabled={!exportedPath}
              onClick={() => void copyFile()}
            >
              复制文件
            </button>
            <button
              type="button"
              className={styles.action}
              disabled={!exportedPath || !recordingsDir}
              onClick={() => void openFolder()}
            >
              打开文件夹
            </button>
          </div>
          <div className={styles.footerGroup}>
            <button type="button" className={styles.action} onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className={styles.generateButton}
              disabled={exporting}
              onClick={() => void generate()}
            >
              {exporting
                ? "正在生成…"
                : format === "gif"
                  ? "生成 GIF"
                  : "生成短视频"}
            </button>
          </div>
        </div>
      }
    >
      {/* REPLAY_HIGHLIGHT_CONTINUED */}
      <div className={styles.layout}>
        <div className={styles.preview}>
          <video
            ref={videoRef}
            className={styles.video}
            src={url}
            playsInline
            onTimeUpdate={onTimeUpdate}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
          <div className={styles.selectionInfo}>
            <span className={styles.selectionTitle}>片段区间</span>
            <span className={styles.selectionRange}>
              {formatClock(bufferStartAt + selection.start * 1000)} –{" "}
              {formatClock(bufferStartAt + selection.end * 1000)} ·{" "}
              {(selection.end - selection.start).toFixed(1)} 秒
            </span>
          </div>
          <div className={styles.ruler} aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick}
                className={styles.tick}
                style={{ left: `${(tick / duration) * 100}%` }}
              >
                {formatTimecode(tick).slice(0, 5)}
              </span>
            ))}
          </div>
          <div
            ref={trackRef}
            className={styles.track}
            onPointerDown={onTrackClick}
            role="slider"
            aria-label="片段区间选择"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={selection.start}
            tabIndex={0}
          >
            <div className={styles.selection} style={selectionPercent} />
            <div className={styles.playhead} style={{ left: playheadPercent }} />
            <button
              type="button"
              className={cn(styles.handle, styles.handleStart)}
              style={{ left: selectionPercent.left }}
              aria-label="选区起点"
              onPointerDown={(event) => beginHandleDrag(event, "start")}
              onPointerMove={moveHandleDrag}
              onPointerUp={endHandleDrag}
              onPointerCancel={endHandleDrag}
            />
            <button
              type="button"
              className={cn(styles.handle, styles.handleEnd)}
              style={{ left: `${(selection.end / duration) * 100}%` }}
              aria-label="选区终点"
              onPointerDown={(event) => beginHandleDrag(event, "end")}
              onPointerMove={moveHandleDrag}
              onPointerUp={endHandleDrag}
              onPointerCancel={endHandleDrag}
            />
          </div>
          <div className={styles.playRow}>
            <span className={styles.position}>
              {formatTimecode(currentTime)} / {formatTimecode(duration)}
            </span>
            <button
              type="button"
              className={styles.action}
              onClick={togglePlay}
              aria-label={playing ? "暂停" : "播放"}
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button type="button" className={styles.action} onClick={playSelection}>
              播放选区
            </button>
          </div>
          <p className={styles.status}>
            {exporting
              ? "正在转码，请稍候…"
              : exportedPath
                ? `已导出：${exportedPath}`
                : "正在播放本地缓存，可随时导出"}
          </p>
        </div>
        {/* REPLAY_OPTIONS_CONTINUED */}
        <aside className={styles.options}>
          <h3>输出格式</h3>
          <div className={styles.formatRow}>
            <button
              type="button"
              className={cn(styles.formatButton, format === "gif" && styles.formatActive)}
              onClick={() => switchFormat("gif")}
            >
              GIF
            </button>
            <button
              type="button"
              className={cn(styles.formatButton, format === "mp4" && styles.formatActive)}
              onClick={() => switchFormat("mp4")}
            >
              短视频
            </button>
          </div>
          <label className={styles.field}>
            <span>分辨率</span>
            <select value={widthPx} onChange={(event) => setWidthPx(Number(event.target.value))}>
              {widths.map((width) => (
                <option key={width} value={width}>
                  {width} px
                </option>
              ))}
            </select>
          </label>
          {format === "gif" ? (
            <>
              <label className={styles.field}>
                <span>帧率</span>
                <select value={fps} onChange={(event) => setFps(Number(event.target.value))}>
                  {GIF_FPS.map((value) => (
                    <option key={value} value={value}>
                      {value} FPS
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span>颜色质量</span>
                <select value={colors} onChange={(event) => setColors(Number(event.target.value))}>
                  {GIF_COLORS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <label className={styles.field}>
              <span>视频画质</span>
              <select
                value={videoMbps}
                onChange={(event) => setVideoMbps(Number(event.target.value))}
              >
                {MP4_BITRATES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={includeDanmaku}
              onChange={(event) => setIncludeDanmaku(event.target.checked)}
            />
            合成历史弹幕（可选）
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={includeTitle}
              onChange={(event) => setIncludeTitle(event.target.checked)}
            />
            合成当前标题（可选）
          </label>
        </aside>
      </div>
    </Modal>
  );
}