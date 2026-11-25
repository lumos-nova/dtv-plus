package logging

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// windowsgui 进程无控制台时 os.Stderr 句柄无效，写入报错；
// 日志文件必须不受影响（回归：io.MultiWriter 曾因 stderr 报错而中断）。
func TestSetupLogsToFileWhenStderrInvalid(t *testing.T) {
	root := t.TempDir()
	t.Setenv("APPDATA", filepath.Join(root, "roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(root, "local"))

	broken, err := os.OpenFile(filepath.Join(root, "readonly"), os.O_CREATE|os.O_RDONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer broken.Close()
	original := os.Stderr
	os.Stderr = broken // 只读句柄：Write 必然失败，模拟无效 stderr
	defer func() { os.Stderr = original }()

	closeLogs := Setup()
	defer func() {
		closeLogs()
		slog.SetDefault(slog.New(slog.NewTextHandler(original, nil)))
	}()

	slog.Info("stderr invalid test")

	entries, err := os.ReadDir(filepath.Join(root, "local", "DTV", "logs"))
	if err != nil {
		t.Fatalf("reading log directory: %v", err)
	}
	var logFileName string
	for _, entry := range entries {
		if !entry.IsDir() {
			logFileName = entry.Name()
			break
		}
	}
	if logFileName == "" {
		t.Fatal("no log file created")
	}
	data, err := os.ReadFile(filepath.Join(root, "local", "DTV", "logs", logFileName))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "stderr invalid test") {
		t.Fatalf("log file missing record despite invalid stderr: %s", data)
	}
}

func TestSetDirectorySwitchesLogWriter(t *testing.T) {
	root := t.TempDir()
	t.Setenv("APPDATA", filepath.Join(root, "roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(root, "local"))

	closeLogs := Setup()
	defer func() {
		closeLogs()
		slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	}()

	selected := filepath.Join(root, "selected-logs")
	if err := SetDirectory(selected); err != nil {
		t.Fatalf("SetDirectory() error = %v", err)
	}
	slog.Info("storage path switch test")

	entries, err := os.ReadDir(selected)
	if err != nil {
		t.Fatalf("reading selected log directory: %v", err)
	}
	// live/ 是直播流日志的子目录，不算主日志文件。
	var logFiles []string
	for _, entry := range entries {
		if !entry.IsDir() {
			logFiles = append(logFiles, entry.Name())
		}
	}
	if len(logFiles) != 1 {
		t.Fatalf("selected log directory contains %d files, want one: %v", len(logFiles), logFiles)
	}
	data, err := os.ReadFile(filepath.Join(selected, logFiles[0]))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "storage path switch test") {
		t.Fatalf("selected log file does not contain the new log record: %s", data)
	}
}
