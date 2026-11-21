package services

import (
	"os"
	"path/filepath"
	"testing"

	"dtv/internal/appdirs"
)

// configureTempStorage 把配置与本机数据目录都指到测试临时目录，
// 避免测试写到真实用户目录（Windows 用 APPDATA，Linux 用 XDG_*）。
func configureTempStorage(t *testing.T) appdirs.StorageDirs {
	t.Helper()
	root := t.TempDir()
	t.Setenv("APPDATA", filepath.Join(root, "roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(root, "local"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "xdg-config"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(root, "xdg-cache"))
	paths := appdirs.StorageDirs{
		CacheDir:      filepath.Join(root, "cache"),
		LogsDir:       filepath.Join(root, "logs"),
		RecordingsDir: filepath.Join(root, "recordings"),
	}
	if err := appdirs.SaveStoragePaths(paths); err != nil {
		t.Fatalf("SaveStoragePaths() error = %v", err)
	}
	return appdirs.StoragePaths()
}

func TestCleanTempFilesRemovesOnlyTempArtifacts(t *testing.T) {
	paths := configureTempStorage(t)
	files := map[string]int{
		"clip.tmp":      128,
		"download.part": 64,
		"saved.mp4":     1,
		"saved.webm":    2,
		"saved.gif":     3,
	}
	for name, size := range files {
		if err := os.WriteFile(filepath.Join(paths.RecordingsDir, name), make([]byte, size), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// 目录即使带 .tmp 后缀也不能被删。
	nested := filepath.Join(paths.RecordingsDir, "nested.tmp")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}

	svc := NewStorageSettingsService(nil)
	result, err := svc.CleanTempFiles()
	if err != nil {
		t.Fatalf("CleanTempFiles() error = %v", err)
	}
	if result.RemovedFiles != 2 || result.FreedBytes != 192 {
		t.Fatalf("CleanTempFiles() = %+v, want 2 files / 192 bytes", result)
	}
	for _, name := range []string{"saved.mp4", "saved.webm", "saved.gif", "nested.tmp"} {
		if _, err := os.Stat(filepath.Join(paths.RecordingsDir, name)); err != nil {
			t.Errorf("%s should survive cleanup: %v", name, err)
		}
	}
	for _, name := range []string{"clip.tmp", "download.part"} {
		if _, err := os.Stat(filepath.Join(paths.RecordingsDir, name)); !os.IsNotExist(err) {
			t.Errorf("%s should be removed, stat err = %v", name, err)
		}
	}
}

func TestCleanTempFilesMissingDirectory(t *testing.T) {
	root := t.TempDir()
	t.Setenv("APPDATA", filepath.Join(root, "roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(root, "local"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "xdg-config"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(root, "xdg-cache"))

	svc := NewStorageSettingsService(nil)
	result, err := svc.CleanTempFiles()
	if err != nil {
		t.Fatalf("CleanTempFiles() with missing dir error = %v", err)
	}
	if result.RemovedFiles != 0 || result.FreedBytes != 0 {
		t.Fatalf("CleanTempFiles() = %+v, want zero result", result)
	}
}

func TestOpenDirectoryRejectsUnconfiguredPath(t *testing.T) {
	configureTempStorage(t)
	svc := NewStorageSettingsService(nil)
	if err := svc.OpenDirectory(t.TempDir()); err == nil {
		t.Fatal("OpenDirectory() accepted a path outside configured storage dirs")
	}
	if err := svc.OpenDirectory("   "); err == nil {
		t.Fatal("OpenDirectory() accepted an empty path")
	}
}
