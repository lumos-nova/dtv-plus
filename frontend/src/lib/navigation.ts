import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { LivePlatform } from "@/api";

/** 平台首页：斗鱼是 `/`，其它平台是 `/<platform>`。 */
export function platformHomePath(platform: LivePlatform): string {
  return platform === "douyu" ? "/" : `/${platform}`;
}

/**
 * 启动时的默认落地页：
 *   - 有订阅分区 → 订阅 Tab；
 *   - 没有订阅 → 斗鱼首页。
 *
 * 只在应用从根路径启动时生效（此时 hash 为空 / `#/`）。用户手动打开
 * `#/huya`、`#/monitor` 这类深链接时不覆盖。必须在 React/HashRouter
 * 挂载之前调用（main.tsx），否则会先闪一下斗鱼首页再跳转。
 */
export function applyStartupLanding(): void {
  if (typeof window === "undefined") return;
  const hash = window.location.hash;
  if (!hash || hash === "#") {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/`);
  }
}

/**
 * 在多平台监看页（/monitor）打开一个直播间（todo05）。
 *
 * 平台首页卡片 / 搜索结果不再进单房间播放页，而是把房间加进监看工作台。
 * 通过 location.state 传递请求，MonitorPage 消费后立刻清掉，
 * 刷新 / 后退不会重复加房。已经在 /monitor 时用 replace，不堆历史。
 */
export function useOpenMonitorRoom(): (platform: LivePlatform, roomId: string) => void {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return useCallback(
    (platform: LivePlatform, roomId: string) => {
      navigate("/monitor", {
        replace: pathname === "/monitor",
        state: { dtvMonitorRoom: { platform, roomId } },
      });
    },
    [navigate, pathname],
  );
}
