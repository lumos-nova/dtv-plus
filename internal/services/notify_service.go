package services

import (
	"path/filepath"

	"dtv/internal/appdirs"
	"dtv/internal/notify"
)

// NotifyService 是开播提醒引擎的 IPC 边界。
//
// 前端把关注表推给引擎（SetWatchList），引擎在 Go 侧按平台分层轮询
// （B 站批量 5s / 抖音 reflow 30s / 斗鱼 30s / 虎牙 60s），状态变化通过
// "notify-status" 事件推回前端。前端的 60s 逐房间刷新只保留为手动刷新
// 与无绑定环境（浏览器 mock）的兜底。
type NotifyService struct {
	engine *notify.Engine
}

// NewNotifyService 创建提醒服务；emit 由 main.go 注入（转成 app.Event.Emit）。
func NewNotifyService(emit notify.EmitFunc) *NotifyService {
	mapPath := filepath.Join(appdirs.ConfigDir(), "notify-douyin-map.json")
	return &NotifyService{engine: notify.New(emit, mapPath)}
}

// ServiceShutdown 应用退出时停止轮询并落盘抖音映射。
func (s *NotifyService) ServiceShutdown() error {
	s.engine.Stop()
	return nil
}

// SetWatchList 用前端最新的关注表替换监听列表（关注变化时调用）。
func (s *NotifyService) SetWatchList(items []notify.WatchItem) {
	s.engine.SetWatchList(items)
}

// SetEnabled 开/关提醒轮询（对应设置里的"开播提醒"开关）。
func (s *NotifyService) SetEnabled(enabled bool) {
	s.engine.SetEnabled(enabled)
}

// Snapshot 返回引擎当前已知状态（前端订阅事件后先拉一次做初始同步）。
func (s *NotifyService) Snapshot() []notify.StatusPatch {
	return s.engine.Snapshot()
}