import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { FollowsList } from "@/components/shell/FollowsList";
import { cn } from "@/lib/cn";
import { loadJSON, saveJSON } from "@/lib/storage";
import { useFollow } from "@/state/FollowProvider";
import styles from "./Sidebar.module.css";

const COLLAPSED_KEY = "dtv_sidebar_collapsed_v1";
const WIDTH_KEY = "dtv_sidebar_width_v1";
const DEFAULT_WIDTH = 224;
const MIN_WIDTH = 200;

/**
 * 左侧栏。
 *
 * 折叠状态由这里持有（而不是 FollowsList）：折叠时**侧栏宽度**也要从 240px
 * 收到 78px，只压缩内部内容会留下一条空白列。状态持久化到 localStorage。
 *
 * L-02：关注为空时自动收成 rail，把 240px 还给内容区；用户手动展开后
 * 仍然尊重手动状态（不会因为空列表反复弹开）。
 */
export function Sidebar() {
  const { follows } = useFollow();
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    loadJSON<boolean>(COLLAPSED_KEY, false),
  );
  const [width, setWidth] = useState(() => {
    const saved = loadJSON<number>(WIDTH_KEY, DEFAULT_WIDTH);
    return Number.isFinite(saved) ? Math.max(MIN_WIDTH, Math.min(480, saved)) : DEFAULT_WIDTH;
  });
  const [userExpandedEmpty, setUserExpandedEmpty] = useState(false);
  const resizeStartRef = useRef<{ pointerId: number; x: number; width: number } | null>(null);

  useEffect(() => {
    saveJSON(COLLAPSED_KEY, collapsed);
  }, [collapsed]);

  useEffect(() => {
    saveJSON(WIDTH_KEY, width);
  }, [width]);

  const resizeSidebar = (event: PointerEvent<HTMLButtonElement>) => {
    const start = resizeStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const maxWidth = Math.min(480, Math.floor(window.innerWidth * 0.42));
    setWidth(Math.max(MIN_WIDTH, Math.min(maxWidth, start.width + event.clientX - start.x)));
  };

  const autoCollapsed = follows.length === 0 && !userExpandedEmpty;
  const effectiveCollapsed = collapsed || autoCollapsed;

  /* 让主播网格知道侧栏当前是否折叠，折叠时用更窄的卡片下限多排一列 */
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.sidebarCollapsed = effectiveCollapsed ? "true" : "false";
    return () => {
      delete root.dataset.sidebarCollapsed;
    };
  }, [effectiveCollapsed]);

  return (
    <aside
      className={cn(styles.sidebar, effectiveCollapsed && styles.collapsed)}
      style={{ "--sidebar-width": `${width}px` } as CSSProperties}
    >
      <div className={styles.body}>
        <FollowsList
          collapsed={effectiveCollapsed}
          onToggleCollapsed={() => {
            if (autoCollapsed) {
              setUserExpandedEmpty(true);
              return;
            }
            setUserExpandedEmpty(false);
            setCollapsed((v) => !v);
          }}
        />
      </div>
      {!effectiveCollapsed && (
        <button
          type="button"
          className={styles.resizeHandle}
          aria-label="拖动调整侧边栏宽度"
          title="拖动调整侧边栏宽度"
          onPointerDown={(event) => {
            event.preventDefault();
            resizeStartRef.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              width,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={resizeSidebar}
          onPointerUp={(event) => {
            if (resizeStartRef.current?.pointerId === event.pointerId) {
              resizeStartRef.current = null;
            }
          }}
          onPointerCancel={() => {
            resizeStartRef.current = null;
          }}
        />
      )}
    </aside>
  );
}
