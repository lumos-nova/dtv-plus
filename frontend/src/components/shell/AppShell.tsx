import { Outlet } from "react-router-dom";
import { WatchTimeTracker } from "@/features/settings/WatchTimeTracker";
import { usePlayerUi } from "@/state/PlayerUiProvider";
import { HomeStack } from "./HomeStack";
import { Navbar } from "./Navbar";
import { Sidebar } from "./Sidebar";
import styles from "./AppShell.module.css";

/**
 * 应用外壳：左侧栏 + (顶栏 + 内容区)。
 *
 * 背景只有两层：实色地面 + 一层极淡的胶片颗粒（SVG 噪点，不是渐变）。
 * 颗粒放在独立图层里，避免给 body 伪元素加负 z-index（WebView2 下表现
 * 不稳定），也不会触发整页重绘。
 *
 * fix01：只有系统级全屏（DOM Fullscreen / Wails 原生窗口全屏）才隐藏外壳；
 * 窗口全屏（cssFullscreen）改为只铺满工作台内容区，侧栏 / 顶栏保持可见，
 * 用户可以在全屏观看时通过侧栏双击 / 拖拽把别的主播加入工作台。
 */
export function AppShell() {
  const { nativeFullscreen } = usePlayerUi();
  const hideChrome = nativeFullscreen;

  return (
    <div className={styles.appShell}>
      <WatchTimeTracker />
      <div className={styles.backdrop} aria-hidden="true">
        <span className={styles.grain} />
      </div>

      {!hideChrome && <Sidebar />}
      <div className={styles.appMain}>
        {!hideChrome && <Navbar />}
        <main className={styles.appBody}>
          {/* 平台首页 / 订阅页常驻，用 Activity 在其它路由隐藏，实现 keep-alive */}
          <HomeStack />
          <Outlet />
        </main>
      </div>
    </div>
  );
}
