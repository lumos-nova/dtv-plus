import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { LivePlatform } from "@/api";

/** 直播间的 URL 形状与老项目保持一致（`/player?platform=&roomId=`）。 */
export function playerPath(platform: LivePlatform, roomId: string): string {
  return `/player?platform=${encodeURIComponent(platform)}&roomId=${encodeURIComponent(roomId)}`;
}

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
 * `#/huya`、`#/player?...` 这类深链接时不覆盖。必须在 React/HashRouter
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
 * 打开一个直播间。
 *
 * 关键规则：**当前已经在播放页时用 replace，而不是 push**。
 *
 * 否则在 A 房间的侧边栏点开 B，浏览器会留下 A → B 两条历史记录；从 B
 * 返回时 `navigate(-1)` 会退回 A，A 的 PlayerPage 被重新挂载、播放器重新
 * 拉流，看起来就像"退出 B 之后又自动进回了 A"。
 *
 * 用 replace 顶掉旧房间后：
 *   - 旧房间的 PlayerPage 在本次路由切换中正常卸载（播放器 destroy、
 *     弹幕退订、定时器清理都走既有卸载路径）；
 *   - B 的上一页直接是进入 A 之前的那一页（平台列表 / 订阅页），
 *     退出 B 不会再回到 A。
 */
export function useOpenPlayer(): (platform: LivePlatform, roomId: string) => void {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return useCallback(
    (platform: LivePlatform, roomId: string) => {
      const href = playerPath(platform, roomId);
      if (pathname.startsWith("/player")) navigate(href, { replace: true });
      else navigate(href);
    },
    [navigate, pathname],
  );
}
