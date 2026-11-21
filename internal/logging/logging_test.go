package logging

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
	if len(entries) != 1 {
		t.Fatalf("selected log directory contains %d files, want one", len(entries))
	}
	data, err := os.ReadFile(filepath.Join(selected, entries[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "storage path switch test") {
		t.Fatalf("selected log file does not contain the new log record: %s", data)
	}
}
