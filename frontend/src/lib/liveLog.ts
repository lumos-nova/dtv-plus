import * as LiveLogBinding from "../../bindings/dtv/internal/services/livelogservice";
import { isWailsRuntime } from "@/lib/window";

/**
 * 把播放器 / 自愈链路的关键事件写进独立的 live 日志。
 *
 * 开关在 Go 侧判断（LiveLogService.SetEnabled），前端只管上报；
 * 关闭时不产生磁盘写入，浏览器预览模式（无 Go 侧）直接跳过。
 */
export function reportLiveEvent(
  event: string,
  platform: string,
  roomId: string,
  detail: string,
): void {
  if (!isWailsRuntime()) return;
  void LiveLogBinding.Report(event, platform, roomId, detail).catch(() => undefined);
}
