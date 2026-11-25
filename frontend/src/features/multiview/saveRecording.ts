import * as DataTransfer from "../../../bindings/dtv/internal/services/datatransferservice";
import { isWailsRuntime } from "@/lib/window";

/** dialog：弹系统保存框；highlights：直接写入「精彩片段保存位置」。 */
export type RecordingExportTarget = "dialog" | "highlights";

/**
 * 保存录制导出。
 *
 * Wails 环境走本地 loopback 流式上传：先由后端确定落盘路径并返回一次性 token，
 * 再把 Blob 直接 POST 过去。文件字节不进 IPC，也不再生成完整的 base64 字符串，
 * 大文件导出时 JS / Wails 两侧都不会出现多份完整副本。
 */
export async function saveRecording(
  blob: Blob,
  filename: string,
  target: RecordingExportTarget = "dialog",
): Promise<string | null> {
  if (!isWailsRuntime()) {
    // 浏览器预览（无 Go 侧导出服务）仍走下载链接。
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return filename;
  }

  const session =
    target === "highlights"
      ? await DataTransfer.PrepareHighlightExport(filename)
      : await DataTransfer.PrepareRecordingExport(filename);
  if (!session) return null; // 用户在保存对话框里取消

  try {
    const response = await fetch(session.url, {
      method: "POST",
      headers: { "Content-Type": blob.type || "application/octet-stream" },
      body: blob,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim();
      throw new Error(detail || `上传录制文件失败（HTTP ${response.status}）`);
    }
    const result = (await response.json()) as { path?: string };
    return result.path ?? session.path;
  } finally {
    // 成功时会话已被服务端消费；失败时这里释放 token 与可能残留的临时文件。
    await DataTransfer.CancelExport(session.token).catch(() => undefined);
  }
}
