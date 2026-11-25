import { useEffect } from "react";
import { HashRouter, useLocation } from "react-router-dom";
import * as LiveLog from "../bindings/dtv/internal/services/livelogservice";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { loadAppSettings, saveAppSettings } from "./lib/appSettings";
import { dismissSplash } from "./lib/splash";
import { isWailsRuntime } from "./lib/window";
import { AppRoutes } from "./routes";
import { BilibiliAuthProvider } from "./state/BilibiliAuthProvider";
import { DouyuAuthProvider } from "./state/DouyuAuthProvider";
import { FollowProvider } from "./state/FollowProvider";
import { PlayerUiProvider } from "./state/PlayerUiProvider";
import { ThemeProvider } from "./state/ThemeProvider";
import { ToastProvider } from "./state/ToastProvider";

/**
 * 应用根组件。
 *
 * 路由使用 HashRouter：Wails 的 AssetFileServerFS 没有 SPA fallback，
 * 在 /player 上按 F5 会 404；hash 路由在桌面端最稳（U-16）。
 *
 * Provider 顺序：Theme → Toast → Follow → 登录态 → PlayerUi。
 * 每个 Provider 的 value 都做了 useMemo，且状态彼此独立，
 * 不会出现"改主题导致整个 Navbar 重渲染"的连锁更新。
 */
export function App() {
  useEffect(() => {
    // React 首帧已提交，移除 index.html 的内联启动层。
    dismissSplash();

    const onError = (event: ErrorEvent) => {
      console.error("[window.onerror]", event.error ?? event.message);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      console.error("[unhandledrejection]", event.reason);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // 直播流日志开关由 Go 侧持久化；启动时同步到前端设置，避免两边显示不一致。
  useEffect(() => {
    if (!isWailsRuntime()) return;
    void LiveLog.Enabled()
      .then((enabled) => {
        const current = loadAppSettings();
        if (current.liveLogEnabled !== enabled) {
          saveAppSettings({ ...current, liveLogEnabled: enabled });
        }
      })
      .catch(() => undefined);
  }, []);

  return (
    <ErrorBoundary>
      <HashRouter>
        <ThemeProvider>
          <ToastProvider>
            <FollowProvider>
              <BilibiliAuthProvider>
                <DouyuAuthProvider>
                  <PlayerUiProvider>
                    <RouteBoundary />
                  </PlayerUiProvider>
                </DouyuAuthProvider>
              </BilibiliAuthProvider>
            </FollowProvider>
          </ToastProvider>
        </ThemeProvider>
      </HashRouter>
    </ErrorBoundary>
  );
}

function RouteBoundary() {
  const { pathname } = useLocation();
  // 每个路由一个边界：一个页面崩了不影响其它页面，切换路由自动重置。
  return (
    <ErrorBoundary resetKey={pathname}>
      <AppRoutes />
    </ErrorBoundary>
  );
}
