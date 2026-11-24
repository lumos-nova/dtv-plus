package douyin

import (
	"fmt"
	"io"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"dtv/internal/platforms/common"
)

// 抖音接口的几个固定常量（旧实现全部写死，改任何一个签名都会对不上）。
const (
	// desktopUA 必须与实际请求头一致 —— a_bogus 的 UA 参与哈希。
	desktopUA = "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) " +
		"Chrome/116.0.5845.97 Safari/537.36 Core/1.116.567.400 QQBrowser/19.7.6764.400"

	referer        = "https://live.douyin.com/"
	urlRoomEnter   = "https://live.douyin.com/webcast/room/web/enter/"
	urlPartitionV2 = "https://live.douyin.com/webcast/web/partition/detail/room/v2/"
	urlLiveHome    = "https://live.douyin.com/"

	// aid 与 live_id 是 web 端的固定值，同时参与 a_bogus 的主表。
	paramAid    = "6383"
	paramLiveID = "1"
)

// Client 是抖音 HTTP 客户端。
//
// 与旧实现的一处关键差异：旧代码把 ttwid / odin_tt 硬编码在源码里，
// 那些 cookie 过一段时间就失效（失效后接口全部返回空）。
// 这里改成"先访问一次直播首页，让 cookie jar 自动收下 ttwid 等 cookie"，
// 之后的所有请求都自动带上 —— 无需手工抄 cookie。
type Client struct {
	http *common.HttpClient

	mu       sync.Mutex
	warmedAt time.Time
	warmErr  error

	// 房间页缓存 + 风控冷却。见 roomCache / guardedRoomPage。
	rooms        map[string]*roomCacheEntry
	blockedUntil time.Time
}

// roomCacheEntry 缓存一次"房间页 → 内部 roomId → reflow"的完整结果。
//
// 播放页每次加载会连发 getRoomInfo + getStreamInfo 两个请求，关注列表
// 刷新失败时还会再补一次取流请求——都打到同一个房间页上。抖音对房间页
// 的访问频率极其敏感（实测每分钟一轮、并发 6 的关注刷新就能触发滑块
// 验证码中间页），所以短 TTL 内合并复用同一份结果。
type roomCacheEntry struct {
	mu   sync.Mutex
	done bool
	at   time.Time
	bundle *roomBundle
	err    error
}

const (
	// roomCacheTTL 直播状态/取流地址的复用窗口。FLV 地址本身有效期远超
	// 30s，取流失败时前端的重连路径会带新请求进来，TTL 到期自然刷新。
	roomCacheTTL = 30 * time.Second
	// blockedCooldown 命中验证码中间页后的全局冷却：期间不再打房间页，
	// 直接返回缓存或"稍后再试"错误，避免持续撞风控把拦截时间越拖越长。
	blockedCooldown = 90 * time.Second
	// blockedRetryDelay 首次命中拦截时的一次延迟重试间隔（拦截常为瞬时）。
	blockedRetryDelay = 2 * time.Second
)

// NewClient 创建抖音客户端。
//
// 首页 cookie 预热（换 ttwid）只放到后台跑：它是 1.5~2s 的一次性开销，
// 挡在列表请求前面会让"第一次进抖音分区"慢上三四秒（旧实现用硬编码
// cookie，所以从来没有这笔开销）。实测列表接口不带 cookie 也能正常返回，
// 预热只是为了拿到 ttwid 并顺手把 TLS 连接暖起来，绝不该阻塞首屏。
func NewClient() *Client {
	c := &Client{http: common.NewHttpClient(), rooms: make(map[string]*roomCacheEntry)}
	go func() { _ = c.warmup() }()
	return c
}

// isBlockedError 判断错误是否为风控拦截（验证码中间页 / HTTP 4xx）。
func isBlockedError(err error) bool {
	return err != nil && strings.Contains(err.Error(), "服务器拦截")
}

// noteBlocked 记录一次拦截，进入全局冷却。
func (c *Client) noteBlocked() {
	c.mu.Lock()
	c.blockedUntil = time.Now().Add(blockedCooldown)
	c.mu.Unlock()
}

// coolingDown 报告当前是否处于风控冷却期。
func (c *Client) coolingDown() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.Now().Before(c.blockedUntil)
}

// guardedRoomPage 带风控保护的房间页请求：
//   - 冷却期内直接失败（调用方可回退到缓存）；
//   - 首次命中拦截时等 2s 重试一次（实测拦截常为瞬时，重试即恢复）；
//   - 仍被拦截则进入 90s 全局冷却。
func (c *Client) guardedRoomPage(webRID string) (string, error) {
	if c.coolingDown() {
		return "", common.Fatal("本次请求受到服务器拦截（风控冷却中），请稍后再试")
	}
	html, err := c.fetchRoomPage(webRID)
	if err == nil && !htmlBlocked(html) {
		return html, nil
	}
	if err != nil && !isBlockedError(err) {
		return "", err // 网络类错误照旧透传，不算风控
	}
	time.Sleep(blockedRetryDelay)
	if c.coolingDown() {
		return "", common.Fatal("本次请求受到服务器拦截（风控冷却中），请稍后再试")
	}
	html, err = c.fetchRoomPage(webRID)
	if err != nil {
		if isBlockedError(err) {
			c.noteBlocked()
		}
		return "", err
	}
	if htmlBlocked(html) {
		c.noteBlocked()
		return "", common.Fatal("本次请求受到服务器拦截，请稍后再试")
	}
	return html, nil
}

