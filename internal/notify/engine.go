// Package notify 实现关注主播的开播提醒引擎（Go 侧常驻批量轮询）。
//
// 旧实现由前端每 60 秒对每个关注逐房间发请求：上百个关注时一轮要发
// 上百个请求，抖音房间页频繁触发风控（"本次请求受到服务器拦截"），
// 而且提醒延迟以分钟计。本引擎按平台分层轮询：
//
//   - B 站：get_status_info_by_uids 一次批量查全部 UID，5 秒一轮（秒级提醒）；
//   - 抖音：只用 reflow 接口（web_rid → 内部 roomId 映射持久化到磁盘），
//     30 秒一轮、并发 ≤2，映射失效（status_code=10011）才回源房间页；
//   - 斗鱼：betard 轻量接口，30 秒一轮；
//   - 虎牙：profileRoom 接口，60 秒一轮（响应较重，频率放低）。
//
// 状态变化通过 emit 回调推给前端（Wails 事件），前端只负责展示与提醒；
// 引擎不发弹幕、不建 WebSocket，常驻内存只有关注表 + 状态表（几十 KB）。
package notify

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"dtv/internal/platforms/bilibili"
	"dtv/internal/platforms/douyin"
	"dtv/internal/platforms/douyu"
	"dtv/internal/platforms/huya"
)

// EventName 是推给前端的状态事件名。
const EventName = "notify-status"

// WatchItem 是前端推来的一个关注（platform + 房间号）。
type WatchItem struct {
	Platform string `json:"platform"`
	ID       string `json:"id"`
}

// StatusPatch 是单个房间的状态快照（字段语义对齐 common.Streamer）。
// Known=false 表示本轮查询失败，前端应保持原状态、不要当成下播。
type StatusPatch struct {
	Platform string `json:"platform"`
	ID       string `json:"id"`
	Known    bool   `json:"known"`
	IsLive   bool   `json:"isLive"`
	IsLoop   bool   `json:"isLoop"`
	Title    string `json:"title,omitempty"`
	Nickname string `json:"nickname,omitempty"`
	Avatar   string `json:"avatar,omitempty"`
	Cover    string `json:"cover,omitempty"`
	Viewers  int64  `json:"viewers,omitempty"`
}

// EmitFunc 由上层注入（转成 app.Event.Emit）。
type EmitFunc func(eventName string, payload any)

// 各平台轮询周期。B 站批量接口一次请求覆盖全部关注，5s 也只有一个请求；
// 其余平台逐房间轮询，周期放长并限制并发，避免触发风控。
const (
	biliInterval   = 5 * time.Second
	douyinInterval = 30 * time.Second
	douyuInterval  = 30 * time.Second
	huyaInterval   = 60 * time.Second

	// 逐房间平台的并发上限（抖音房间页风控敏感，取 2）。
	douyinConcurrency = 2
	douyuConcurrency  = 3
	huyaConcurrency   = 3

	// 抖音映射复核周期：内部 roomId 在主播重开后会更换，reflow 对旧 ID
	// 仍返回 status=4（下播），只有 10011 才明确失效。为避免"重开却永远
	// 显示下播"，对下播中的房间定期回源房间页复核映射（错峰、低频率）。
	douyinMapRecheck = 5 * time.Minute

	// 连续失败退避：失败次数越多等得越久（上限 5 分钟），
	// 房间不存在/被风控时不给上游持续压力。
	failBackoffMax = 5 * time.Minute
)

// entry 是引擎内部单个关注的运行时状态。
type entry struct {
	platform string
	id       string // 归一化后的房间号（B 站为短号/真实号原样）

	// B 站：房间号 → UID（room_get_info 解析一次后常驻）
	uid string

	// 抖音：web_rid → 内部 roomId 映射
	internalID  string
	mapLoadedAt time.Time

	lastAttempt time.Time
	failures    int
	last        *StatusPatch // 最近一次成功状态（nil=还没有成功过）
	dirty       bool         // 状态有变化、尚未推给前端（批量合并用）
}

// Engine 是常驻轮询引擎。所有可变状态都在 mu 保护下访问；
// 网络请求在锁外执行，结果写回时再拿锁。
type Engine struct {
	emit EmitFunc

	bili   *bilibili.Client
	douyin *douyin.Client
	douyu  *douyu.Client
	huya   *huya.Client

	mapPath string // 抖音映射持久化文件（空=不持久化，测试用）

	mu      sync.Mutex
	enabled bool
	entries map[string]*entry // key = platform:id
	wake    chan struct{}     // SetWatchList/SetEnabled 后唤醒各循环
	stop    chan struct{}
	stopped bool
	wg      sync.WaitGroup
}

