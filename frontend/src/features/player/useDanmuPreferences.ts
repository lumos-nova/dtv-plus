import { useCallback, useEffect, useState } from "react";
import {
  loadDanmuPreferences,
  normalizeDanmuSettings,
  saveDanmuPreferences,
  type DanmuPreferences,
  type DanmuUserSettings,
} from "./danmuSettings";

/**
 * 弹幕开关 + 设置的状态与持久化。
 *
 * 首次挂载从 localStorage 读取（兼容老项目的 `dtv_danmu_preferences_v1`），
 * 之后任何变化都写回同一个键。设置面板只改 partial，归一化在这里统一做。
 */
export function useDanmuPreferences() {
  const [preferences, setPreferences] = useState<DanmuPreferences>(() => loadDanmuPreferences());

  useEffect(() => {
    saveDanmuPreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    const onGlobalDanmaku = (event: Event) => {
      const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
      if (typeof detail?.enabled === "boolean") {
        setPreferences((previous) => ({ ...previous, enabled: detail.enabled ?? true }));
      }
    };
    const onGlobalSettings = (event: Event) => {
      const detail = (event as CustomEvent<Partial<DanmuUserSettings>>).detail;
      if (detail) {
        setPreferences((previous) => ({
          ...previous,
          settings: normalizeDanmuSettings({ ...previous.settings, ...detail }),
        }));
      }
    };
    window.addEventListener("dtv:global-danmaku", onGlobalDanmaku);
    window.addEventListener("dtv:global-danmaku-settings", onGlobalSettings);
    return () => {
      window.removeEventListener("dtv:global-danmaku", onGlobalDanmaku);
      window.removeEventListener("dtv:global-danmaku-settings", onGlobalSettings);
    };
  }, []);

  const setEnabled = useCallback((enabled: boolean) => {
    setPreferences((prev) => ({ ...prev, enabled }));
  }, []);

  const updateSettings = useCallback((patch: Partial<DanmuUserSettings>) => {
    setPreferences((prev) => ({
      ...prev,
      settings: normalizeDanmuSettings({ ...prev.settings, ...patch }),
    }));
  }, []);

  return {
    enabled: preferences.enabled,
    settings: preferences.settings,
    setEnabled,
    updateSettings,
  };
}