// cachedRoom 返回 TTL 内的缓存结果；没有或已过期返回 nil。
func (c *Client) cachedRoom(webRID string, allowStale bool) *roomBundle {
	c.mu.Lock()
	entry := c.rooms[webRID]
	c.mu.Unlock()
	if entry == nil {
		return nil
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if !entry.done || entry.err != nil {
		return nil
	}
	if allowStale || time.Since(entry.at) < roomCacheTTL {
		return entry.bundle
	}
	return nil
}

// resolveRoomCached 是 resolveRoom 的缓存/合并入口：
//   - TTL 内直接复用（播放页的 getRoomInfo + getStreamInfo 合并成一次上游请求）；
//   - 并发同房间请求单飞（只放一个请求出去，其余等结果）；
//   - 风控冷却期内允许回退到过期缓存（有旧数据总比报错好）。
func (c *Client) resolveRoomCached(roomID string) (*roomBundle, error) {
	webRID := NormalizeRoomID(roomID)
	if webRID == "" {
		return nil, common.Fatal("抖音房间号无效: %q", roomID)
	}

	if bundle := c.cachedRoom(webRID, false); bundle != nil {
		return bundle, nil
	}

	c.mu.Lock()
	// 顺手清理过期条目，避免长期运行时 map 无限增长。
	// TryLock：条目锁可能被进行中的请求长期持有（锁序是 entry.mu → c.mu），
	// 拿不到就跳过，绝不能在这里阻塞等条目锁。
	if len(c.rooms) > 256 {
		for rid, e := range c.rooms {
			if !e.mu.TryLock() {
				continue
			}
			stale := e.done && time.Since(e.at) > 10*roomCacheTTL
			e.mu.Unlock()
			if stale {
				delete(c.rooms, rid)
			}
		}
	}
	entry := c.rooms[webRID]
	if entry == nil {
		entry = &roomCacheEntry{}
		c.rooms[webRID] = entry
	}
	c.mu.Unlock()

	entry.mu.Lock()
	defer entry.mu.Unlock()
	// 双检：等锁期间别的请求可能已刷新完成
	if entry.done && entry.err == nil && time.Since(entry.at) < roomCacheTTL {
		return entry.bundle, nil
	}

	bundle, err := c.resolveRoom(webRID)
	if err != nil && isBlockedError(err) && entry.done && entry.err == nil && entry.bundle != nil {
		// 风控期间回退过期缓存：地址可能仍有效，状态稍旧但可看。
		// 注意这里已持有 entry.mu，直接读字段，不能再走 cachedRoom（会死锁）。
		return entry.bundle, nil
	}
	entry.done = true
	entry.at = time.Now()
	entry.bundle = bundle
	entry.err = err
	return bundle, err
}

// warmup 访问一次直播首页以获取 cookie（ttwid 等）。
//
// 结果缓存 30 分钟，避免每次请求都多打一次页面。
func (c *Client) warmup() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.warmedAt.IsZero() && time.Since(c.warmedAt) < 30*time.Minute {
		return c.warmErr
	}

	headers := map[string]string{
		"User-Agent":      desktopUA,
		"Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"Accept-Language": "zh-CN,zh;q=0.9",
	}
	resp, err := c.http.Get(urlLiveHome, headers)
	if err != nil {
		c.warmedAt = time.Time{}
		c.warmErr = fmt.Errorf("抖音首页 cookie 获取失败: %w", err)
		return c.warmErr
	}
	// 只需要响应头里的 Set-Cookie（jar 已经收下了），正文读完即丢。
	// 必须把 body 读干净再关：只读一半就 close，Go 的 transport 会认为这条
	// 连接不可复用而直接丢弃，后面的列表请求又得重新做一次 TLS 握手
	// （实测冷连接 760ms vs 复用 130ms）。
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()

	c.warmedAt = time.Now()
	c.warmErr = nil
	return nil
}

// signedURL 用固定顺序拼 query、签名，再拼成最终请求地址。
//
// 必须保证"签名的串"与"发出去的串"完全一致，否则服务端校验不过。
func signedURL(endpoint string, params [][2]string) string {
	parts := make([]string, 0, len(params))
	for _, kv := range params {
		parts = append(parts, url.QueryEscape(kv[0])+"="+url.QueryEscape(kv[1]))
	}
	query := strings.Join(parts, "&")
	sign := GenerateABogus(query, desktopUA)
	return endpoint + "?" + query + "&a_bogus=" + url.QueryEscape(sign)
}

// cookieString 返回 cookie jar 里该地址对应的 cookie 串。
//
// 抖音的弹幕 WS 需要把 cookie 显式放进握手头（WS 不走 HTTP jar），
// 因此这里把页面请求时收下的 ttwid 等取出来。
func (c *Client) cookieString(rawURL string) string {
	return c.http.Cookies(rawURL)
}

// getJSON 抖音专用请求头的 GET。
//
// 注意这里**不再**同步等首页预热：预热只是"顺手拿 ttwid + 暖连接"，
// 同步等它会把首屏拖到 3s 以上。jar 会在第一次响应里自动收下 ttwid。
func (c *Client) getJSON(target string, out any) error {
	headers := map[string]string{
		"User-Agent":      desktopUA,
		"Referer":         referer,
		"Accept":          "application/json, text/plain, */*",
		"Accept-Language": "zh-CN,zh;q=0.9",
		// 抖音对 br/gzip 都支持，但显式要求 identity 能少一层解压问题
		"Accept-Encoding": "identity",
	}
	return c.http.GetJSON(target, headers, out)
}

// sortedPairs 把 map 转成按 key 排序的键值对（用于需要固定顺序的场景）。
func sortedPairs(params map[string]string) [][2]string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	out := make([][2]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, [2]string{k, params[k]})
	}
	return out
}