// New 创建引擎并启动各平台轮询循环。mapPath 为抖音映射文件路径
// （传空字符串则不持久化）。引擎创建后即运行，但 enabled=false，
// 前端 SetEnabled(true) + SetWatchList 后才开始发请求。
func New(emit EmitFunc, mapPath string) *Engine {
	e := &Engine{
		emit:    emit,
		bili:    bilibili.NewClient(),
		douyin:  douyin.NewClient(),
		douyu:   douyu.NewClient(),
		huya:    huya.NewClient(),
		mapPath: mapPath,
		entries: make(map[string]*entry),
		wake:    make(chan struct{}, 1),
		stop:    make(chan struct{}),
	}
	e.loadMap()
	e.wg.Add(4)
	go e.loopBili()
	go e.loopRooms("douyin", douyinInterval, douyinConcurrency)
	go e.loopRooms("douyu", douyuInterval, douyuConcurrency)
	go e.loopRooms("huya", huyaInterval, huyaConcurrency)
	return e
}

// Stop 停止全部循环并落盘映射（应用退出时调用）。
func (e *Engine) Stop() {
	e.mu.Lock()
	if e.stopped {
		e.mu.Unlock()
		return
	}
	e.stopped = true
	close(e.stop)
	e.mu.Unlock()
	e.wg.Wait()
	e.saveMap()
}

// SetEnabled 开/关提醒轮询（对应设置里的"开播提醒"开关）。
func (e *Engine) SetEnabled(enabled bool) {
	e.mu.Lock()
	e.enabled = enabled
	e.mu.Unlock()
	e.poke()
}

// SetWatchList 用前端最新的关注表替换监听列表。
// 已有条目的运行时状态（UID/映射/退避）保留，新条目立即进入下一轮。
func (e *Engine) SetWatchList(items []WatchItem) {
	next := make(map[string]*entry, len(items))
	e.mu.Lock()
	for _, item := range items {
		platform := strings.ToLower(strings.TrimSpace(item.Platform))
		id := normalizeID(platform, item.ID)
		if id == "" {
			continue
		}
		switch platform {
		case "bilibili", "douyin", "douyu", "huya":
		default:
			continue
		}
		key := platform + ":" + id
		if _, exists := next[key]; exists {
			continue
		}
		if prev, ok := e.entries[key]; ok {
			next[key] = prev
		} else {
			next[key] = &entry{platform: platform, id: id}
		}
	}
	e.entries = next
	e.mu.Unlock()
	e.loadMap() // 新关注的抖音房间可能已在磁盘映射里
	e.poke()
}

// Snapshot 返回当前已知状态（前端订阅事件后先拉一次做初始同步）。
func (e *Engine) Snapshot() []StatusPatch {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]StatusPatch, 0, len(e.entries))
	for _, en := range e.entries {
		if en.last != nil {
			out = append(out, *en.last)
		}
	}
	return out
}

func (e *Engine) poke() {
	select {
	case e.wake <- struct{}{}:
	default:
	}
}

func normalizeID(platform, raw string) string {
	switch platform {
	case "bilibili":
		return bilibili.NormalizeRoomID(raw)
	case "douyin":
		return douyin.NormalizeRoomID(raw)
	default:
		return strings.TrimSpace(raw)
	}
}

// sleep 等待 d，期间可被 wake/stop 打断。返回 false 表示引擎已停止。
func (e *Engine) sleep(d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-e.stop:
		return false
	case <-e.wake:
		return true
	case <-t.C:
		return true
	}
}

// active 报告引擎是否应发请求。
func (e *Engine) active() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.enabled && !e.stopped
}

// dueEntries 取某平台本轮到期的条目（锁内标记 lastAttempt，
// 网络在锁外执行，避免并发循环重复取同一条目）。
func (e *Engine) dueEntries(platform string, now time.Time) []*entry {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []*entry
	for _, en := range e.entries {
		if en.platform != platform || !due(en, now) {
			continue
		}
		en.lastAttempt = now
		out = append(out, en)
	}
	return out
}

// due 判断条目是否到期（含失败退避：30s 起指数增长，上限 5 分钟）。
func due(en *entry, now time.Time) bool {
	if en.lastAttempt.IsZero() {
		return true
	}
	backoff := time.Duration(0)
	if en.failures > 0 {
		backoff = time.Duration(1<<min(en.failures-1, 5)) * 30 * time.Second
		if backoff > failBackoffMax {
			backoff = failBackoffMax
		}
	}
	return now.Sub(en.lastAttempt) >= backoff
}

