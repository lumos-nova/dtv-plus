import { useCallback, useEffect, useRef, useState } from "react";
import Player from "xgplayer";
import "xgplayer/dist/index.min.css";
import { loadRaw, saveRaw, STORAGE_KEYS } from "@/lib/storage";

export interface PlayerSource {
  url: string;
  /** mp4 = 点播整段视频（B 站轮播），原生播放、可 seek，按 VOD 处理 */
  format: "flv" | "hls" | "mp4";
  /**
   * 每次重新取流 +1。
   *
   * 直播断流后即使地址字符串完全没变，也必须重建实例：旧实例里的
   * FLV 读取器 / MSE buffer 已经进入结束状态，单纯 retry 拉不回来。
   */
  nonce?: number;
}

/**
 * 播放器状态。
 *
 * idle = 没有可播地址（未开播 / 还在等房间信息）：此时没有实例，
 * 任何"加载中"的 UI（比如刷新按钮转圈）都不应该出现。
 */
export type PlayState = "idle" | "loading" | "buffering" | "playing" | "paused" | "error";

export interface UseXgPlayerResult {
  state: PlayState;
  error: string | null;
  mediaElement: HTMLVideoElement | null;
  /** 每次真实的 error 事件 +1（用于"只自动换一条线"之类的逻辑） */
  errorNonce: number;
  volume: number;
  togglePlay: () => void;
  toggleMute: () => void;
  setMuted: (muted: boolean) => void;
  setVolume: (v: number) => void;
  /** 当前环境是否支持画中画小窗（不支持时不显示按钮） */
  pipSupported: boolean;
  /** 是否已经处于小窗状态 */
  pipActive: boolean;
  /** 进入 / 退出画中画小窗 */
  togglePip: () => void;
  audioBoostSupported: boolean;
  activateAudioBoost: () => boolean;
  /** 每次视频自然播完 +1（轮播稿件播完时用来重新取下一条） */
  endedNonce: number;
}

export interface PlayerAudioState {
  /** 0–2; values above 1 use Web Audio gain processing. */
  volume: number;
  muted: boolean;
}

const DEFAULT_VOLUME = 0.7;
const VOLUME_KEY = STORAGE_KEYS.playerVolume;

/**
 * 把 `<video>` 收缩成「画面内容矩形」，把黑边让给舞台背景去画。
 *
 * 为什么必须这么做：xgplayer 默认让 video 元素铺满整个舞台，再用
 * `object-fit: contain` 在**元素内部**留黑边。WebView2 会把视频提升成硬件叠加
 * 平面（DirectComposition overlay），这块平面连同元素区域里的黑色一起盖在网页
 * 内容之上 —— 于是落在黑边里的弹幕被那层黑挡住：
 *   - 弹幕全在黑边里（画面上没内容压着视频）→ 浏览器放心用叠加平面 → 看不见；
 *   - 有弹幕压在画面上 / 玻璃胶囊的 backdrop-filter 在场 → 叠加平面用不了
 *     → 正常合成 → 黑边里的弹幕也看得见。
 * 元素只占画面矩形后，黑边由 `.stage` 自己的黑背景来画，那一层永远不会盖住弹幕。
 */
function updateVideoBox(host: HTMLElement, media: HTMLVideoElement): void {
  const viewWidth = media.videoWidth;
  const viewHeight = media.videoHeight;
  const hostWidth = host.clientWidth;
  const hostHeight = host.clientHeight;

  if (viewWidth <= 0 || viewHeight <= 0 || hostWidth <= 0 || hostHeight <= 0) {
    // 元数据/尺寸还没准备好：回到 CSS 兜底（铺满 + object-fit: contain）
    for (const prop of ["position", "inset", "margin", "width", "height"]) {
      media.style.removeProperty(prop);
    }
    return;
  }

  const scale = Math.min(hostWidth / viewWidth, hostHeight / viewHeight);
  // 用 inset + margin:auto 居中：不依赖 video 的直接父节点是谁、多大
  media.style.position = "absolute";
  media.style.inset = "0";
  media.style.margin = "auto";
  media.style.width = `${viewWidth * scale}px`;
  media.style.height = `${viewHeight * scale}px`;
}

