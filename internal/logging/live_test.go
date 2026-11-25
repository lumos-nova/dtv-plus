package logging

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func liveLogFile(t *testing.T, dir string) string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("读取 live 日志目录失败: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "live-") && strings.HasSuffix(entry.Name(), ".log") {
			return filepath.Join(dir, entry.Name())
		}
	}
	t.Fatalf("live 日志目录中没有 live-*.log: %v", entries)
	return ""
}

func TestLiveLogWritesToOwnDirectoryAndHonoursToggle(t *testing.T) {
	root := t.TempDir()
	t.Setenv("APPDATA", filepath.Join(root, "roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(root, "local"))

	dir := filepath.Join(root, "live-logs")
	closeLogs := installLiveLogger(dir)
	defer closeLogs()

	if !LiveLogEnabled() {
		t.Fatal("直播流日志默认应开启")
	}
	LiveLog("test.enabled", "key", "value")
	if err := SetLiveLogEnabled(false); err != nil {
		t.Fatalf("SetLiveLogEnabled(false): %v", err)
	}
	if loadLiveLogEnabled() {
		t.Fatal("关闭状态未持久化")
	}
	LiveLog("test.disabled", "key", "value")
	if err := SetLiveLogEnabled(true); err != nil {
		t.Fatalf("SetLiveLogEnabled(true): %v", err)
	}
	LiveLog("test.reenabled", "key", "value")
	closeLogs()

	data, err := os.ReadFile(liveLogFile(t, dir))
	if err != nil {
		t.Fatalf("读取 live 日志失败: %v", err)
	}
	text := string(data)
	if !strings.Contains(text, "test.enabled") || !strings.Contains(text, "test.reenabled") {
		t.Fatalf("开启期间的记录缺失: %s", text)
	}
	if strings.Contains(text, "test.disabled") {
		t.Fatalf("关闭期间不应写入记录: %s", text)
	}
	if !strings.Contains(text, "key=value") {
		t.Fatalf("结构化字段未写入: %s", text)
	}
}

func TestSetLiveDirectoryKeepsLiveSubdir(t *testing.T) {
	root := t.TempDir()
	t.Setenv("APPDATA", filepath.Join(root, "roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(root, "local"))

	closeLogs := installLiveLogger(filepath.Join(root, "live-logs"))
	defer closeLogs()

	logsDir := t.TempDir()
	if err := setLiveDirectory(logsDir); err != nil {
		t.Fatalf("setLiveDirectory: %v", err)
	}
	LiveLog("test.after.switch", "key", "value")
	closeLogs()

	data, err := os.ReadFile(liveLogFile(t, filepath.Join(logsDir, "live")))
	if err != nil {
		t.Fatalf("切换后的 live 日志不可读: %v", err)
	}
	if !strings.Contains(string(data), "test.after.switch") {
		t.Fatalf("切换后写入的记录缺失: %s", data)
	}
}
