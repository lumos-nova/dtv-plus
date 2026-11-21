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
  isRecording: boolean;
  replayBlob: () => Blob | null;
  startRecording: () => boolean;
  stopRecording: () => Promise<Blob | null>;
} {
  const streamRef = useRef<MediaStream | null>(null);
  const replayRecorderRef = useRef<MediaRecorder | null>(null);
  const replayChunksRef = useRef<ReplayChunk[]>([]);
  const replayHeaderRef = useRef<Blob | null>(null);
  const independentRecorderRef = useRef<MediaRecorder | null>(null);
  const independentChunksRef = useRef<Blob[]>([]);
  const windowSecondsRef = useRef(windowSeconds);
  const [bufferedSeconds, setBufferedSeconds] = useState(0);
  const [bufferedBytes, setBufferedBytes] = useState(0);
  const [error, setError] = useState("");
  const [isRecording, setIsRecording] = useState(false);

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
      if (independentRecorderRef.current) {
        const independent = independentRecorderRef.current;
        independent.ondataavailable = null;
        independent.onstop = null;
        independent.onerror = null;
        if (independent.state !== "inactive") independent.stop();
        independentRecorderRef.current = null;
      }
      setIsRecording(false);
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
    if (!enabled) return;
    const stream = streamRef.current;
    if (!stream || typeof MediaRecorder === "undefined") {
      setError("当前环境不支持直播回溯录制");
      return;
    }

    let active = true;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, recorderOptions());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法启动回溯录制");
      return;
    }
    replayRecorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (!active || event.data.size === 0) return;
      const timestamp = Date.now();
      if (!replayHeaderRef.current) replayHeaderRef.current = event.data;
      replayChunksRef.current.push({ blob: event.data, timestamp });
      trimReplayBuffer(timestamp);
    };
    recorder.onerror = () => setError("直播回溯录制失败");
    try {
      recorder.start(1_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法启动回溯录制");
    }

    return () => {
      active = false;
      if (replayRecorderRef.current === recorder) replayRecorderRef.current = null;
      if (recorder.state !== "inactive") {
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

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || independentRecorderRef.current || typeof MediaRecorder === "undefined") {
      return false;
    }
    try {
      const recorder = new MediaRecorder(stream, recorderOptions());
      independentChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) independentChunksRef.current.push(event.data);
      };
      recorder.onerror = () => setError("独立录制失败");
      recorder.start(1_000);
      independentRecorderRef.current = recorder;
      setError("");
      setIsRecording(true);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法开始独立录制");
      return false;
    }
  }, []);

  const stopRecording = useCallback(
    () =>
      new Promise<Blob | null>((resolve) => {
        const recorder = independentRecorderRef.current;
        if (!recorder) {
          resolve(null);
          return;
        }
        recorder.onstop = () => {
          independentRecorderRef.current = null;
          setIsRecording(false);
          const chunks = independentChunksRef.current;
          independentChunksRef.current = [];
          resolve(
            chunks.length > 0 ? new Blob(chunks, { type: chunks[0]?.type || "video/webm" }) : null,
          );
        };
        if (recorder.state === "inactive") {
          recorder.onstop(new Event("stop"));
        } else {
          recorder.stop();
        }
      }),
    [],
  );

  return {
    bufferedSeconds,
    bufferedBytes,
    error,
    isRecording,
    replayBlob,
    startRecording,
    stopRecording,
  };
}
