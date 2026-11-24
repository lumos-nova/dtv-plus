import { Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { LIVE_PLATFORMS, type LivePlatform } from "@/api";
import { AppShell } from "@/components/shell/AppShell";
import { AddRoomPage } from "@/screens/AddRoomPage";
import { MonitorPage } from "@/screens/MonitorPage";
import { NotFoundPage } from "@/screens/NotFoundPage";

/**
 * 旧播放页深链接的兼容重定向（播放页已移除，直播间统一在工作台打开）。
 *
 * `/player?platform=&roomId=` → `/monitor`，房间经 location.state 传递
 * （与 useOpenMonitorRoom 同一通道），MonitorPage 消费后立刻清掉，
 * 刷新 / 后退不会重复加房。参数缺失或非法时只落到工作台首页。
 */
function PlayerRedirect() {
  const [params] = useSearchParams();
  const platform = params.get("platform");
  const roomId = params.get("roomId");
  const state =
    platform && roomId && LIVE_PLATFORMS.includes(platform as LivePlatform)
      ? { dtvMonitorRoom: { platform: platform as LivePlatform, roomId } }
      : undefined;
  return <Navigate to="/monitor" replace state={state} />;
}

/**
 * 路由表。
 *
 * 旧项目是 Next.js App Router 的 6 个 app/{平台}/page.tsx，URL 带尾斜杠
 *（trailingSlash: true），且 `usePathname()` 的比较在 4 个组件里各自硬编码。
 * 这里集中一张表；URL 形状保持一致，以便沿用旧的深链接习惯。
 *
 * `/custom` 是旧版"自定义分区"的地址，现在改叫订阅分区（`/subscribe`），
 * `/player` 是已移除的单房间播放页 —— 各保留一条重定向，
 * 旧的书签/深链接不会 404。
 */
export const ROUTES = {
  home: "/",
  huya: "/huya",
  douyin: "/douyin",
  bilibili: "/bilibili",
  addRoom: "/add-room",
  monitor: "/monitor",
  custom: "/custom",
} as const;

/** 首页由 AppShell 里的 HomeStack 常驻渲染，路由只需要占位。 */
function HomeRoute() {
  return null;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<HomeRoute />} />
        <Route path="/huya" element={<HomeRoute />} />
        <Route path="/douyin" element={<HomeRoute />} />
        <Route path="/bilibili" element={<HomeRoute />} />
        <Route path="/add-room" element={<AddRoomPage />} />
        <Route path="/monitor" element={<MonitorPage />} />
        <Route path="/subscribe" element={<Navigate to="/" replace />} />
        <Route path="/custom" element={<Navigate to="/" replace />} />
        <Route path="/player" element={<PlayerRedirect />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
