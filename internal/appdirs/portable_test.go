package appdirs

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// resetPortableBase 重置便携目录缓存，让每个用例独立计算 base。
func resetPortableBase(t *testing.T) {
	t.Helper()
	baseOnce = sync.Once{}
	baseDir = ""
	t.Cleanup(func() {
		baseOnce = sync.Once{}
		baseDir = ""
	})
}

func TestPortableBaseUsesExeDir(t *testing.T) {
	resetPortableBase(t)
	// 测试 exe 位于系统临时目录，必须回退 AppData，
	// 否则每次 go test 的数据都会写进一次性构建目录。
	t.Setenv("APPDATA", filepath.Join(t.TempDir(), "roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(t.TempDir(), "local"))

	if base := portableBase(); base != "" {
		t.Fatalf("portableBase() = %q，测试环境应回退 AppData", base)
	}
	if got := ConfigDir(); filepath.Base(filepath.Dir(got)) != "roaming" {
		t.Fatalf("ConfigDir() = %q，应位于 APPDATA 下", got)
	}
}

func TestUnderTempDir(t *testing.T) {
	tmp := os.TempDir()
	if !underTempDir(filepath.Join(tmp, "go-build123", "b001")) {
		t.Error("临时目录下的路径应判定为 true")
	}
	if underTempDir(filepath.Join(tmp+"-other", "DTV")) {
		t.Error("仅前缀相似的路径不应判定为临时目录")
	}
	if underTempDir("") {
		t.Error("空路径不应判定为临时目录")
	}
}

func TestDirWritable(t *testing.T) {
	root := t.TempDir()
	if !dirWritable(filepath.Join(root, "new", "nested")) {
		t.Error("可创建目录应判定为可写")
	}
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if dirWritable(file) {
		t.Error("普通文件路径不应判定为可写目录")
	}
	if dirWritable("") {
		t.Error("空路径不应判定为可写")
	}
}

func TestMigrateLegacyDataCopiesConfigAndWebview(t *testing.T) {
	root := t.TempDir()
	roaming := filepath.Join(root, "roaming")
	local := filepath.Join(root, "local")
	t.Setenv("APPDATA", roaming)
	t.Setenv("LOCALAPPDATA", local)

	legacyConfig := filepath.Join(roaming, "DTV")
	if err := os.MkdirAll(legacyConfig, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacyConfig, "window.json"), []byte(`{"width":1200}`), 0o600); err != nil {
		t.Fatal(err)
	}
	legacyWebview := filepath.Join(local, "DTV", "WebView2", "EBWebView", "Default")
	if err := os.MkdirAll(legacyWebview, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacyWebview, "Preferences"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}

	base := filepath.Join(root, "exe", "data")
	migrateLegacyData(base)

	if data, err := os.ReadFile(filepath.Join(base, "config", "window.json")); err != nil || string(data) != `{"width":1200}` {
		t.Fatalf("配置文件未迁移: %v %q", err, data)
	}
	if _, err := os.Stat(filepath.Join(base, "webview2", "EBWebView", "Default", "Preferences")); err != nil {
		t.Fatalf("WebView2 数据未迁移: %v", err)
	}

	// 第二次调用不应覆盖已迁移（可能已被用户更新）的文件。
	if err := os.WriteFile(filepath.Join(base, "config", "window.json"), []byte(`{"width":1400}`), 0o600); err != nil {
		t.Fatal(err)
	}
	migrateLegacyData(base)
	if data, _ := os.ReadFile(filepath.Join(base, "config", "window.json")); string(data) != `{"width":1400}` {
		t.Fatalf("重复迁移覆盖了新配置: %q", data)
	}
}

func TestMigrateLegacyDataSkipsFreshInstall(t *testing.T) {
	root := t.TempDir()
	t.Setenv("APPDATA", filepath.Join(root, "roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(root, "local"))

	base := filepath.Join(root, "exe", "data")
	migrateLegacyData(base)
	if _, err := os.Stat(filepath.Join(base, "config")); !os.IsNotExist(err) {
		t.Fatal("全新安装不应创建 config 目录（会阻断后续真正的迁移）")
	}
}