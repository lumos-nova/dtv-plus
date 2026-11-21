import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import styles from "./VolumeSlider.module.css";

const KEYBOARD_STEP = 0.05;
const PAGE_STEP = 0.1;

interface VolumeSliderProps {
  /** 0 ~ max */
  value: number;
  onChange: (value: number) => void;
  max?: number;
  step?: number;
  className?: string;
  label?: string;
  orientation?: "horizontal" | "vertical";
}

const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));

/**
 * 音量条：没有拖动手柄，按住滑条左右滑就行。
 *
 * 设计上刻意不画 thumb —— 控制栏空间很紧，一个滑条 + 一个百分比数字已经
 * 足够表达"当前音量"。交互上整条都是热区（比轨道本身更容易操作），
 * 按下即跳转到该位置并开始拖动；松手、指针离开、失焦都会结束拖动。
 *
 * 键盘可访问：方向键微调 5%，PageUp/PageDown 调 10%，Home/End 到范围端点。
 */
export function VolumeSlider({
  value,
  onChange,
  max = 1,
  step = max / 100,
  className,
  label = "音量",
  orientation = "horizontal",
}: VolumeSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [hovering, setHovering] = useState(false);

  const clampedValue = clamp(value, max);
  const percent = Math.round(clampedValue * 100);
  const fillPercent = Math.round((clampedValue / max) * 100);

  const applyFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const length = orientation === "vertical" ? rect.height : rect.width;
      if (length <= 0) return;
      // 按调用方步长取整，避免浮点抖动并让数值稳定
      const progress =
        orientation === "vertical"
          ? (rect.bottom - clientY) / rect.height
          : (clientX - rect.left) / rect.width;
      const rawValue = clamp(progress * max, max);
      const steppedValue = Math.round(rawValue / step) * step;
      onChange(Number(clamp(steppedValue, max).toFixed(2)));
    },
    [max, onChange, orientation, step],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      try {
        // 捕获指针：拖到控制栏外面也继续跟随（部分 WebView 会拒绝，忽略即可）
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 忽略：没有捕获也能靠 pointermove 拖动
      }
      setDragging(true);
      applyFromPointer(event.clientX, event.clientY);
    },
    [applyFromPointer],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      applyFromPointer(event.clientX, event.clientY);
    },
    [applyFromPointer, dragging],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    setDragging(false);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // 指针已经释放时忽略
    }
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const current = clamp(value, max);
      let next: number | null = null;
      switch (event.key) {
        case "ArrowLeft":
          if (orientation === "vertical") return;
          next = current - max * KEYBOARD_STEP;
          break;
        case "ArrowRight":
          if (orientation === "vertical") return;
          next = current + max * KEYBOARD_STEP;
          break;
        case "ArrowDown":
          next = current - max * KEYBOARD_STEP;
          break;
        case "ArrowUp":
          next = current + max * KEYBOARD_STEP;
          break;
        case "PageDown":
          next = current - max * PAGE_STEP;
          break;
        case "PageUp":
          next = current + max * PAGE_STEP;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = max;
          break;
        default:
          return;
      }
      event.preventDefault();
      onChange(Number(clamp(Math.round(next / step) * step, max).toFixed(2)));
    },
    [max, onChange, orientation, step, value],
  );

  return (
    <div
      ref={trackRef}
      className={cn(
        styles.slider,
        orientation === "vertical" && styles.vertical,
        (dragging || hovering) && styles.active,
        dragging && styles.dragging,
        className,
      )}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max * 100)}
      aria-valuenow={percent}
      aria-valuetext={`${percent}%`}
      aria-orientation={orientation}
      title={`${label} ${percent}%（按住${orientation === "vertical" ? "上下" : "左右"}拖动）`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={(event) => {
        setHovering(false);
        if (dragging) endDrag(event);
      }}
      onKeyDown={onKeyDown}
    >
      <div className={styles.rail}>
        <div
          className={styles.fill}
          style={
            orientation === "vertical"
              ? { height: `${fillPercent}%` }
              : { width: `${fillPercent}%` }
          }
        />
      </div>
    </div>
  );
}