// applyResult 把一次查询结果写回条目并标记 dirty；
// 事件由 flush 在一轮结束后合并推送（避免一轮上百个事件刷屏）。
func (e *Engine) applyResult(en *entry, patch *StatusPatch, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.entries[en.platform+":"+en.id]; !ok {
		return // 已被取关
	}
	if err != nil {
		en.failures++
		return
	}
	en.failures = 0
	if en.last == nil || statusChanged(en.last, patch) {
		en.dirty = true
	}
	en.last = patch
}

// flush 把本轮有变化的状态合并成一个事件推给前端。
func (e *Engine) flush() {
	e.mu.Lock()
	var batch []StatusPatch
	for _, en := range e.entries {
		if en.dirty && en.last != nil {
			batch = append(batch, *en.last)
			en.dirty = false
		}
	}
	e.mu.Unlock()
	if len(batch) > 0 {
		e.emit(EventName, batch)
	}
}

// statusChanged 只比较提醒/展示需要的字段（人数波动不推事件）。
func statusChanged(prev, next *StatusPatch) bool {
	return prev.Known != next.Known ||
		prev.IsLive != next.IsLive ||
		prev.IsLoop != next.IsLoop ||
		prev.Title != next.Title ||
		prev.Nickname != next.Nickname
}

// ---------------------------------------------------------------- B 站循环

func (e *Engine) loopBili() {
	defer e.wg.Done()
	for {
		if !e.active() {
			if !e.sleep(time.Second) {
				return
			}
			continue
		}
		e.pollBili()
		if !e.sleep(biliInterval) {
			return
		}
	}
}

func (e *Engine) pollBili() {
	due := e.dueEntries("bilibili", time.Now())
	if len(due) == 0 {
		return
	}

	// 第一步：补齐 UID（新关注的房间号 → 主播 UID，一次性，之后常驻）
	var uids []string
	for _, en := range due {
		if en.uid == "" {
			uid, err := e.bili.RoomUID(en.id)
			if err != nil {
				e.applyResult(en, nil, err)
				continue
			}
			e.mu.Lock()
			en.uid = uid
			e.mu.Unlock()
		}
		uids = append(uids, en.uid)
	}
	if len(uids) == 0 {
		return
	}

	// 第二步：一次批量查全部 UID
	statuses, err := e.bili.StatusByUIDs(uids)
	if err != nil {
		slog.Warn("[notify] B站批量状态失败", "err", err)
		for _, en := range due {
			if en.uid != "" {
				e.applyResult(en, nil, err)
			}
		}
		return
	}
	for _, en := range due {
		if en.uid == "" {
			continue
		}
		st, ok := statuses[en.uid]
		if !ok {
			// UID 不在返回里：房间可能已注销。按失败退避，不改状态。
			e.applyResult(en, nil, fmt.Errorf("B站 UID %s 无状态返回", en.uid))
			continue
		}
		e.applyResult(en, &StatusPatch{
			Platform: "bilibili",
			ID:       en.id,
			Known:    true,
			IsLive:   st.IsLive(),
			IsLoop:   st.IsLoop(),
			Title:    st.Title,
		}, nil)
	}
	e.flush()
}

// ------------------------------------------------------------ 逐房间循环

func (e *Engine) loopRooms(platform string, interval time.Duration, concurrency int) {
	defer e.wg.Done()
	for {
		if !e.active() {
			if !e.sleep(time.Second) {
				return
			}
			continue
		}
		e.pollRooms(platform, concurrency)
		if !e.sleep(interval) {
			return
		}
	}
}

func (e *Engine) pollRooms(platform string, concurrency int) {
	due := e.dueEntries(platform, time.Now())
	if len(due) == 0 {
		return
	}
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for _, en := range due {
		wg.Add(1)
		sem <- struct{}{}
		go func(en *entry) {
			defer wg.Done()
			defer func() { <-sem }()
			patch, err := e.fetchRoom(en)
			e.applyResult(en, patch, err)
		}(en)
	}
	wg.Wait()
	e.flush()
	if platform == "douyin" {
		e.saveMap()
	}
}

// fetchRoom 按平台查单个房间状态（网络请求，锁外执行）。
func (e *Engine) fetchRoom(en *entry) (*StatusPatch, error) {
	switch en.platform {
	case "douyin":
		return e.fetchDouyin(en)
	case "douyu":
		return e.fetchDouyu(en)
	case "huya":
		return e.fetchHuya(en)
	default:
		return nil, fmt.Errorf("未知平台 %s", en.platform)
	}
}

