package services

import (
	"net/url"
	"path/filepath"
	"testing"
)

func TestImageProxySetCacheDirSwitchesCachePaths(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cache")
	service := NewImageProxyService()
	if err := service.SetCacheDir(dir); err != nil {
		t.Fatalf("SetCacheDir() error = %v", err)
	}

	target, err := url.Parse("https://i0.hdslb.com/bfs/live/example.jpg")
	if err != nil {
		t.Fatal(err)
	}
	path, _ := service.cachePaths(target, 320)
	if filepath.Dir(path) != dir {
		t.Fatalf("cache path = %q, want directory %q", path, dir)
	}
}
