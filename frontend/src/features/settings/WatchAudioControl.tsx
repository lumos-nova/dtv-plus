import { Clock3, Volume2, VolumeX } from "lucide-react";
import { useEffect, useState } from "react";
import { loadAppSettings, saveAppSettings } from "@/lib/appSettings";
import styles from "./WatchAudioControl.module.css";

interface WatchTime {
  sessionSeconds: number;
}

function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}

export function WatchAudioControl() {
  const [settings, setSettings] = useState(loadAppSettings);
  const [watchTime, setWatchTime] = useState<WatchTime>({ sessionSeconds: 0 });

  useEffect(() => {
    const updateAudio = (event: Event) => {
      const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
      if (typeof detail?.enabled !== "boolean") return;
      const next = { ...loadAppSettings(), globalAudioEnabled: detail.enabled };
      setSettings(next);
      saveAppSettings(next);
    };
    const updateWatchTime = (event: Event) => {
      const detail = (event as CustomEvent<WatchTime>).detail;
      if (detail) setWatchTime(detail);
    };
    window.addEventListener("dtv:global-audio", updateAudio);
    window.addEventListener("dtv:watch-time", updateWatchTime);
    return () => {
      window.removeEventListener("dtv:global-audio", updateAudio);
      window.removeEventListener("dtv:watch-time", updateWatchTime);
    };
  }, []);

  const toggleAudio = () => {
    const enabled = !settings.globalAudioEnabled;
    const next = { ...loadAppSettings(), globalAudioEnabled: enabled };
    setSettings(next);
    saveAppSettings(next);
    window.dispatchEvent(new CustomEvent("dtv:global-audio", { detail: { enabled } }));
  };

  const setGlobalVolume = (volume: number) => {
    const next = { ...loadAppSettings(), globalVolume: volume };
    setSettings(next);
    saveAppSettings(next);
    window.dispatchEvent(new CustomEvent("dtv:global-volume", { detail: { volume } }));
  };

  return (
    <div className={styles.controls}>
      <span className={styles.watchTime} title={`本次观看 ${formatTime(watchTime.sessionSeconds)}`}>
        <span>本次观看</span>
        <Clock3 size={15} aria-hidden="true" />
        <span>{formatTime(watchTime.sessionSeconds)}</span>
      </span>
      <button
        type="button"
        className={styles.speaker}
        onClick={toggleAudio}
        aria-label={settings.globalAudioEnabled ? "关闭所有直播声音" : "开启所有直播声音"}
        title={settings.globalAudioEnabled ? "关闭所有直播声音" : "开启所有直播声音"}
      >
        {settings.globalAudioEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
      </button>
      <input
        className={styles.volume}
        type="range"
        min={0}
        max={200}
        step={5}
        value={Math.round(settings.globalVolume * 100)}
        onChange={(event) => setGlobalVolume(Number(event.target.value) / 100)}
        aria-label="全局音量"
        title={`全局音量 ${Math.round(settings.globalVolume * 100)}%`}
      />
    </div>
  );
}
