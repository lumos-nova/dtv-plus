/**
 * 「回溯精彩」的 ASS 字幕生成：把选区内的历史弹幕做成滚动字幕，
 * 可选叠加当前直播标题。导出时交给 ffmpeg 的 ass 滤镜烧录进画面
 *（字体用 public/fonts/NotoSansSC-Regular.otf，OFL 许可）。
 */

export interface AssMessage {
  content: string;
  /** 收到时间戳（ms，epoch） */
  at: number;
  color?: string;
  kind: string;
}

export interface AssOptions {
  /** 选区起点（ms，epoch） */
  startMs: number;
  /** 选区终点（ms，epoch） */
  endMs: number;
  width: number;
  height: number;
  title?: string;
  includeDanmaku: boolean;
  includeTitle: boolean;
}

const SCROLL_SECONDS = 8;

function assTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const centis = Math.floor((safe % 1) * 100);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(centis)}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/\{/g, "（")
    .replace(/\}/g, "）")
    .trim();
}

/** #RRGGBB → ASS 的 &H00BBGGRR&；非法值回落白色。 */
function assColor(color?: string): string {
  if (!color) return "&H00FFFFFF&";
  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return "&H00FFFFFF&";
  const hex = match[1];
  return `&H00${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}&`.toUpperCase();
}

export function buildHighlightAss(messages: AssMessage[], options: AssOptions): string {
  const width = Math.max(64, Math.round(options.width));
  const height = Math.max(64, Math.round(options.height));
  const duration = Math.max(0.1, (options.endMs - options.startMs) / 1000);
  const fontSize = Math.max(14, Math.round(height / 20));
  const laneHeight = Math.round(fontSize * 1.5);
  const lanes = Math.max(1, Math.floor((height * 0.6) / laneHeight));

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Danmaku,Noto Sans SC,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,1.5,0,7,0,0,0,1`,
    `Style: Title,Noto Sans SC,${Math.round(fontSize * 1.2)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,8,0,0,8,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events: string[] = [];
  if (options.includeDanmaku) {
    let lane = 0;
    const sorted = [...messages].sort((a, b) => a.at - b.at);
    for (const message of sorted) {
      if (message.kind !== "chat") continue;
      const text = escapeAssText(message.content);
      if (!text) continue;
      const relative = (message.at - options.startMs) / 1000;
      // 选区开始前 8 秒内的弹幕可能仍在屏幕上滚动。
      if (relative > duration || relative + SCROLL_SECONDS < 0) continue;
      const start = Math.max(0, relative);
      const end = Math.min(duration, relative + SCROLL_SECONDS);
      if (end - start < 0.2) continue;
      const y = 8 + (lane % lanes) * laneHeight;
      lane += 1;
      const textWidth = Math.max(fontSize, text.length * fontSize);
      const override = `{\\move(${width},${y},${-textWidth},${y})\\c${assColor(message.color)}}`;
      events.push(
        `Dialogue: 0,${assTime(start)},${assTime(end)},Danmaku,,0,0,0,,${override}${text}`,
      );
    }
  }
  if (options.includeTitle && options.title) {
    const title = escapeAssText(options.title);
    if (title) {
      events.push(`Dialogue: 1,${assTime(0)},${assTime(duration)},Title,,0,0,8,,${title}`);
    }
  }
  return [...header, ...events, ""].join("\n");
}