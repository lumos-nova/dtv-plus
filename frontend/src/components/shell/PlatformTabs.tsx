import { Tabs } from "@heroui/react";
import { Grid2X2 } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { PLATFORM_LABEL, PLATFORM_LOGO, PLATFORM_TAB_ORDER, type LivePlatform } from "@/api";
import { cn } from "@/lib/cn";
import styles from "./PlatformTabs.module.css";

/** 导航项：四个平台 + "订阅"。"订阅"不是平台，但和平台同级切换。 */
type TabId = LivePlatform | "monitor";

const TABS: TabId[] = ["monitor", ...PLATFORM_TAB_ORDER];

const TAB_PATH: Record<TabId, string> = {
  monitor: "/monitor",
  douyu: "/",
  huya: "/huya",
  douyin: "/douyin",
  bilibili: "/bilibili",
};

function activeTabFromPath(pathname: string): TabId {
  if (pathname.startsWith("/monitor")) return "monitor";
  if (pathname.startsWith("/add-room")) return "douyu";
  if (pathname.startsWith("/huya")) return "huya";
  if (pathname.startsWith("/douyin")) return "douyin";
  if (pathname.startsWith("/bilibili")) return "bilibili";
  return "douyu";
}

/**
 * 平台切换：HeroUI v3 Tabs 作为交互内核，视觉仍然是 Signal 的分段控件。
 *
 * 用 HeroUI 的 Tabs / List / Tab / Indicator 替换手写的滑块计算：
 * 选中项、键盘左右键、焦点管理交给 React Aria；我们只覆盖尺寸和配色。
 */
export function PlatformTabs() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const active = activeTabFromPath(pathname);

  const go = (next: TabId) => {
    if (!(next in TAB_PATH)) return;
    const target = TAB_PATH[next];
    // M-03：支持的运行时用 View Transitions 做 180ms 淡入；不支持直接切。
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const start = (
      document as Document & {
        startViewTransition?: (cb: () => void) => unknown;
      }
    ).startViewTransition;
    if (!reduce && typeof start === "function") {
      start.call(document, () => navigate(target));
      return;
    }
    navigate(target);
  };

  return (
    <Tabs
      selectedKey={active}
      onSelectionChange={(key) => go(String(key) as TabId)}
      className={styles.tabs}
    >
      <Tabs.ListContainer className={styles.track}>
        <Tabs.List className={styles.list} aria-label="内容切换">
          {TABS.map((tab) => (
            <Tabs.Tab
              key={tab}
              id={tab}
              className={cn(styles.tab, styles.noDrag)}
              aria-label={tab === "monitor" ? "多房间工作台" : `${PLATFORM_LABEL[tab]}直播`}
            >
              {tab === "monitor" ? (
                <Grid2X2 size={14} strokeWidth={2.2} className={styles.tabIcon} />
              ) : (
                <img
                  src={PLATFORM_LOGO[tab]}
                  alt=""
                  className={styles.platformLogo}
                  aria-hidden="true"
                />
              )}
              <Tabs.Indicator className={styles.indicator} />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}
