package logging

import (
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"dtv/internal/appdirs"
)

// 直播流日志：与主日志物理隔离，单独放在 <logsDir>/live/live-YYYYMMDD.log。
//
// 这里记录取流、中继续流、播放器断流与自愈决策等排障信息。文件按天/10MB 轮转，
// 复用主日志的 rotatingWriter（只是文件名前缀不同）。开关由用户在设置里控制，
// 关闭时 LiveLog 直接返回，不产生任何写入。

const (
	liveLogDirName = "live"
	liveFilePrefix = "live-"
)

var (
	liveEnabled atomic.Bool
	liveMu      sync.Mutex
	liveRoute   *switchingWriter
	liveLogger  *slog.Logger
)

// LiveLogDir 返回直播流日志所在目录（跟随用户配置的日志目录）。
func LiveLogDir() string {
	return filepath.Join(appdirs.LogsDir(), liveLogDirName)
}

type liveLogConfig struct {
	Enabled bool `json:"enabled"`
}

func liveLogConfigPath() string {
	return filepath.Join(appdirs.ConfigDir(), "live_log.json")
}

// loadLiveLogEnabled 读取用户持久化的开关；文件不存在时默认开启。
func loadLiveLogEnabled() bool {
	data, err := os.ReadFile(liveLogConfigPath())
	if err != nil {
		return true
	}
	var cfg liveLogConfig
	if json.Unmarshal(data, &cfg) != nil {
		return true
	}
	return cfg.Enabled
}

func saveLiveLogEnabled(enabled bool) error {
	data, err := json.Marshal(liveLogConfig{Enabled: enabled})
	if err != nil {
		return err
	}
	dir := appdirs.ConfigDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	path := liveLogConfigPath()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// setupLive 在应用启动时初始化直播流日志，并恢复用户上次选择的开关状态。
func setupLive() func() {
	closeLogs := installLiveLogger(appdirs.Ensure(LiveLogDir()))
	liveEnabled.Store(loadLiveLogEnabled())
	return closeLogs
}

// installLiveLogger 把直播流日志输出安装到指定目录，返回关闭函数。
func installLiveLogger(dir string) func() {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return func() {}
	}
	writer, err := newRotatingWriterWithPrefix(dir, liveFilePrefix)
	if err != nil {
		// 目录不可写不能让应用起不来；LiveLog 会在 logger 为空时静默跳过。
		return func() {}
	}
	route := &switchingWriter{writer: writer}
	logger := slog.New(slog.NewTextHandler(route, &slog.HandlerOptions{Level: slog.LevelInfo}))

	liveMu.Lock()
	previous := liveRoute
	liveRoute = route
	liveLogger = logger
	liveMu.Unlock()
	liveEnabled.Store(true)
	if previous != nil {
		_ = previous.Close()
	}
	slog.Info("直播流日志已启用", "dir", dir)

	return func() {
		liveMu.Lock()
		if liveRoute == route {
			liveRoute = nil
			liveLogger = nil
		}
		liveEnabled.Store(false)
		liveMu.Unlock()
		_ = route.Close()
	}
}

// setLiveDirectory 在用户修改日志目录后切换直播流日志目录（保留其 live/ 子目录）。
func setLiveDirectory(logsDir string) error {
	dir := appdirs.Ensure(filepath.Join(logsDir, liveLogDirName))
	next, err := newRotatingWriterWithPrefix(dir, liveFilePrefix)
	if err != nil {
		return err
	}

	liveMu.Lock()
	route := liveRoute
	if route == nil {
		liveMu.Unlock()
		_ = next.Close()
		return errors.New("直播流日志尚未初始化")
	}
	previous := route.replace(next)
	liveMu.Unlock()
	if previous != nil {
		_ = previous.Close()
	}
	slog.Info("直播流日志目录已更改", "dir", dir)
	return nil
}

// SetLiveLogEnabled 打开/关闭直播流日志并持久化。关闭只停止写入，不删历史文件。
func SetLiveLogEnabled(enabled bool) error {
	liveEnabled.Store(enabled)
	return saveLiveLogEnabled(enabled)
}

// LiveLogEnabled 返回当前开关状态。
func LiveLogEnabled() bool {
	return liveEnabled.Load()
}

// LiveLog 写一条直播流排障日志。关闭时或无可用 writer 时直接返回。
func LiveLog(event string, attrs ...any) {
	if !liveEnabled.Load() {
		return
	}
	liveMu.Lock()
	logger := liveLogger
	liveMu.Unlock()
	if logger == nil {
		return
	}
	logger.Info(event, attrs...)
}
