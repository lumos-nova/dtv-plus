import { isFatalError, isRiskControlError } from "@/lib/errors";

/**
 * 连续失败次数 -> 下一次重试延迟（毫秒）。
 *
 * 前两次立即重新取流；之后 2s → 4s → 8s → 16s → 30s（封顶）。
 */
export function recoveryDelay(attempt: number): number {
  if (attempt <= 2) return 0;
  return Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 2, 5));
}

/** 房间不存在等致命错误不重试；风控是临时状态，仍需长退避重试。 */
export function shouldAutoRecover(message: string): boolean {
  return !isFatalError(message) || isRiskControlError(message);
}
