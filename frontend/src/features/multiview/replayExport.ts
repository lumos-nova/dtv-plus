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
  void instance.terminate();
  return true;
}
