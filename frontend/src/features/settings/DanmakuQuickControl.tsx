import { useEffect, useRef, useState } from "react";
import { useDanmuPreferences } from "@/features/player/useDanmuPreferences";
import {
  DANMU_AREA_OPTIONS,
  DANMU_FONT_MAX,
  DANMU_FONT_MIN,
  DANMU_OPACITY_MAX,
  DANMU_OPACITY_MIN,
  type DanmuUserSettings,
} from "@/features/player/danmuSettings";
import { cn } from "@/lib/cn";
import styles from "./DanmakuQuickControl.module.css";

export function DanmakuQuickControl() {
  const { enabled, settings, setEnabled, updateSettings } = useDanmuPreferences();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    window.addEventListener("keydown", closeEscape, true);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      window.removeEventListener("keydown", closeEscape, true);
    };
  }, [open]);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    window.dispatchEvent(new CustomEvent("dtv:global-danmaku", { detail: { enabled: next } }));
  };

  const changeSettings = (patch: Partial<DanmuUserSettings>) => {
    updateSettings(patch);
    window.dispatchEvent(new CustomEvent("dtv:global-danmaku-settings", { detail: patch }));
  };

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={cn(styles.button, enabled && styles.enabled)}
        onClick={toggle}
        onContextMenu={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
        aria-label={enabled ? "关闭所有弹幕，右键打开弹幕设置" : "开启所有弹幕，右键打开弹幕设置"}
        aria-pressed={enabled}
        aria-expanded={open}
        title="左键开关弹幕，右键设置"
      >
        弹
      </button>
      {open && (
        <div className={styles.popover} role="dialog" aria-label="全局弹幕设置">
          <strong>全局弹幕设置</strong>
          <label>
            字体大小
            <input
              type="range"
              min={DANMU_FONT_MIN}
              max={DANMU_FONT_MAX}
              step={2}
              value={parseInt(settings.fontSize, 10)}
              onChange={(event) => changeSettings({ fontSize: `${event.target.value}px` })}
            />
          </label>
          <label>
            透明度
            <input
              type="range"
              min={DANMU_OPACITY_MIN}
              max={DANMU_OPACITY_MAX}
              step={0.05}
              value={settings.opacity}
              onChange={(event) => changeSettings({ opacity: Number(event.target.value) })}
            />
          </label>
          <label>
            弹幕速度
            <input
              type="range"
              min={5000}
              max={20000}
              step={500}
              value={settings.duration}
              onChange={(event) => changeSettings({ duration: Number(event.target.value) })}
            />
          </label>
          <label>
            显示区域
            <select
              value={settings.area}
              onChange={(event) => changeSettings({ area: Number(event.target.value) })}
            >
              {DANMU_AREA_OPTIONS.map((area) => (
                <option key={area} value={area}>
                  {area === 1 ? "全屏" : `上 ${Math.round(area * 100)}%`}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
