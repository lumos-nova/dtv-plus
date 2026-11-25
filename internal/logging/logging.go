// Package logging 把 slog 输出同时写到文件与 stderr。
package logging

import (
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"dtv/internal/appdirs"
)

const maxLogBytes = 10 << 20 // 单文件 10MB，超出后滚动到 .1

type rotatingWriter struct {
	mu     sync.Mutex
	dir    string
	prefix string
	day    string
	file   *os.File
	size   int64
}

type switchingWriter struct {
	mu     sync.Mutex
	writer *rotatingWriter
}

var setupMu sync.Mutex
var activeWriter *switchingWriter

func newRotatingWriter(dir string) (*rotatingWriter, error) {
	return newRotatingWriterWithPrefix(dir, "dtv-")
}

func newRotatingWriterWithPrefix(dir, prefix string) (*rotatingWriter, error) {
	if prefix == "" {
		prefix = "dtv-"
	}
	w := &rotatingWriter{dir: dir, prefix: prefix}
	if err := w.open(); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *rotatingWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}

func (w *switchingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.writer == nil {
		return len(p), nil
	}
	return w.writer.Write(p)
}

func (w *switchingWriter) replace(next *rotatingWriter) *rotatingWriter {
	w.mu.Lock()
	defer w.mu.Unlock()
	previous := w.writer
	w.writer = next
	return previous
}

func (w *switchingWriter) Close() error {
	previous := w.replace(nil)
	if previous == nil {
		return nil
	}
	return previous.Close()
}

func (w *rotatingWriter) open() error {
	w.day = time.Now().Format("20060102")
	path := filepath.Join(w.dir, w.prefix+w.day+".log")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	info, _ := file.Stat()
	w.file = file
	if info != nil {
		w.size = info.Size()
	}
	return nil
}

func (w *rotatingWriter) rotate() error {
	if w.file != nil {
		path := w.file.Name()
		if err := w.file.Close(); err != nil {
			w.file = nil
			return err
		}
		w.file = nil
		if err := os.Rename(path, path+".1"); err != nil {
			return err
		}
	}
	w.size = 0
	return w.open()
}

func (w *rotatingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	// 跨天或超过大小上限时滚动
	if w.file == nil {
		if err := w.open(); err != nil {
			return 0, err
		}
	}
	if time.Now().Format("20060102") != w.day || w.size+int64(len(p)) > maxLogBytes {
		if err := w.rotate(); err != nil {
			return 0, err
		}
	}
	if w.file == nil {
		return 0, errors.New("日志文件未打开")
	}
	n, err := w.file.Write(p)
	w.size += int64(n)
	return n, err
}

// bestEffortWriter 包装可能失效的输出（如 windowsgui 进程无控制台时的
// os.Stderr）：写入失败直接吞掉，避免 io.MultiWriter 因首个 writer 报错
// 而中断，导致后面的日志文件永远写不进去。
type bestEffortWriter struct{ w io.Writer }

func (b bestEffortWriter) Write(p []byte) (int, error) {
	_, _ = b.w.Write(p)
	return len(p), nil
}

// Setup 初始化全局 logger：文件 + stderr（便于 `wails3 dev` 时观察）。
// 返回的函数用于在退出时关闭文件。
func Setup() func() {
	// 直播流日志独立写入 <logsDir>/live/，与主日志分开轮转。
	closeLive := setupLive()

	dir := appdirs.Ensure(appdirs.LogsDir())
	writer, err := newRotatingWriter(dir)
	if err != nil {
		// 日志目录不可写时退回 stderr，不能让应用起不来
		route := &switchingWriter{}
		setupMu.Lock()
		activeWriter = route
		setupMu.Unlock()
		slog.SetDefault(slog.New(slog.NewTextHandler(io.MultiWriter(bestEffortWriter{os.Stderr}, route), nil)))
		return func() {
			closeLive()
			setupMu.Lock()
			if activeWriter == route {
				activeWriter = nil
			}
			setupMu.Unlock()
			_ = route.Close()
		}
	}

	route := &switchingWriter{writer: writer}
	setupMu.Lock()
	activeWriter = route
	setupMu.Unlock()
	multi := io.MultiWriter(bestEffortWriter{os.Stderr}, route)
	handler := slog.NewTextHandler(multi, &slog.HandlerOptions{Level: slog.LevelInfo})
	slog.SetDefault(slog.New(handler))
	slog.Info("日志已启用", "dir", dir)

	return func() {
		closeLive()
		setupMu.Lock()
		if activeWriter == route {
			activeWriter = nil
		}
		setupMu.Unlock()
		_ = route.Close()
	}
}

// SetDirectory switches future log writes to the selected directory.
func SetDirectory(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	next, err := newRotatingWriter(dir)
	if err != nil {
		return err
	}

	setupMu.Lock()
	route := activeWriter
	if route == nil {
		setupMu.Unlock()
		_ = next.Close()
		return errors.New("日志输出尚未初始化")
	}
	previous := route.replace(next)
	setupMu.Unlock()
	if previous != nil {
		_ = previous.Close()
	}
	// 直播流日志跟随日志目录一起迁移，仍放在其 live/ 子目录。
	if err := setLiveDirectory(dir); err != nil {
		slog.Warn("直播流日志目录切换失败", "dir", dir, "error", err)
	}
	slog.Info("日志目录已更改", "dir", dir)
	return nil
}
