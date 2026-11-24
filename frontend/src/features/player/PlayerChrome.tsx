import {
  Maximize,
  MessageSquare,
  MessageSquareOff,
  Minimize2,
  Monitor,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  PictureInPicture2,
  Play,
  RotateCw,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { PLATFORM_LABEL, PLATFORM_LOGO, type LineOption, type LivePlatform } from "@/api";
import { cn } from "@/lib/cn";
import { ControlsDropdown } from "./ControlsDropdown";
import { DanmuBlockControl } from "./DanmuBlockControl";
import { DanmuSettingsControl } from "./DanmuSettingsControl";
import { VolumeSlider } from "./VolumeSlider";
import type { DanmuUserSettings } from "./danmuSettings";
import type { PlayState } from "./useXgPlayer";
import styles from "./PlayerChrome.module.css";

export interface PlayerChromeProps {
  /* ---------------------------------------------------------- 顶部信息栏 */
  platform: LivePlatform;
  roomId: string;
  nickname: string;
  /** 房间标题（可选，显示在昵称下方；卡片不传，保持紧凑） */
  title?: string;
  /** 关注文件夹徽章（工作台卡片用） */
  groupBadge?: string;
  /** 直播中 / 轮播中 / 未开播 徽章（可选） */
  statusBadge?: ReactNode;
  /** 关注按钮 / 平台登录按钮等附加操作（可选） */
  headerActions?: ReactNode;
  /** 右上角关闭按钮（卡片=移除房间） */
  onClose: () => void;
  closeTitle: string;
  closeLabel: string;
  /** 系统级全屏时右上角要让给窗口按钮 */
  headerInsetRight?: boolean;
  /** 空闲隐藏（鼠标静止 2s；由宿主驱动） */
  hidden?: boolean;

  /* ---------------------------------------------------------- 底部控制条 */
  playState: PlayState;
  /** 正在重新拉流（未开播时播放器没有实例，不能只看 playState） */
  busy?: boolean;
  /** 没有可播的流时禁用播放/暂停按钮（卡片未开播用） */
  playDisabled?: boolean;
  /** 播放/暂停按钮文案（默认按播放状态；卡片暂停时显示"继续播放"） */
  playTitle?: string;
  onTogglePlay: () => void;
  onReload: () => void;
  volume: number;
  /** 音量上限：默认 1，工作台卡片 2（>1 走 Web Audio 增益） */
  volumeMax?: number;
  volumeLabel?: string;
  onVolume: (v: number) => void;
  /** 音量按钮的语义：默认=静音切换，卡片=音频焦点开关 */
  volumeActive?: boolean;
  volumeButtonTitle: string;
  volumeButtonLabel: string;
  onVolumeButton: () => void;
  /** 卡片语义：音量按钮按焦点状态显示图标（而非按音量值） */
  volumeIconByActive?: boolean;
  /** 音量增强不可用提示（卡片音量 >1 时） */
  boostWarning?: boolean;
  danmuEnabled: boolean;
  onToggleDanmu: () => void;
  danmuSettings: DanmuUserSettings;
  onDanmuSettingsChange: (patch: Partial<DanmuUserSettings>) => void;
  colorfulSupported: boolean;
  blockKeywords: string[];
  onAddBlockKeyword: (keyword: string) => void;
  onRemoveBlockKeyword: (keyword: string) => void;
  onClearBlockKeywords: () => void;
  danmuPanelOpen: boolean;
  onToggleDanmuPanel: () => void;
  lines: LineOption[];
  lineId: string;
  onLine: (id: string) => void;
  qualities: Array<{ id: string; label: string }>;
  qualityId: string;
  /** 当前实际画质显示名（斗鱼匿名降级时与所选档位不同） */
  qualityLabel?: string;
  onQuality: (id: string) => void;
  /** 画中画小窗（可选；不支持/未提供时不显示按钮） */
  pipSupported?: boolean;
  pipActive?: boolean;
  onTogglePip?: () => void;
  /** 工作台内全屏（Monitor 按钮） */
  windowFullscreen: boolean;
  onToggleWindowFullscreen: () => void;
  /** 直播间全屏（DOM Fullscreen API） */
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** 是否有弹层（线路/画质/弹幕设置/屏蔽）打开：打开期间宿主不自动隐藏 chrome。
   * 悬停不再上报 —— 鼠标停在控制栏上也照常 2s 隐藏（用户要求）。 */
  onMenuOpenChange?: (open: boolean) => void;
  /** 宿主进入空闲隐藏时触发：关掉所有靠悬停打开的下拉/面板。
   * 否则鼠标停在「线路/清晰度/弹幕设置」上悬停展开的弹层会一直算"打开"，
   * chrome 永远不隐藏（用户实测：全屏鼠标不动 2s 后控制条仍在）。 */
  closeSignal?: number;
}

/**
 * 直播间播放器 chrome：顶部主播信息栏 + 底部控制条。
 *
 * 由工作台卡片（RoomTile）使用（单房间播放页已移除，直播间统一在工作台打开）。
 * 显隐由宿主控制：CSS :hover / :focus-within（见 RoomTile.module.css）+
 * 悬停静止 2s 的空闲隐藏（宿主加 .hidden 类，移动鼠标立即唤回）。
 */
export function PlayerChrome(props: PlayerChromeProps) {
  const playing = props.playState === "playing";
  const loading = props.busy || props.playState === "loading" || props.playState === "buffering";
  const volumeMax = props.volumeMax ?? 1;
  const muted = props.volume === 0;
  const VolumeIcon = props.volumeIconByActive
    ? props.volumeActive
      ? Volume2
      : VolumeX
    : muted
      ? VolumeX
      : props.volume < 0.5
        ? Volume1
        : Volume2;
  const qualityLabel =
    props.qualityLabel ?? props.qualities.find((q) => q.id === props.qualityId)?.label ?? "原画";
  const lineLabel = props.lines.find((l) => l.id === props.lineId)?.label ?? "线路";

  const onMenuOpenChange = props.onMenuOpenChange;
  /* 四个下拉/弹层共用一个上报口：按来源计数，任何一个还开着就算"有弹层"。
   * 之前用单个布尔，一个子组件关闭（false）会覆盖另一个的打开状态。
   * 只有点击/键盘打开（persistent）才计数：悬停展开的弹层不算，
   * 否则鼠标停在「线路/清晰度/弹幕设置」上时 chrome 永远不自动隐藏。 */
  const openMenusRef = useRef(new Set<string>());
  const makeMenuOpenHandler = useCallback(
    (id: string) => (open: boolean, persistent: boolean) => {
      if (open && persistent) openMenusRef.current.add(id);
      else openMenusRef.current.delete(id);
      onMenuOpenChange?.(openMenusRef.current.size > 0);
    },
    [onMenuOpenChange],
  );
  const blockMenuOpen = useMemo(() => makeMenuOpenHandler("block"), [makeMenuOpenHandler]);
  const settingsMenuOpen = useMemo(() => makeMenuOpenHandler("settings"), [makeMenuOpenHandler]);
  const lineMenuOpen = useMemo(() => makeMenuOpenHandler("line"), [makeMenuOpenHandler]);
  const qualityMenuOpen = useMemo(() => makeMenuOpenHandler("quality"), [makeMenuOpenHandler]);

  /* 宿主空闲隐藏时把悬停展开的弹层一并收掉（子组件自己上报关闭）。 */
  const closeSignal = props.closeSignal ?? 0;

  return (
    <>
      <header
        className={cn(
          styles.header,
          props.headerInsetRight && styles.headerInsetRight,
          props.hidden && styles.hidden,
        )}
      >
        <img className={styles.logo} src={PLATFORM_LOGO[props.platform]} alt="" />
        <div className={styles.roomMeta}>
          <span className={styles.nickname}>{props.nickname}</span>
          {props.title && <span className={styles.roomTitle}>{props.title}</span>}
          <span className={styles.roomNumber}>
            {PLATFORM_LABEL[props.platform]} · {props.roomId}
          </span>
          {props.groupBadge && <span className={styles.groupBadge}>{props.groupBadge}</span>}
        </div>
        {props.statusBadge}
        {props.headerActions}
        <button
          type="button"
          className={styles.iconButton}
          onClick={props.onClose}
          title={props.closeTitle}
          aria-label={props.closeLabel}
        >
          <X size={15} />
        </button>
      </header>

      <footer className={cn(styles.footer, props.hidden && styles.hidden)}>
        <div className={styles.playbackControls}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={props.onTogglePlay}
            disabled={props.playDisabled || props.playState === "idle"}
            title={props.playTitle ?? (playing ? "暂停" : "播放")}
            aria-label={props.playTitle ?? (playing ? "暂停" : "播放")}
          >
            {playing ? (
              <Pause size={22} strokeWidth={2} fill="currentColor" />
            ) : (
              <Play size={22} strokeWidth={2} fill="currentColor" />
            )}
          </button>
          <button
            type="button"
            className={cn(styles.iconButton, loading && styles.refreshing)}
            onClick={props.onReload}
            title="刷新直播"
            aria-label="刷新直播"
          >
            <RotateCw size={19} strokeWidth={2} />
          </button>
        </div>

        <div className={styles.audioControl}>
          <button
            type="button"
            className={cn(styles.iconButton, props.volumeActive && styles.activeButton)}
            onClick={props.onVolumeButton}
            aria-pressed={props.volumeActive}
            title={props.volumeButtonTitle}
            aria-label={props.volumeButtonLabel}
          >
            <VolumeIcon size={18} strokeWidth={2} />
          </button>
          <div className={styles.volumeControl}>
            <VolumeSlider
              className={styles.volumeSlider}
              label={props.volumeLabel ?? "音量"}
              value={props.volume}
              max={volumeMax}
              step={volumeMax > 1 ? 0.05 : volumeMax / 100}
              orientation="vertical"
              onChange={props.onVolume}
            />
            <span className={styles.volumeValue}>{Math.round(props.volume * 100)}%</span>
          </div>
        </div>
        {props.boostWarning && (
          <span className={styles.boostWarning} role="status">
            增强不可用
          </span>
        )}

        <div className={styles.roomControls}>
          <button
            type="button"
            className={cn(styles.iconButton, props.danmuEnabled && styles.activeButton)}
            onClick={props.onToggleDanmu}
            aria-pressed={props.danmuEnabled}
            title={props.danmuEnabled ? "关闭弹幕" : "开启弹幕"}
            aria-label={props.danmuEnabled ? "关闭弹幕" : "开启弹幕"}
          >
            {props.danmuEnabled ? <MessageSquare size={18} /> : <MessageSquareOff size={18} />}
          </button>
          <DanmuBlockControl
            keywords={props.blockKeywords}
            onAdd={props.onAddBlockKeyword}
            onRemove={props.onRemoveBlockKeyword}
            onClear={props.onClearBlockKeywords}
            onOpenChange={blockMenuOpen}
          />
          <button
            type="button"
            className={cn(styles.iconButton, props.danmuPanelOpen && styles.activeButton)}
            onClick={props.onToggleDanmuPanel}
            aria-pressed={props.danmuPanelOpen}
            title={props.danmuPanelOpen ? "关闭弹幕列表" : "打开弹幕列表"}
            aria-label={props.danmuPanelOpen ? "关闭弹幕列表" : "打开弹幕列表"}
          >
            {props.danmuPanelOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </button>
          <DanmuSettingsControl
            settings={props.danmuSettings}
            onChange={props.onDanmuSettingsChange}
            supportsColor={props.colorfulSupported}
            onOpenChange={settingsMenuOpen}
            closeSignal={closeSignal}
          />
          {props.lines.length > 1 && props.lineId && (
            <ControlsDropdown
              label="线路"
              valueId={props.lineId}
              valueLabel={lineLabel}
              options={props.lines.map((l) => ({ id: l.id, label: l.label }))}
              onSelect={props.onLine}
              onOpenChange={lineMenuOpen}
              closeSignal={closeSignal}
            />
          )}
          <ControlsDropdown
            label="清晰度"
            valueId={props.qualityId}
            valueLabel={qualityLabel}
            options={props.qualities}
            onSelect={props.onQuality}
            onOpenChange={qualityMenuOpen}
            closeSignal={closeSignal}
          />
          {props.pipSupported && props.onTogglePip && (
            <button
              type="button"
              className={cn(styles.iconButton, props.pipActive && styles.activeButton)}
              onClick={props.onTogglePip}
              aria-label={props.pipActive ? "退出小窗" : "小窗播放"}
              title={props.pipActive ? "退出小窗" : "小窗播放"}
            >
              <PictureInPicture2 size={18} strokeWidth={2} />
            </button>
          )}
          <button
            type="button"
            className={cn(styles.iconButton, props.windowFullscreen && styles.activeButton)}
            onClick={props.onToggleWindowFullscreen}
            aria-pressed={props.windowFullscreen}
            title={props.windowFullscreen ? "退出窗口全屏" : "窗口全屏"}
            aria-label={props.windowFullscreen ? "退出窗口全屏" : "窗口全屏"}
          >
            <Monitor size={18} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={props.onToggleFullscreen}
            title={props.fullscreen ? "退出直播间全屏" : "直播间全屏"}
            aria-label={props.fullscreen ? "退出直播间全屏" : "直播间全屏"}
          >
            {props.fullscreen ? <Minimize2 size={18} /> : <Maximize size={18} />}
          </button>
        </div>
      </footer>
    </>
  );
}