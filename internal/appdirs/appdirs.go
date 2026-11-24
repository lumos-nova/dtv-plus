// Package appdirs 统一管理 DTV 在本机的目录布局。
package appdirs

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ConfigDir 返回用户配置目录（窗口位置、存储设置等）。
// 默认 <exe目录>\data\config；exe 目录不可写或开发/测试环境下回退 %APPDATA%\DTV。
func ConfigDir() string {
	if base := portableBase(); base != "" {
		return filepath.Join(base, "config")
	}
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = "."
	}
	return filepath.Join(base, "DTV")
}

// LocalAppData 返回本机数据根目录（缓存、日志、WebView2 数据等）。
// 默认 <exe目录>\data；exe 目录不可写或开发/测试环境下回退 %LOCALAPPDATA%\DTV。
func LocalAppData() string {
	if base := portableBase(); base != "" {
		return base
	}
	base, err := os.UserCacheDir()
	if err != nil || base == "" {
		base = "."
	}
	return filepath.Join(base, "DTV")
}

// ImageCacheDir 返回图片代理的磁盘缓存目录。
func ImageCacheDir() string {
	return StoragePaths().CacheDir
}

// LogsDir 返回日志目录。
func LogsDir() string {
	return StoragePaths().LogsDir
}

// RecordingsDir 返回直播回溯与录制文件的默认保存目录。
func RecordingsDir() string {
	return StoragePaths().RecordingsDir
}

// WebView2Dir 返回 WebView2 用户数据目录（避免写入漫游配置）。
func WebView2Dir() string {
	if base := portableBase(); base != "" {
		return filepath.Join(base, "webview2")
	}
	return filepath.Join(LocalAppData(), "WebView2")
}

// Ensure 创建目录（已存在时忽略）。
func Ensure(path string) string {
	_ = os.MkdirAll(path, 0o755)
	return path
}

// StoragePaths stores user-selectable locations for local application data.
type StorageDirs struct {
	CacheDir      string `json:"cacheDir"`
	LogsDir       string `json:"logsDir"`
	RecordingsDir string `json:"recordingsDir"`
}

func DefaultStoragePaths() StorageDirs {
	base := LocalAppData()
	return StorageDirs{
		CacheDir:      filepath.Join(base, "image-cache"),
		LogsDir:       filepath.Join(base, "logs"),
		RecordingsDir: filepath.Join(base, "recordings"),
	}
}

func storagePathsFile() string {
	return filepath.Join(ConfigDir(), "storage_paths.json")
}

// StoragePaths returns the configured paths, falling back field-by-field to defaults.
func StoragePaths() StorageDirs {
	defaults := DefaultStoragePaths()
	data, err := os.ReadFile(storagePathsFile())
	if err != nil {
		return defaults
	}
	var configured StorageDirs
	if json.Unmarshal(data, &configured) != nil {
		return defaults
	}

	configured.CacheDir = validConfiguredPath(configured.CacheDir, defaults.CacheDir)
	configured.LogsDir = validConfiguredPath(configured.LogsDir, defaults.LogsDir)
	configured.RecordingsDir = validConfiguredPath(configured.RecordingsDir, defaults.RecordingsDir)
	return configured
}

func validConfiguredPath(path, fallback string) string {
	path = strings.TrimSpace(path)
	if path == "" || !filepath.IsAbs(path) {
		return fallback
	}
	return filepath.Clean(path)
}

// NormalizeStoragePaths validates paths and creates all selected directories.
func NormalizeStoragePaths(paths StorageDirs) (StorageDirs, error) {
	defaults := DefaultStoragePaths()
	targets := []struct {
		label    string
		target   *string
		fallback string
	}{
		{label: "缓存", target: &paths.CacheDir, fallback: defaults.CacheDir},
		{label: "日志", target: &paths.LogsDir, fallback: defaults.LogsDir},
		{label: "录制", target: &paths.RecordingsDir, fallback: defaults.RecordingsDir},
	}
	for _, item := range targets {
		value := strings.TrimSpace(*item.target)
		if value == "" {
			value = item.fallback
		}
		absolute, err := filepath.Abs(value)
		if err != nil {
			return StorageDirs{}, fmt.Errorf("解析%s目录失败：%w", item.label, err)
		}
		if err := os.MkdirAll(absolute, 0o755); err != nil {
			return StorageDirs{}, fmt.Errorf("创建%s目录失败：%w", item.label, err)
		}
		info, err := os.Stat(absolute)
		if err != nil {
			return StorageDirs{}, fmt.Errorf("检查%s目录失败：%w", item.label, err)
		}
		if !info.IsDir() {
			return StorageDirs{}, fmt.Errorf("%s路径不是目录", item.label)
		}
		*item.target = filepath.Clean(absolute)
	}
	return paths, nil
}

// SaveStoragePaths persists validated paths in the user config directory.
func SaveStoragePaths(paths StorageDirs) error {
	normalized, err := NormalizeStoragePaths(paths)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化存储设置失败：%w", err)
	}
	if err := os.MkdirAll(ConfigDir(), 0o755); err != nil {
		return fmt.Errorf("创建配置目录失败：%w", err)
	}
	path := storagePathsFile()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("写入存储设置失败：%w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("保存存储设置失败：%w", err)
	}
	return nil
}
