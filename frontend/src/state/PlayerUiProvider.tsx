import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * 播放页的"全局可见状态"。
 *
 * 旧项目的 PlayerUiProvider 里塞了 island / isFullscreen / danmuPanel 三块，
 * 其中 danmuPanel 是一整套死 API；island（顶栏主播信息）已按产品要求移除，
 * 主播信息只保留在播放器自己的顶栏里。
 *
 * 现在这里有两种"全屏"：
 *   - nativeFullscreen：DOM Fullscreen API / 系统级全屏，会盖住任务栏，
 *     外壳（侧栏/顶栏）让位；
 *   - cssFullscreen：fix01 起改为"工作台内全屏" —— 播放器只铺满内容区，
 *     侧栏/顶栏保持可见，操作系统窗口不变，也不会自动最大化。
 * isFullscreen 仍表示"任一全屏"，供播放器自身的浮层布局使用。
 */

interface PlayerUiContextValue {
  /** 原生全屏（DOM Fullscreen API / Wails 窗口全屏） */
  nativeFullscreen: boolean;
  setNativeFullscreen: (v: boolean) => void;
  /** 工作台内全屏（铺满内容区，侧栏/顶栏可见） */
  cssFullscreen: boolean;
  setCssFullscreen: (v: boolean) => void;
  /** 任一全屏 —— 播放器浮层布局（弹幕面板改浮层等） */
  isFullscreen: boolean;
}

const PlayerUiContext = createContext<PlayerUiContextValue | null>(null);

export function PlayerUiProvider({ children }: { children: ReactNode }) {
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [cssFullscreen, setCssFullscreen] = useState(false);

  const value = useMemo<PlayerUiContextValue>(
    () => ({
      nativeFullscreen,
      setNativeFullscreen,
      cssFullscreen,
      setCssFullscreen,
      isFullscreen: nativeFullscreen || cssFullscreen,
    }),
    [cssFullscreen, nativeFullscreen],
  );

  return <PlayerUiContext.Provider value={value}>{children}</PlayerUiContext.Provider>;
}

export function usePlayerUi(): PlayerUiContextValue {
  const ctx = useContext(PlayerUiContext);
  if (!ctx) throw new Error("usePlayerUi 必须在 PlayerUiProvider 内使用");
  return ctx;
}
