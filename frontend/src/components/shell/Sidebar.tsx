import { useEffect, useState, type CSSProperties } from "react";
import { FollowsList } from "@/components/shell/FollowsList";
import { cn } from "@/lib/cn";
import { loadJSON, saveJSON } from "@/lib/storage";
import { useFollow } from "@/state/FollowProvider";
import styles from "./Sidebar.module.css";

const COLLAPSED_KEY = "dtv_sidebar_collapsed_v1";

/**
 * 侧边栏固定宽度 = 筛选行（全部 / 在线 / 4 个平台）所有按钮加宽后的宽度总和：
 *   6 × (32px × 4/3) = 256px  按钮（与 FollowsList.module.css .filterBtn 一致）
 *   + 6px  filterBar 左右 padding(3×2)
 *   + 2px  filterBar 左右 border(1×2)
 *   + 16px .content 左右 padding(8×2)
 *   + 1px  侧栏右描边
 * = 281px，恰好让筛选行单行排满，不再支持拖拽改宽。
 */
const FIXED_WIDTH = (32 * 4 * 6) / 3 + 6 + 2 + 16 + 1;

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
  const [userExpandedEmpty, setUserExpandedEmpty] = useState(false);

  useEffect(() => {
    saveJSON(COLLAPSED_KEY, collapsed);
  }, [collapsed]);

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
      style={{ "--sidebar-width": `${FIXED_WIDTH}px` } as CSSProperties}
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
    </aside>
  );
}
