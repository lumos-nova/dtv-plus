import type { RecordingTask } from "../../../bindings/dtv/internal/services/models";

/** 「独立录制」任务表格的纯格式化 helpers（与组件分离便于测试）。 */

export function formatRecordingBytes(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  return `${(bytes / (1 << 20)).toFixed(1)} MB`;
}

export function formatRecordingDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

export function recordingStatusLabel(task: RecordingTask): string {
  if (task.status === "recording") return "录制中";
  if (task.status === "error") return "错误";
  switch (task.mergeState) {
    case "pending":
      return "等待合并";
    case "merging":
      return "合并中";
    case "merged":
      return "已合并";
    case "failed":
      return "合并失败";
    default:
      return "已停止";
  }
}