func (e *Engine) fetchDouyin(en *entry) (*StatusPatch, error) {
	e.mu.Lock()
	internalID := en.internalID
	mapAge := time.Since(en.mapLoadedAt)
	e.mu.Unlock()

	// 映射缺失，或下播中的房间到了复核周期 → 回源房间页重新解析。
	// （主播重开后内部 roomId 会更换，reflow 对旧 ID 仍返回"下播"，
	// 只有定期复核才能发现重开。）
	needResolve := internalID == ""
	if !needResolve && en.last != nil && !en.last.IsLive && mapAge >= douyinMapRecheck {
		needResolve = true
	}
	if needResolve {
		id, err := e.douyin.ResolveInternalID(en.id)
		if err != nil {
			if internalID == "" {
				return nil, err
			}
			// 复核失败（如风控冷却中）：继续用旧映射查一次，聊胜于无
		} else {
			e.mu.Lock()
			en.internalID = id
			en.mapLoadedAt = time.Now()
			e.mu.Unlock()
			internalID = id
		}
	}

	st, err := e.douyin.StatusByInternalID(internalID)
	if errors.Is(err, douyin.ErrInternalIDStale) {
		// 内部 ID 明确失效：立即重解析一次
		id, rerr := e.douyin.ResolveInternalID(en.id)
		if rerr != nil {
			return nil, rerr
		}
		e.mu.Lock()
		en.internalID = id
		en.mapLoadedAt = time.Now()
		e.mu.Unlock()
		st, err = e.douyin.StatusByInternalID(id)
	}
	if err != nil {
		return nil, err
	}
	return &StatusPatch{
		Platform: "douyin",
		ID:       en.id,
		Known:    true,
		IsLive:   st.IsLive,
		Title:    st.Title,
		Nickname: st.Nickname,
		Avatar:   st.Avatar,
		Cover:    st.Cover,
		Viewers:  st.Viewers,
	}, nil
}

func (e *Engine) fetchDouyu(en *entry) (*StatusPatch, error) {
	detail, err := e.douyu.FetchRoomDetail(en.id)
	if err != nil {
		return nil, err
	}
	return &StatusPatch{
		Platform: "douyu",
		ID:       en.id,
		Known:    true,
		IsLive:   detail.IsLive,
		IsLoop:   detail.VideoLoop,
		Title:    detail.Title,
		Nickname: detail.Nickname,
		Avatar:   detail.Avatar,
		Cover:    detail.Cover,
	}, nil
}

func (e *Engine) fetchHuya(en *entry) (*StatusPatch, error) {
	st, err := e.huya.Streamer(en.id)
	if err != nil {
		return nil, err
	}
	return &StatusPatch{
		Platform: "huya",
		ID:       en.id,
		Known:    true,
		IsLive:   st.IsLive,
		Title:    st.Title,
		Nickname: st.Nickname,
		Avatar:   st.Avatar,
	}, nil
}

// ------------------------------------------------------------ 映射持久化

// douyinMapFile 是磁盘上的映射文件形状。
type douyinMapFile struct {
	Version int               `json:"version"`
	Rooms   map[string]string `json:"rooms"` // web_rid → 内部 roomId
}

func (e *Engine) loadMap() {
	if e.mapPath == "" {
		return
	}
	body, err := os.ReadFile(e.mapPath)
	if err != nil {
		return // 首次运行没有文件，正常
	}
	var file douyinMapFile
	if err := json.Unmarshal(body, &file); err != nil {
		slog.Warn("[notify] 抖音映射文件损坏，忽略", "err", err)
		return
	}
	e.mu.Lock()
	for rid, internal := range file.Rooms {
		if en, ok := e.entries["douyin:"+rid]; ok && en.internalID == "" && internal != "" {
			en.internalID = internal
			// 磁盘映射的年龄未知，按"需要复核"处理：首个轮询周期内
			// 若房间下播会立即回源复核，直播中则直接用。
			en.mapLoadedAt = time.Now().Add(-douyinMapRecheck)
		}
	}
	e.mu.Unlock()
}

func (e *Engine) saveMap() {
	if e.mapPath == "" {
		return
	}
	e.mu.Lock()
	rooms := make(map[string]string)
	for _, en := range e.entries {
		if en.platform == "douyin" && en.internalID != "" {
			rooms[en.id] = en.internalID
		}
	}
	e.mu.Unlock()
	if len(rooms) == 0 {
		return
	}
	body, err := json.Marshal(douyinMapFile{Version: 1, Rooms: rooms})
	if err != nil {
		return
	}
	// 原子写：先写临时文件再改名，避免崩溃留下半截 JSON
	tmp := e.mapPath + ".tmp"
	if err := os.MkdirAll(filepath.Dir(e.mapPath), 0o755); err != nil {
		return
	}
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return
	}
	if err := os.Rename(tmp, e.mapPath); err != nil {
		_ = os.Remove(tmp)
	}
}