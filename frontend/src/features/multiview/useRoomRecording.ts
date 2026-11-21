import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_REPLAY_SECONDS } from "@/lib/appSettings";

const BASE_MAX_REPLAY_BYTES = 32 * 1024 * 1024;
const RECORDER_BITRATE = 1_000_000;

interface ReplayChunk {
  blob: Blob;
  timestamp: number;
}

type CapturableVideoElement = HTMLVideoElement & {
  captureStream?: () => MediaStream;
};

function recorderOptions(): MediaRecorderOptions {
  const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(
    (candidate) => MediaRecorder.isTypeSupported(candidate),
  );
  if (!mimeType) throw new Error("当前环境不支持 WebM 录制");
  return {
    mimeType,
    videoBitsPerSecond: RECORDER_BITRATE,
    audioBitsPerSecond: 96_000,
  };
}

export function useRoomRecording(
  media: HTMLVideoElement | null,
  enabled: boolean,
  windowSeconds: number = DEFAULT_REPLAY_SECONDS,
): {
  bufferedSeconds: number;
  bufferedBytes: number;
  error: string;
  replayBlob: () => Blob | null;
} {
  const streamRef = useRef<MediaStream | null>(null);
  const replayRecorderRef = useRef<MediaRecorder | null>(null);
  const replayChunksRef = useRef<ReplayChunk[]>([]);
  const replayHeaderRef = useRef<Blob | null>(null);
  const windowSecondsRef = useRef(windowSeconds);
  const [bufferedSeconds, setBufferedSeconds] = useState(0);
  const [bufferedBytes, setBufferedBytes] = useState(0);
  const [error, setError] = useState("");

  // 裁剪回溯缓冲到当前窗口：时长缩短时立即生效，不重启录制器。
  // 字节上限随时长放宽（约 1.6Mbps 余量），避免长窗口下提前丢帧。
  const trimReplayBuffer = useCallback((now: number) => {
    const windowMs = windowSecondsRef.current * 1000;
    const maxBytes = Math.max(BASE_MAX_REPLAY_BYTES, windowSecondsRef.current * 200_000);
    const cutoff = now - windowMs;
    replayChunksRef.current = replayChunksRef.current.filter(
      (chunk) => chunk.timestamp >= cutoff,
    );
    let totalBytes = replayChunksRef.current.reduce((total, chunk) => total + chunk.blob.size, 0);
    while (replayChunksRef.current.length > 1 && totalBytes > maxBytes) {
      const removed = replayChunksRef.current.shift();
      totalBytes -= removed?.blob.size ?? 0;
    }
    const first = replayChunksRef.current[0]?.timestamp ?? now;
    setBufferedSeconds(
      Math.min(windowSecondsRef.current, Math.max(0, Math.round((now - first) / 1000))),
    );
    setBufferedBytes(totalBytes);
  }, []);

  useEffect(() => {
    windowSecondsRef.current = windowSeconds;
    if (replayChunksRef.current.length > 0) {
      trimReplayBuffer(Date.now());
    } else {
      setBufferedSeconds(0);
      setBufferedBytes(0);
    }
  }, [windowSeconds, trimReplayBuffer]);

  useEffect(() => {
    if (!media || typeof MediaRecorder === "undefined") return;
    const captureStream = (media as CapturableVideoElement).captureStream;
    if (typeof captureStream !== "function") return;
    let stream: MediaStream;
    try {
      stream = captureStream.call(media);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法捕获直播媒体流");
      return;
    }
    streamRef.current = stream;

    return () => {
      stream.getTracks().forEach((track) => track.stop());
      if (streamRef.current === stream) streamRef.current = null;
    };
  }, [media]);

  useEffect(() => {
    replayChunksRef.current = [];
    replayHeaderRef.current = null;
    setBufferedSeconds(0);
    setBufferedBytes(0);
    setError("");
    // media 还没就绪（播放器刚创建 / 正在取流）时安静等待，不能报错。
    if (!enabled || !media) return;
    if (typeof MediaRecorder === "undefined") {
      setError("当前环境不支持直播回溯录制");
      return;
    }
    const stream = streamRef.current;
    if (!stream) {
      if (typeof (media as CapturableVideoElement).captureStream !== "function") {
        setError("当前环境不支持直播回溯录制");
      }
      return;
    }

    let active = true;
    let started = false;
    let recorder: MediaRecorder | null = null;

    // captureStream() 在视频尚未加载出画面（readyState=0）时返回的是
    // 空轨道流，直接 start() 会抛 "no audio or video tracks available"。
    // 必须等轨道真正出现（addtrack / loadeddata / playing）再启动录制。
    const startRecorder = () => {
      if (!active || started) return;
      if (stream.getTracks().length === 0) return;
      let next: MediaRecorder;
      try {
        next = new MediaRecorder(stream, recorderOptions());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "无法启动回溯录制");
        return;
      }
      started = true;
      recorder = next;
      replayRecorderRef.current = next;
      next.ondataavailable = (event) => {
        if (!active || event.data.size === 0) return;
        const timestamp = Date.now();
        if (!replayHeaderRef.current) replayHeaderRef.current = event.data;
        replayChunksRef.current.push({ blob: event.data, timestamp });
        trimReplayBuffer(timestamp);
      };
      next.onerror = () => setError("直播回溯录制失败");
      try {
        next.start(1_000);
      } catch {
        // 轨道可能又失效（换线路 / 重连瞬间）：回到等待状态，
        // 下一次 playing / addtrack 事件再试，不打扰用户。
        started = false;
        recorder = null;
        if (replayRecorderRef.current === next) replayRecorderRef.current = null;
      }
    };

    stream.addEventListener("addtrack", startRecorder);
    media.addEventListener("loadeddata", startRecorder);
    media.addEventListener("playing", startRecorder);
    startRecorder();

    return () => {
      active = false;
      stream.removeEventListener("addtrack", startRecorder);
      media.removeEventListener("loadeddata", startRecorder);
      media.removeEventListener("playing", startRecorder);
      if (recorder && replayRecorderRef.current === recorder) replayRecorderRef.current = null;
      if (recorder && recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.onerror = null;
        recorder.stop();
      }
    };
  }, [enabled, media, trimReplayBuffer]);

  const replayBlob = useCallback(() => {
    const chunks = replayChunksRef.current;
    if (chunks.length === 0) return null;
    const header = replayHeaderRef.current;
    const recent = chunks.map((chunk) => chunk.blob);
    const parts = header && recent[0] !== header ? [header, ...recent] : recent;
    return new Blob(parts, { type: recent[0]?.type || "video/webm" });
  }, []);

  return { bufferedSeconds, bufferedBytes, error, replayBlob };
}
