/**
 * 与 Go 侧 internal/platforms/common/errors.go 约定一致不需要重试的错误标记。
 *
 * 如房间不存在、房间号无效等命中前缀的错误不触发自动重连。
 * 例外：风控拦截（见 isRiskControlError）是临时状态，用长退避重试。
 */
const FATAL_PREFIX = "FATAL_ERROR:";

export function isFatalError(message: string): boolean {
  return message.startsWith(FATAL_PREFIX);
}

/** 去掉前缀 */
export function stripFatalPrefix(message: string): string {
  return isFatalError(message) ? message.slice(FATAL_PREFIX.length) : message;
}

/**
 * 风控拦截（验证码中间页 / 服务器拦截）是临时状态，实测几分钟内自行解除。
 * 这类错误虽然带 FATAL 前缀（避免高频重试撞风控），但应该用更长的退避
 * 自动重试，而不是永久停在错误页等用户手动点重连。
 */
export function isRiskControlError(message: string): boolean {
  return message.includes("服务器拦截");
}
