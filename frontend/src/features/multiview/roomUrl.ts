import type { LivePlatform } from "@/api";

export interface ParsedLiveRoomUrl {
  platform: LivePlatform;
  roomId: string;
}

const PLATFORM_HOSTS: Record<LivePlatform, ReadonlySet<string>> = {
  douyu: new Set(["douyu.com", "www.douyu.com", "m.douyu.com"]),
  huya: new Set(["huya.com", "www.huya.com", "m.huya.com"]),
  douyin: new Set(["live.douyin.com", "www.douyin.com", "v.douyin.com"]),
  bilibili: new Set(["live.bilibili.com"]),
};

/** 分享用的规范直播间链接（parseLiveRoomUrl 的逆操作）。 */
const PLATFORM_SHARE_ORIGIN: Record<LivePlatform, string> = {
  douyu: "https://www.douyu.com",
  huya: "https://www.huya.com",
  douyin: "https://live.douyin.com",
  bilibili: "https://live.bilibili.com",
};

/** 生成可直接粘贴回添加框 / 发给别人的直播间链接。 */
export function liveRoomShareUrl(platform: LivePlatform, roomId: string): string {
  return `${PLATFORM_SHARE_ORIGIN[platform]}/${encodeURIComponent(roomId)}`;
}

function platformForHost(host: string): LivePlatform | null {
  for (const [platform, hosts] of Object.entries(PLATFORM_HOSTS) as [
    LivePlatform,
    ReadonlySet<string>,
  ][]) {
    if (hosts.has(host)) return platform;
  }
  return null;
}

function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function isRoomId(value: string | undefined): value is string {
  return Boolean(value && /^\d+$/.test(value));
}

/**
 * Parse known public live-room URLs without making a network request.
 *
 * Only exact platform hosts and numeric room IDs are accepted. Short-link
 * resolution is deliberately left to a separately validated backend flow.
 */
export function parseLiveRoomUrl(raw: string): ParsedLiveRoomUrl {
  const input = raw.trim();
  if (!input) throw new Error("请粘贴直播间链接");

  const candidate = input.startsWith("//")
    ? `https:${input}`
    : /^[a-z][a-z\d+.-]*:\/\//i.test(input)
      ? input
      : `https://${input}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("链接格式无效，请检查后重试");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("仅支持 HTTP 或 HTTPS 直播间链接");
  }
  if (url.username || url.password || url.port) {
    throw new Error("链接不能包含账号信息或非标准端口");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const platform = platformForHost(host);
  if (!platform) throw new Error("暂不支持该网站，请粘贴斗鱼、虎牙、抖音或 B 站直播间链接");

  let segments: string[];
  try {
    segments = pathSegments(decodeURIComponent(url.pathname));
  } catch {
    throw new Error("链接路径格式无效");
  }

  if (platform === "douyin" && host === "v.douyin.com") {
    throw new Error("检测到抖音分享短链；当前请使用 live.douyin.com 的直播间链接");
  }

  let roomId: string | undefined;
  if (
    platform === "douyin" &&
    host === "www.douyin.com" &&
    segments.length === 3 &&
    segments[0] === "follow" &&
    segments[1] === "live"
  ) {
    roomId = segments[2];
  } else if (segments.length === 1) {
    roomId = segments[0];
  }

  if (!isRoomId(roomId)) {
    throw new Error("未能从链接中识别房间号；请使用平台的直播间页面链接");
  }

  return { platform, roomId };
}
