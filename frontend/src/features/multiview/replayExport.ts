import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";

export type ReplayFormat = "mp4" | "gif";

let ffmpeg: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;
let conversionQueue: Promise<void> = Promise.resolve();
let activeConversions = 0;

async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg?.loaded) return ffmpeg;
  if (loading) return loading;
  const instance = new FFmpeg();
  loading = instance
    .load({ coreURL, wasmURL })
    .then(() => {
      ffmpeg = instance;
      return instance;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

async function convertReplayExclusive(blob: Blob, format: ReplayFormat): Promise<Blob> {
  const engine = await getFFmpeg();
  const input = "replay.webm";
  const output = format === "mp4" ? "replay.mp4" : "replay.gif";
  await engine.writeFile(input, new Uint8Array(await blob.arrayBuffer()));
  let result: Blob;
  try {
    const args =
      format === "mp4"
        ? [
            "-y",
            "-i",
            input,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "28",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            output,
          ]
        : ["-y", "-i", input, "-vf", "fps=10,scale=640:-1:flags=lanczos", "-loop", "0", output];
    const exitCode = await engine.exec(args);
    if (exitCode !== 0) throw new Error(`回溯转码失败（FFmpeg ${exitCode}）`);
    const data = await engine.readFile(output);
    if (typeof data === "string") throw new Error("回溯转码返回了无效文件");
    const buffer = new Uint8Array(data).buffer;
    result = new Blob([buffer], { type: format === "mp4" ? "video/mp4" : "image/gif" });
  } finally {
    await engine.deleteFile(input);
  }
  await engine.deleteFile(output);
  return result;
}

export function convertReplay(blob: Blob, format: ReplayFormat): Promise<Blob> {
  const conversion = conversionQueue.then(() => {
    activeConversions += 1;
    return convertReplayExclusive(blob, format).finally(() => {
      activeConversions -= 1;
    });
  });
  conversionQueue = conversion.then(
    () => undefined,
    () => undefined,
  );
  return conversion;
}

/**
 * 释放空闲的 FFmpeg 实例（「存储设置 → 清理临时文件」）。
 *
 * 正在加载或转码时不打断，返回 false；成功终止 worker 返回 true。
 * 下次导出时会按需重新加载。
 */
export function disposeReplayEngine(): boolean {
  if (!ffmpeg || loading || activeConversions > 0) return false;
  const instance = ffmpeg;
  ffmpeg = null;
  fontLoadedFor = null;
  void instance.terminate();
  return true;
}

/* ------------------------------------------------------------ 回溯精彩导出 */

export interface HighlightExportOptions {
  format: "gif" | "mp4";
  /** 选区起点（相对缓冲 0 点，秒） */
  startSec: number;
  /** 选区时长（秒） */
  durationSec: number;
  widthPx: number;
  /** GIF 帧率 */
  fps: number;
  /** GIF 调色板颜色数 */
  colors: number;
  /** 短视频目标码率（Mbps） */
  videoMbps: number;
  /** ASS 字幕内容（合成弹幕 / 标题时提供） */
  ass?: string | null;
  onWarning?: (message: string) => void;
}

const HIGHLIGHT_FONT_URL = "/fonts/NotoSansSC-Regular.otf";
const HIGHLIGHT_FONT_PATH = "fonts/NotoSansSC-Regular.otf";
let fontLoadedFor: FFmpeg | null = null;

async function ensureHighlightFont(engine: FFmpeg): Promise<void> {
  if (fontLoadedFor === engine) return;
  const response = await fetch(HIGHLIGHT_FONT_URL);
  if (!response.ok) throw new Error("下载弹幕字体失败");
  const bytes = new Uint8Array(await response.arrayBuffer());
  await engine.createDir("fonts").catch(() => undefined);
  await engine.writeFile(HIGHLIGHT_FONT_PATH, bytes);
  fontLoadedFor = engine;
}

async function runHighlight(
  engine: FFmpeg,
  opts: HighlightExportOptions,
  withAss: boolean,
): Promise<Blob> {
  const input = "highlight-in.webm";
  const output = opts.format === "mp4" ? "highlight.mp4" : "highlight.gif";
  const start = Math.max(0, opts.startSec).toFixed(2);
  const duration = Math.max(0.1, opts.durationSec).toFixed(2);
  const scale =
    opts.format === "mp4"
      ? `scale=${opts.widthPx}:-2:flags=lanczos`
      : `scale=${opts.widthPx}:-1:flags=lanczos`;
  let assFilter = "";
  if (withAss && opts.ass) {
    await ensureHighlightFont(engine);
    await engine.writeFile("highlight.ass", new TextEncoder().encode(opts.ass));
    assFilter = ",ass=highlight.ass:fontsdir=fonts";
  }
  try {
    let exitCode: number;
    if (opts.format === "mp4") {
      exitCode = await engine.exec([
        "-y",
        "-i",
        input,
        "-ss",
        start,
        "-t",
        duration,
        "-vf",
        `${scale}${assFilter}`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-b:v",
        `${opts.videoMbps}M`,
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        output,
      ]);
    } else {
      const paletteVf = `fps=${opts.fps},${scale}${assFilter}`;
      exitCode = await engine.exec([
        "-y",
        "-i",
        input,
        "-ss",
        start,
        "-t",
        duration,
        "-vf",
        `${paletteVf},palettegen=max_colors=${opts.colors}`,
        "palette.png",
      ]);
      if (exitCode === 0) {
        exitCode = await engine.exec([
          "-y",
          "-i",
          input,
          "-i",
          "palette.png",
          "-ss",
          start,
          "-t",
          duration,
          "-lavfi",
          `${paletteVf}[x];[x][1:v]paletteuse`,
          output,
        ]);
      }
      await engine.deleteFile("palette.png").catch(() => undefined);
    }
    if (exitCode !== 0) throw new Error(`精彩片段转码失败（FFmpeg ${exitCode}）`);
    const data = await engine.readFile(output);
    if (typeof data === "string") throw new Error("精彩片段转码返回了无效文件");
    const buffer = new Uint8Array(data).buffer;
    return new Blob([buffer], {
      type: opts.format === "mp4" ? "video/mp4" : "image/gif",
    });
  } finally {
    await engine.deleteFile(output).catch(() => undefined);
    if (withAss) await engine.deleteFile("highlight.ass").catch(() => undefined);
  }
}

async function exportHighlightExclusive(
  blob: Blob,
  opts: HighlightExportOptions,
): Promise<Blob> {
  const engine = await getFFmpeg();
  const input = "highlight-in.webm";
  await engine.writeFile(input, new Uint8Array(await blob.arrayBuffer()));
  try {
    if (opts.ass) {
      try {
        return await runHighlight(engine, opts, true);
      } catch (error) {
        // libass / 字体不可用时回退为不合成弹幕，保证仍能导出。
        opts.onWarning?.(
          `弹幕/标题合成失败，已导出不含弹幕的版本：${error instanceof Error ? error.message : "未知错误"}`,
        );
        return await runHighlight(engine, opts, false);
      }
    }
    return await runHighlight(engine, opts, false);
  } finally {
    await engine.deleteFile(input).catch(() => undefined);
  }
}

export function exportHighlight(
  blob: Blob,
  opts: HighlightExportOptions,
): Promise<Blob> {
  const conversion = conversionQueue.then(() => {
    activeConversions += 1;
    return exportHighlightExclusive(blob, opts).finally(() => {
      activeConversions -= 1;
    });
  });
  conversionQueue = conversion.then(
    () => undefined,
    () => undefined,
  );
  return conversion;
}