function readVolume(): number {
  const raw = loadRaw(VOLUME_KEY, String(DEFAULT_VOLUME));
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_VOLUME;
}

/**
 * xgplayer 实例封装。
 *
 * 这里只做一件事：按 source 创建/销毁实例，并把状态回调出去。
 * UI 控制条是自己的 React 组件（见 PlayerChrome），不往 xgplayer 里注册插件。
 */
export function useXgPlayer(
  containerRef: React.RefObject<HTMLDivElement | null>,
  source: PlayerSource | null,
  isLive = true,
  audio?: PlayerAudioState,
): UseXgPlayerResult {
  const playerRef = useRef<Player | null>(null);
  const [state, setState] = useState<PlayState>("idle");
  const [mediaElement, setMediaElement] = useState<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorNonce, setErrorNonce] = useState(0);
  const [endedNonce, setEndedNonce] = useState(0);
  const [volume, setVolumeState] = useState(readVolume);
  const lastVolumeRef = useRef(volume > 0 ? volume : DEFAULT_VOLUME);
  const [pipSupported, setPipSupported] = useState(false);
  const [pipActive, setPipActive] = useState(false);
  const [audioBoostSupported, setAudioBoostSupported] = useState(true);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioGainRef = useRef<GainNode | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const audioRef = useRef(audio);
  audioRef.current = audio;

  const url = source?.url ?? "";
  const format = source?.format ?? "hls";
  const sourceNonce = source?.nonce ?? 0;

  const activateAudioBoost = useCallback(() => {
    const media = playerRef.current?.media as HTMLMediaElement | null;
    if (!media) return false;
    try {
      if (!audioGainRef.current) {
        const audioContext = new AudioContext();
        const audioSource = audioContext.createMediaElementSource(media);
        const gain = audioContext.createGain();
        audioSource.connect(gain);
        gain.connect(audioContext.destination);
        audioContextRef.current = audioContext;
        audioSourceRef.current = audioSource;
        audioGainRef.current = gain;
      }
      const audioContext = audioContextRef.current;
      if (audioContext?.state === "suspended") {
        void audioContext.resume().catch((error: unknown) => {
          console.warn("[player] 音频上下文恢复失败", error);
          setAudioBoostSupported(false);
        });
      }
      setAudioBoostSupported(true);
      return true;
    } catch (error) {
      console.warn("[player] 音量增强初始化失败", error);
      setAudioBoostSupported(false);
      return false;
    }
  }, []);

  /** 真正写实例音量 + 持久化 */
  const applyVolume = useCallback((next: number) => {
    const clamped = Math.min(1, Math.max(0, next));
    setVolumeState(clamped);
    if (clamped > 0) {
      lastVolumeRef.current = clamped;
      saveRaw(VOLUME_KEY, String(clamped));
    }
    const player = playerRef.current;
    if (player) {
      player.volume = clamped;
      try {
        player.muted = clamped === 0;
      } catch {
        /* 某些内核不支持直接改 muted */
      }
    }
    return clamped;
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !url) {
      if (!url) setState("idle");
      return;
    }

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let detachPip: (() => void) | null = null;
    let detachVideoBox: (() => void) | null = null;
    let detachEnded: (() => void) | null = null;
    setState("loading");
    setError(null);

    void (async () => {
      // mp4（轮播点播）走原生 <video>，不需要 FLV/HLS 插件，也不按直播处理
      const isVOD = format === "mp4";
      let plugin: unknown = null;
      if (!isVOD) {
        try {
          if (format === "flv") {
            const mod = await import("xgplayer-flv");
            plugin = mod.default;
          } else {
            const mod = await import("xgplayer-hls.js");
            plugin = mod.default;
          }
        } catch {
          // 插件缺失时退化为原生播放（HLS 在部分 WebView 里不支持，会走 error 分支）
        }
      }
      if (disposed) return;

      const options: Record<string, unknown> = {
        el,
        url,
        isLive: isVOD ? false : isLive,
        width: "100%",
        height: "100%",
        videoFillMode: "contain",
        autoplay: true,
        controls: false,
        lang: "zh",
        volume: Math.min(audioRef.current?.volume ?? volume, 1),
        autoplayMuted: audioRef.current?.muted ?? false,
        ...(audioRef.current
          ? {
              videoAttributes: { crossOrigin: "anonymous" },
            }
          : {}),
        closeVideoClick: true,
        closeVideoDblclick: false,
        screenShot: false,
        download: false,
        // ---------------------------------------------------------- 弱网参数
        // 目标缓冲 8s、最多容忍 24s；断流/卡住时每 1.2s 重试一次，连续 10 次
        // 才放弃。maxReaderInterval / loadTimeout 也放宽，避免慢网被误判断流。
        flv: {
          retryCount: 8,
          retryDelay: 1200,
          disconnectRetryCount: 10,
          preloadTime: 8,
          maxLatency: 24,
          targetLatency: 8,
          disconnectTime: 30,
          maxJumpDistance: 5,
          maxReaderInterval: 8000,
          loadTimeout: 20_000,
          longtimeNoReceived: 5000,
        },
        hlsOpts: {
          manifestLoadingMaxRetry: 8,
          manifestLoadingRetryDelay: 1500,
          levelLoadingMaxRetry: 8,
          levelLoadingRetryDelay: 1500,
          fragLoadingMaxRetry: 10,
          fragLoadingRetryDelay: 1500,
        },
      };
      if (plugin) options.plugins = [plugin];

      const player = new Player(options as unknown as ConstructorParameters<typeof Player>[0]);
      playerRef.current = player;
      setAudioBoostSupported(true);

      player.on("playing", () => {
        setState("playing");
        setError(null);
      });
      player.on("canplay", () => {
        setState((prev) => (prev === "loading" || prev === "buffering" ? "playing" : prev));
      });
      player.on("pause", () => setState((prev) => (prev === "error" ? prev : "paused")));
      player.on("waiting", () => setState((prev) => (prev === "error" ? prev : "buffering")));
      player.on("stalled", () => setState((prev) => (prev === "error" ? prev : "buffering")));
      player.on("error", () => {
        if (disposed) return;
        setError("直播流连接中断，正在尝试自动重连。");
        setState("error");
        setErrorNonce((n) => n + 1);
      });

      const media = player.media as HTMLVideoElement | null;
      setMediaElement(media);
      if (media && isVOD) {
        // 轮播稿件自然播完：通知外层重新取流（房间会轮到下一条稿件）
        const onEnded = () => {
          if (!disposed) setEndedNonce((n) => n + 1);
        };
        media.addEventListener("ended", onEnded);
        detachEnded = () => media.removeEventListener("ended", onEnded);
      }
      const currentAudio = audioRef.current;
      if (media && currentAudio) {
        media.muted = currentAudio.muted;
        if (currentAudio.volume > 1) {
          if (activateAudioBoost() && audioGainRef.current) {
            audioGainRef.current.gain.value = Math.min(2, currentAudio.volume);
          }
          media.volume = 1;
        } else {
          media.volume = currentAudio.volume;
        }
      }
      const syncVideoBox = () => {
        if (disposed || !media) return;
        updateVideoBox(el, media);
      };
      syncVideoBox();
      if (media) {
        const onLoaded = () => syncVideoBox();
        media.addEventListener("loadedmetadata", onLoaded);
        media.addEventListener("resize", onLoaded);
        media.addEventListener("playing", onLoaded);
        detachVideoBox = () => {
          media.removeEventListener("loadedmetadata", onLoaded);
          media.removeEventListener("resize", onLoaded);
          media.removeEventListener("playing", onLoaded);
        };
      }

      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          if (disposed) return;
          try {
            player.resize();
          } catch {
            /* 播放器销毁过程中 resize 可能抛错，忽略 */
          }
          syncVideoBox();
        });
        resizeObserver.observe(el);
      }

      const canPip =
        !!media &&
        typeof media.requestPictureInPicture === "function" &&
        document.pictureInPictureEnabled !== false;
      setPipSupported(canPip);
      if (canPip && media) {
        const onEnter = () => setPipActive(true);
        const onLeave = () => setPipActive(false);
        media.addEventListener("enterpictureinpicture", onEnter);
        media.addEventListener("leavepictureinpicture", onLeave);
        detachPip = () => {
          media.removeEventListener("enterpictureinpicture", onEnter);
          media.removeEventListener("leavepictureinpicture", onLeave);
        };
      }
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      resizeObserver = null;
      detachPip?.();
      detachPip = null;
      detachVideoBox?.();
      detachVideoBox = null;
      detachEnded?.();
      detachEnded = null;
      setPipActive(false);
      setPipSupported(false);

      const active = playerRef.current;
      const media = active?.media as HTMLVideoElement | null;
      audioGainRef.current?.disconnect();
      audioGainRef.current = null;
      audioSourceRef.current?.disconnect();
      audioSourceRef.current = null;
      const audioContext = audioContextRef.current;
      audioContextRef.current = null;
      if (audioContext && audioContext.state !== "closed") {
        void audioContext.close();
      }
      try {
        active?.pause();
      } catch {
        /* 实例可能已销毁 */
      }
      try {
        active?.destroy();
      } catch {
        /* 忽略销毁异常 */
      }
      playerRef.current = null;
      setMediaElement(null);
      if (media) {
        try {
          media.pause();
        } catch {
          /* ignore */
        }
        try {
          media.removeAttribute("src");
          media.load();
        } catch {
          /* 元素可能已被 destroy 移除 */
        }
      }
    };
    // volume 只在创建时用一次，后续由 applyVolume 直接改实例
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, format, isLive, sourceNonce]);

  // 实例重建后重新套用当前音量（避免每个新房间都回到 0.7）
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const audioState = audioRef.current;
    if (audioState) {
      const media = player.media as HTMLMediaElement | null;
      if (!media) return;
      media.muted = audioState.muted;
      if (audioState.volume > 1) {
        let gain = audioGainRef.current;
        if (!gain) {
          if (!activateAudioBoost()) {
            media.volume = 1;
            return;
          }
          gain = audioGainRef.current;
        }
        if (!gain) return;
        gain.gain.value = Math.min(2, audioState.volume);
        media.volume = 1;
      } else {
        if (audioGainRef.current) audioGainRef.current.gain.value = 1;
        media.volume = audioState.volume;
      }
      return;
    }
    player.volume = volume;
    try {
      player.muted = volume === 0;
    } catch {
      /* ignore */
    }
  }, [activateAudioBoost, audio?.muted, audio?.volume, url, volume]);

  const togglePlay = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (player.paused) void player.play();
    else player.pause();
  }, []);

  const setVolume = useCallback(
    (next: number) => {
      applyVolume(next);
    },
    [applyVolume],
  );

  const toggleMute = useCallback(() => {
    if (volume === 0) applyVolume(lastVolumeRef.current || DEFAULT_VOLUME);
    else applyVolume(0);
  }, [applyVolume, volume]);

  const setMuted = useCallback((muted: boolean) => {
    const player = playerRef.current;
    if (player) player.muted = muted;
  }, []);

  const togglePip = useCallback(() => {
    const media = playerRef.current?.media as HTMLVideoElement | null;
    if (!media || typeof media.requestPictureInPicture !== "function") return;
    void (async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await media.requestPictureInPicture();
      } catch (error) {
        console.warn("[player] 小窗切换失败", error);
      }
    })();
  }, []);

  return {
    state,
    error,
    mediaElement,
    errorNonce,
    endedNonce,
    volume,
    togglePlay,
    toggleMute,
    setMuted,
    setVolume,
    pipSupported,
    pipActive,
    togglePip,
    audioBoostSupported,
    activateAudioBoost,
  };
}
