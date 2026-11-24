package notify

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// collectEmit 收集引擎推出的事件（线程安全）。
type collectEmit struct {
	mu     sync.Mutex
	events [][]StatusPatch
}

func (c *collectEmit) emit(name string, payload any) {
	if name != EventName {
		return
	}
	batch, ok := payload.([]StatusPatch)
	if !ok {
		return
	}
	c.mu.Lock()
	c.events = append(c.events, batch)
	c.mu.Unlock()
}

func (c *collectEmit) all() []StatusPatch {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []StatusPatch
	for _, batch := range c.events {
		out = append(out, batch...)
	}
	return out
}

// newTestEngine 构造不启动轮询循环、不访问网络的引擎。
func newTestEngine(t *testing.T, mapPath string) (*Engine, *collectEmit) {
	t.Helper()
	sink := &collectEmit{}
	e := &Engine{
		emit:    sink.emit,
		mapPath: mapPath,
		entries: make(map[string]*entry),
		wake:    make(chan struct{}, 1),
		stop:    make(chan struct{}),
	}
	return e, sink
}

func TestSetWatchListNormalizesAndPreserves(t *testing.T) {
	e, _ := newTestEngine(t, "")
	e.SetWatchList([]WatchItem{
		{Platform: "bilibili", ID: "https://live.bilibili.com/5148"},
		{Platform: "DOUYIN", ID: "https://live.douyin.com/123456?x=1"},
		{Platform: "douyu", ID: " 999 "},
		{Platform: "unknown", ID: "1"},
		{Platform: "huya", ID: ""},
	})
	if len(e.entries) != 3 {
		t.Fatalf("应只保留 3 个合法条目, got %d", len(e.entries))
	}
	bili := e.entries["bilibili:5148"]
	if bili == nil {
		t.Fatal("B 站链接应归一化为 5148")
	}
	bili.uid = "42"
	bili.failures = 2

	// 再推一次（含新增），旧条目的运行时状态必须保留
	e.SetWatchList([]WatchItem{
		{Platform: "bilibili", ID: "5148"},
		{Platform: "huya", ID: "888"},
	})
	if len(e.entries) != 2 {
		t.Fatalf("取关的条目应被移除, got %d", len(e.entries))
	}
	if e.entries["bilibili:5148"].uid != "42" || e.entries["bilibili:5148"].failures != 2 {
		t.Fatal("已有条目的 UID/退避状态应保留")
	}
}

func TestDueBackoff(t *testing.T) {
	now := time.Now()
	en := &entry{}
	if !due(en, now) {
		t.Fatal("从未尝试过的条目应立即到期")
	}
	en.lastAttempt = now.Add(-10 * time.Second)
	en.failures = 1
	if due(en, now) {
		t.Fatal("失败 1 次应退避 30s")
	}
	en.lastAttempt = now.Add(-31 * time.Second)
	if !due(en, now) {
		t.Fatal("退避 30s 后应到期")
	}
	en.failures = 10
	en.lastAttempt = now.Add(-4 * time.Minute)
	if due(en, now) {
		t.Fatal("退避上限应为 5 分钟")
	}
	en.lastAttempt = now.Add(-6 * time.Minute)
	if !due(en, now) {
		t.Fatal("超过上限后应到期")
	}
}

