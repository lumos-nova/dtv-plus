// Package services 是 Go 业务逻辑与前端之间的 IPC 边界。
package services

import (
	"time"

	"dtv/internal/logging"
	"dtv/internal/platforms/common"
)

// LiveLogService 暴露直播流日志的开关与前端事件上报。
//
// 日志文件独立存放在 <日志目录>/live/，只记录取流、中继、断流与自愈相关事件，
// 与主日志分开，便于用户按需开启并把排查信息单独发给开发者。
type LiveLogService struct{}

// NewLiveLogService 创建直播流日志服务。
func NewLiveLogService() *LiveLogService {
	return &LiveLogService{}
}

// SetEnabled 打开/关闭直播流日志记录。
func (s *LiveLogService) SetEnabled(enabled bool) error {
	return logging.SetLiveLogEnabled(enabled)
}

// Enabled 返回当前是否记录直播流日志。
func (s *LiveLogService) Enabled() bool {
	return logging.LiveLogEnabled()
}

// LogDirectory 返回直播流日志的落盘目录（供设置页展示）。
func (s *LiveLogService) LogDirectory() string {
	return logging.LiveLogDir()
}

// Report 接收前端播放器 / 自愈链路的事件，写入同一份 live 日志。
func (s *LiveLogService) Report(event, platform, roomID, detail string) {
	logging.LiveLog("frontend."+event,
		"platform", platform,
		"room", roomID,
		"detail", detail,
	)
}

// logLiveFetch 由各平台 Service 的 GetStreamInfo defer 调用，
// 记录取流耗时、是否开播/轮播、档位数量以及具体错误。
func logLiveFetch(platform, roomID, line string, started time.Time, info *common.StreamInfo, err error) {
	attrs := []any{
		"platform", platform,
		"room", roomID,
		"line", line,
		"ms", time.Since(started).Milliseconds(),
	}
	if err != nil {
		logging.LiveLog("stream.fetch", append(attrs, "result", "error", "error", err.Error())...)
		return
	}
	live, loop, variants := false, false, 0
	if info != nil {
		live, loop, variants = info.IsLive, info.IsLoop, len(info.Variants)
	}
	logging.LiveLog("stream.fetch", append(attrs,
		"result", "ok", "live", live, "loop", loop, "variants", variants,
	)...)
}
