import { loadJSON, saveJSON } from "./storage";

/** 「内存回溯时长」下拉可选档位（秒）。 */
export const REPLAY_SECONDS_OPTIONS = [30, 60, 90, 120, 180, 300] as const;
export const DEFAULT_REPLAY_SECONDS = 120;

export function normalizeReplaySeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_REPLAY_SECONDS;
  return Math.max(30, Math.min(600, Math.round(value)));
}

export interface AppSettings {
  globalVolume: number;
  globalAudioEnabled: boolean;
  danmakuEnabled: boolean;
  replayEnabled: boolean;
  replaySeconds: number;
  restReminderEnabled: boolean;
  restMinutes: number;
  watchedSeconds: number;
}

const KEY = "dtv_app_settings_v1";

export function loadAppSettings(): AppSettings {
  const raw = loadJSON<Partial<AppSettings> | null>(KEY, null);
  return {
    globalVolume:
      typeof raw?.globalVolume === "number" ? Math.max(0, Math.min(2, raw.globalVolume)) : 1,
    globalAudioEnabled:
      typeof raw?.globalAudioEnabled === "boolean" ? raw.globalAudioEnabled : true,
    danmakuEnabled: typeof raw?.danmakuEnabled === "boolean" ? raw.danmakuEnabled : true,
    replayEnabled: typeof raw?.replayEnabled === "boolean" ? raw.replayEnabled : false,
    replaySeconds: normalizeReplaySeconds(raw?.replaySeconds),
    restReminderEnabled:
      typeof raw?.restReminderEnabled === "boolean" ? raw.restReminderEnabled : true,
    restMinutes:
      typeof raw?.restMinutes === "number"
        ? Math.max(1, Math.min(1440, Math.round(raw.restMinutes)))
        : 60,
    watchedSeconds: typeof raw?.watchedSeconds === "number" ? Math.max(0, raw.watchedSeconds) : 0,
  };
}

export function saveAppSettings(settings: AppSettings) {
  saveJSON(KEY, {
    globalVolume: settings.globalVolume,
    globalAudioEnabled: settings.globalAudioEnabled,
    danmakuEnabled: settings.danmakuEnabled,
    replayEnabled: settings.replayEnabled,
    replaySeconds: normalizeReplaySeconds(settings.replaySeconds),
    restReminderEnabled: settings.restReminderEnabled,
    restMinutes: settings.restMinutes,
    watchedSeconds: settings.watchedSeconds,
  });
}