func TestApplyResultEmitsOnlyOnChange(t *testing.T) {
	e, sink := newTestEngine(t, "")
	e.SetWatchList([]WatchItem{{Platform: "douyu", ID: "1"}})
	en := e.entries["douyu:1"]

	offline := &StatusPatch{Platform: "douyu", ID: "1", Known: true}
	e.applyResult(en, offline, nil)
	e.flush()
	if len(sink.all()) != 1 {
		t.Fatal("首次状态应推送")
	}

	// 相同状态（人数变化不算）不推
	e.applyResult(en, &StatusPatch{Platform: "douyu", ID: "1", Known: true, Viewers: 99}, nil)
	e.flush()
	if len(sink.all()) != 1 {
		t.Fatal("状态未变不应重复推送")
	}

	// 开播 → 推送
	e.applyResult(en, &StatusPatch{Platform: "douyu", ID: "1", Known: true, IsLive: true}, nil)
	e.flush()
	all := sink.all()
	if len(all) != 2 || !all[1].IsLive {
		t.Fatalf("开播变化应推送: %+v", all)
	}

	// 查询失败：不改状态、不推送、计失败次数
	e.applyResult(en, nil, os.ErrDeadlineExceeded)
	e.flush()
	if len(sink.all()) != 2 || en.failures != 1 || !en.last.IsLive {
		t.Fatal("失败不应改变已知状态")
	}
}

func TestFlushBatchesChanges(t *testing.T) {
	e, sink := newTestEngine(t, "")
	e.SetWatchList([]WatchItem{{Platform: "douyu", ID: "1"}, {Platform: "douyu", ID: "2"}})
	for id, en := range e.entries {
		e.applyResult(en, &StatusPatch{Platform: "douyu", ID: id, Known: true, IsLive: true}, nil)
	}
	e.flush()
	sink.mu.Lock()
	defer sink.mu.Unlock()
	if len(sink.events) != 1 || len(sink.events[0]) != 2 {
		t.Fatalf("一轮变化应合并成一个事件: %d 个事件", len(sink.events))
	}
}

func TestSnapshotOnlyKnown(t *testing.T) {
	e, _ := newTestEngine(t, "")
	e.SetWatchList([]WatchItem{{Platform: "douyu", ID: "1"}, {Platform: "douyu", ID: "2"}})
	e.applyResult(e.entries["douyu:1"], &StatusPatch{Platform: "douyu", ID: "1", Known: true}, nil)
	snap := e.Snapshot()
	if len(snap) != 1 || snap[0].ID != "1" {
		t.Fatalf("快照应只含已知状态: %+v", snap)
	}
}

func TestDouyinMapPersistence(t *testing.T) {
	dir := t.TempDir()
	mapPath := filepath.Join(dir, "sub", "notify-douyin-map.json")

	e, _ := newTestEngine(t, mapPath)
	e.SetWatchList([]WatchItem{{Platform: "douyin", ID: "123456"}})
	en := e.entries["douyin:123456"]
	en.internalID = "7702034233618877218"
	e.saveMap()

	body, err := os.ReadFile(mapPath)
	if err != nil {
		t.Fatalf("映射应落盘: %v", err)
	}
	var file douyinMapFile
	if err := json.Unmarshal(body, &file); err != nil {
		t.Fatalf("映射文件应是合法 JSON: %v", err)
	}
	if file.Rooms["123456"] != "7702034233618877218" {
		t.Fatalf("映射内容错误: %+v", file)
	}

	// 新引擎（模拟重启）：SetWatchList 后应从磁盘恢复映射
	e2, _ := newTestEngine(t, mapPath)
	e2.SetWatchList([]WatchItem{{Platform: "douyin", ID: "123456"}})
	en2 := e2.entries["douyin:123456"]
	if en2.internalID != "7702034233618877218" {
		t.Fatal("重启后应恢复抖音映射")
	}
	if time.Since(en2.mapLoadedAt) < douyinMapRecheck {
		t.Fatal("磁盘映射应标记为待复核（下播房间首轮即回源）")
	}
}

func TestLoadMapCorruptFileIgnored(t *testing.T) {
	dir := t.TempDir()
	mapPath := filepath.Join(dir, "map.json")
	if err := os.WriteFile(mapPath, []byte("{half json"), 0o644); err != nil {
		t.Fatal(err)
	}
	e, _ := newTestEngine(t, mapPath)
	e.SetWatchList([]WatchItem{{Platform: "douyin", ID: "1"}})
	if e.entries["douyin:1"].internalID != "" {
		t.Fatal("损坏文件应被忽略")
	}
}