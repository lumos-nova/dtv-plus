import { loadJSON, saveJSON } from "./storage";

export interface AppSettings {
  globalVolume: number;
  globalAudioEnabled: boolean;
  danmakuEnabled: boolean;
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
    restReminderEnabled: settings.restReminderEnabled,
    restMinutes: settings.restMinutes,
    watchedSeconds: settings.watchedSeconds,
  });
}
