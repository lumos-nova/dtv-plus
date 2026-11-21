package appdirs

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNormalizeStoragePathsCreatesDirectories(t *testing.T) {
	root := t.TempDir()
	input := StorageDirs{
		CacheDir:      filepath.Join(root, "cache"),
		LogsDir:       filepath.Join(root, "logs"),
		RecordingsDir: filepath.Join(root, "recordings"),
	}

	got, err := NormalizeStoragePaths(input)
	if err != nil {
		t.Fatalf("NormalizeStoragePaths() error = %v", err)
	}
	for _, path := range []string{got.CacheDir, got.LogsDir, got.RecordingsDir} {
		if !filepath.IsAbs(path) {
			t.Errorf("path %q is not absolute", path)
		}
		info, statErr := os.Stat(path)
		if statErr != nil {
			t.Errorf("directory %q was not created: %v", path, statErr)
		} else if !info.IsDir() {
			t.Errorf("path %q is not a directory", path)
		}
	}
}

func TestNormalizeStoragePathsRejectsFile(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "not-a-directory")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := NormalizeStoragePaths(StorageDirs{
		CacheDir:      filepath.Join(root, "cache"),
		LogsDir:       file,
		RecordingsDir: filepath.Join(root, "recordings"),
	})
	if err == nil {
		t.Fatal("NormalizeStoragePaths() accepted a file as a directory")
	}
}

func TestSaveStoragePathsReplacesConfiguredPaths(t *testing.T) {
	root := t.TempDir()
	t.Setenv("APPDATA", filepath.Join(root, "roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(root, "local"))

	first := StorageDirs{
		CacheDir:      filepath.Join(root, "cache-one"),
		LogsDir:       filepath.Join(root, "logs-one"),
		RecordingsDir: filepath.Join(root, "recordings-one"),
	}
	if err := SaveStoragePaths(first); err != nil {
		t.Fatalf("SaveStoragePaths() first call error = %v", err)
	}
	second := StorageDirs{
		CacheDir:      filepath.Join(root, "cache-two"),
		LogsDir:       filepath.Join(root, "logs-two"),
		RecordingsDir: filepath.Join(root, "recordings-two"),
	}
	if err := SaveStoragePaths(second); err != nil {
		t.Fatalf("SaveStoragePaths() second call error = %v", err)
	}
	if got := StoragePaths(); got != second {
		t.Fatalf("StoragePaths() = %#v, want %#v", got, second)
	}
}
