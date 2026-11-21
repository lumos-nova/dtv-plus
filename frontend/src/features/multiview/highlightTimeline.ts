/**
 * 「回溯精彩」时间轴的纯逻辑：选区裁剪、时间格式化、刻度。
 * 与组件分离，方便 vitest 回归。
 */

export interface HighlightSelection {
  start: number;
  end: number;
}

export const MIN_SELECTION_SECONDS = 0.5;

/** 把选区裁剪到 [0, duration]，并保证最小跨度。 */
export function clampSelection(
  selection: HighlightSelection,
  duration: number,
): HighlightSelection {
  const total = Math.max(0, duration);
  const minSpan = Math.min(MIN_SELECTION_SECONDS, total);
  let start = Math.max(0, Math.min(total, selection.start));
  let end = Math.max(0, Math.min(total, selection.end));
  if (end < start) [start, end] = [end, start];
  if (end - start < minSpan) {
    if (start + minSpan <= total) {
      end = start + minSpan;
    } else {
      start = Math.max(0, end - minSpan);
    }
  }
  return { start, end };
}

/** mm:ss.cc（当前播放位置显示）。用整数厘秒避免浮点截断误差。 */
export function formatTimecode(seconds: number): string {
  const centisTotal = Math.max(0, Math.round(seconds * 100));
  const minutes = Math.floor(centisTotal / 6000);
  const secs = Math.floor((centisTotal % 6000) / 100);
  const centis = centisTotal % 100;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

/** HH:MM:SS（选区对应的墙上时钟）。 */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 每 15 秒一个刻度（0 起点，不含超出 duration 的刻度）。 */
export function timelineTicks(duration: number): number[] {
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += 15) ticks.push(t);
  return ticks;
}

/** 默认选区：缓冲末尾 5 秒（不足 5 秒取全部）。 */
export function defaultSelection(duration: number): HighlightSelection {
  const total = Math.max(0, duration);
  return clampSelection({ start: Math.max(0, total - 5), end: total }, total);
}