import type { StreamVariant } from "@/api";

/**
 * 多画面小窗的默认清晰度：优先中低档（高清/标清），避免十几路小窗
 * 同时按原画解码带来的内存与带宽开销。用户手动选过的档位仍然优先。
 *
 * 档位名跨平台并不统一（斗鱼/虎牙/B 站用中文档位，抖音可能下发
 * FULL_HD1/HD1/SD2/SD1 等英文 key），这里按关键词归档打分。
 */
function qualityRank(label: string): number {
  const text = label.toLowerCase();
  if (text.includes("标清") || text.includes("流畅") || text.includes("普清")) return 0;
  if (text.includes("sd1") || text === "ld") return 0; // 抖音 SD1 实际是最低档（_ld）
  if (text.includes("高清") && !text.includes("超清") && !text.includes("full")) return 1;
  if (text.includes("sd2") || text === "sd") return 1; // 抖音 SD2 实际是高清（_sd）
  if (text.includes("hd1") && !text.includes("full")) return 1;
  if (text.includes("超清")) return 2;
  if (text.includes("蓝光")) return 3;
  if (text.includes("原画")) return 4;
  if (text.includes("4k") || text.includes("杜比") || text.includes("hdr")) return 5;
  return 3; // 未知档位按偏高处理，宁可不降级也不误降
}

/**
 * 选出小窗要播放的档位：
 * 1. 用户手动选择（qualityId 命中）优先；
 * 2. 否则取排名最低（最省资源）的档位；同级取靠前的（平台按高→低排列，
 *    同级靠前通常是码率更高的那个，画质略好）。
 */
export function pickTileVariant(
  variants: StreamVariant[],
  qualityId: string,
): StreamVariant | undefined {
  if (variants.length === 0) return undefined;
  const manual = qualityId ? variants.find((item) => item.id === qualityId) : undefined;
  if (manual) return manual;
  let best = variants[0];
  let bestRank = qualityRank(best.label);
  for (const item of variants.slice(1)) {
    const rank = qualityRank(item.label);
    if (rank < bestRank) {
      best = item;
      bestRank = rank;
    }
  }
  return best;
}