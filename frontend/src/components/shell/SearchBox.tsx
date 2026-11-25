import { Card, ListBox } from "@heroui/react";
import { Search, Star, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, PLATFORM_LABEL, PLATFORM_TAB_ORDER, type LivePlatform, type SearchHit } from "@/api";
import { SmoothImage } from "@/components/common/SmoothImage";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import { useOpenMonitorRoom } from "@/lib/navigation";
import { useFollow } from "@/state/FollowProvider";
import styles from "./SearchBox.module.css";

type SearchResult = SearchHit & { platform: LivePlatform; key: string };

/**
 * 跨平台搜索框。
 *
 * 旧版把搜索状态（query/results/error/focused/防抖/外部点击关闭/Esc 清空）
 * 全部塞在 800 行的 Navbar 里，还靠 `eslint-disable exhaustive-deps` 兜底。
 * 这里独立成组件 + 一个 `useDebouncedSearch` 小 hook，状态机清晰。
 *
 * U-04：↑/↓ 在结果间移动、Enter 打开当前项、Esc 关闭；Ctrl/Cmd+K 聚焦。
 */
export function SearchBox() {
  const openRoomNavigation = useOpenMonitorRoom();
  const { isFollowing, toggleFollow } = useFollow();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listWrapRef = useRef<HTMLDivElement>(null);
  const [hoverBox, setHoverBox] = useState({ top: 0, height: 0, visible: false });

  const showHover = useCallback((el: HTMLElement) => {
    const root = listWrapRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const itemRect = el.getBoundingClientRect();
    setHoverBox({
      top: itemRect.top - rootRect.top + root.scrollTop,
      height: itemRect.height,
      visible: true,
    });
  }, []);

  const hideHover = useCallback(() => {
    setHoverBox((prev) => (prev.visible ? { ...prev, visible: false } : prev));
  }, []);

  // 防抖搜索（用 cancelled 标记丢弃过期响应）
  useEffect(() => {
    const kw = query.trim();
    setActiveIndex(-1);
    if (!kw) {
      setHits([]);
      setError(null);
      setWarning(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setHits([]);
    setLoading(true);
    setError(null);
    setWarning(null);
    const platforms = PLATFORM_TAB_ORDER.filter(
      (platform) => platform !== "douyin" || /^\d+$/.test(kw),
    );
    const timer = window.setTimeout(() => {
      void Promise.allSettled(
        platforms.map(async (platform) => ({
          platform,
          hits: await api.search(platform, kw),
        })),
      ).then((results) => {
        if (cancelled) return;
        const successful = results.filter(
          (
            result,
          ): result is PromiseFulfilledResult<{
            platform: LivePlatform;
            hits: SearchHit[];
          }> => result.status === "fulfilled",
        );
        const failedCount = results.length - successful.length;
        if (successful.length === 0) {
          const failure = results.find((result) => result.status === "rejected");
          setError(
            failure?.status === "rejected" && failure.reason instanceof Error
              ? failure.reason.message
              : "所有平台搜索失败",
          );
          setLoading(false);
          return;
        }
        setHits(
          successful.flatMap(({ value }) =>
            value.hits.map((hit) => ({
              ...hit,
              platform: value.platform,
              key: `${value.platform}:${hit.id}`,
            })),
          ),
        );
        setWarning(failedCount > 0 ? `${failedCount} 个平台搜索失败，已显示其余结果` : null);
        setLoading(false);
      });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    hideHover();
  }, [query, hits, hideHover]);

  // 点击外部关闭结果
  useEffect(() => {
    if (!focused) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setFocused(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [focused]);

  // Ctrl/Cmd+K 聚焦搜索
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openRoom = useCallback(
    (result: SearchResult) => {
      setFocused(false);
      setQuery("");
      // 进入直播间后把焦点还给页面：否则焦点留在搜索框里，
      // 监看页的空格 / Esc / F 等快捷键会因为“正在输入”而被忽略。
      inputRef.current?.blur();
      // todo05：搜索结果直接在多平台监看页打开；已在 /monitor 时 replace，
      // 不把旧状态留在历史栈里。
      openRoomNavigation(result.platform, result.id);
    },
    [openRoomNavigation],
  );

  const onSubmit = () => {
    const kw = query.trim();
    if (!kw) return;
    if (activeIndex >= 0 && hits[activeIndex]) {
      openRoom(hits[activeIndex]);
    } else if (hits.length === 1) {
      openRoom(hits[0]);
    }
  };

  // 搜索结果旁的关注按钮：直接关注/取消关注该主播，不打开直播间。
  const toggleFollowHit = useCallback(
    (hit: SearchResult) => {
      toggleFollow({
        id: hit.id,
        platform: hit.platform,
        nickname: hit.nickname,
        title: hit.title,
        cover: "",
        avatar: hit.avatar,
        viewers: 0,
        categoryName: "",
        isLive: hit.isLive,
      });
    },
    [toggleFollow],
  );

  const moveActive = (delta: number) => {
    if (hits.length === 0) return;
    setActiveIndex((prev) => {
      const next = prev + delta;
      if (next < 0) return hits.length - 1;
      if (next >= hits.length) return 0;
      return next;
    });
  };

  useEffect(() => {
    if (activeIndex < 0) return;
    const el = listWrapRef.current?.querySelector<HTMLElement>(
      `[data-search-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const showPanel = focused && query.trim().length > 0;

  return (
    <div className={styles.root} ref={rootRef}>
      <div className={cn(styles.shell, focused && styles.shellFocused)}>
        <input
          ref={inputRef}
          className={styles.input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              moveActive(1);
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              moveActive(-1);
            }
            if (e.key === "Escape") {
              setQuery("");
              setFocused(false);
              inputRef.current?.blur();
            }
          }}
          placeholder="搜索所有平台主播或直播间…"
          aria-label="搜索所有平台主播或直播间"
          title="搜索所有平台关键词或房间号，↑↓ 选择，Enter 打开"
          spellCheck={false}
        />
        {query && (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => setQuery("")}
            aria-label="清空搜索"
          >
            <X size={15} strokeWidth={2.4} />
          </button>
        )}
        {loading ? (
          <span className={styles.spinnerWrap}>
            <Spinner size={14} />
          </span>
        ) : (
          <button type="button" className={styles.iconBtn} onClick={onSubmit} aria-label="搜索">
            <Search size={17} strokeWidth={2.4} />
          </button>
        )}
      </div>

      {showPanel && (
        <Card className={styles.panel} onMouseLeave={hideHover}>
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>搜索结果</span>
            <span className={styles.panelCount}>{loading ? "搜索中" : `${hits.length} 条`}</span>
          </div>

          {error ? (
            <p className={styles.meta}>{error}</p>
          ) : (
            <>
              {warning && <p className={styles.meta}>{warning}</p>}
              {!loading && hits.length === 0 ? (
                <p className={styles.meta}>未找到结果，请检查关键词或房间号</p>
              ) : (
                <div
                  className={styles.listWrap}
                  ref={listWrapRef}
                  onScroll={hideHover}
                  onMouseLeave={hideHover}
                >
                  <div
                    className={styles.hoverLayer}
                    style={{
                      opacity: hoverBox.visible ? 1 : 0,
                      transform: `translate3d(0, ${hoverBox.top}px, 0)`,
                      height: hoverBox.height,
                    }}
                    aria-hidden="true"
                  />
                  <ListBox
                    className={styles.list}
                    aria-label="搜索结果"
                    selectionMode="none"
                    onAction={(key) => {
                      const result = hits.find((hit) => hit.key === String(key));
                      if (result) openRoom(result);
                    }}
                  >
                    {hits.map((hit, index) => (
                      <ListBox.Item
                        key={hit.key}
                        id={hit.key}
                        textValue={`${PLATFORM_LABEL[hit.platform]} ${hit.nickname} ${hit.title}`}
                        className={cn(styles.item, activeIndex === index && styles.itemActive)}
                        data-search-index={index}
                        onMouseEnter={(event) => {
                          showHover(event.currentTarget);
                          setActiveIndex(index);
                        }}
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        <span className={styles.avatar}>
                          <SmoothImage src={hit.avatar} alt={hit.nickname} rounded />
                        </span>
                        <span className={styles.itemMain}>
                          <span className={styles.itemName}>{hit.nickname}</span>
                          <span className={styles.itemTitle}>{hit.title}</span>
                        </span>
                        <span className={styles.platformTag}>{PLATFORM_LABEL[hit.platform]}</span>
                        <span className={cn(styles.dot, hit.isLive && styles.dotLive)} />
                        <button
                          type="button"
                          className={cn(
                            styles.followBtn,
                            isFollowing(hit.platform, hit.id) && styles.followBtnOn,
                          )}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFollowHit(hit);
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                          aria-label={
                            isFollowing(hit.platform, hit.id)
                              ? `取消关注 ${hit.nickname}`
                              : `关注 ${hit.nickname}`
                          }
                          title={isFollowing(hit.platform, hit.id) ? "取消关注" : "关注"}
                        >
                          <Star
                            size={14}
                            strokeWidth={2.2}
                            fill={isFollowing(hit.platform, hit.id) ? "currentColor" : "none"}
                          />
                        </button>
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </div>
              )}
            </>
          )}

          <p className={styles.hint}>搜索所有已接入平台 · 抖音仅支持房间号</p>
        </Card>
      )}
    </div>
  );
}
