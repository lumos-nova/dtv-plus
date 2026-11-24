package appdirs

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// 便携化目录布局：所有数据默认放在 exe 同级的 data\ 下，安装版与便携版
// 行为一致；exe 目录不可写（如被装进 Program Files 且无管理员权限）或
// 处于开发/测试环境（exe 在系统临时目录）时，回退到旧的 AppData 布局。
//
//	data\
//	  config\      窗口位置、存储设置、录制设置等用户配置
//	  webview2\    WebView2 用户数据（含前端 localStorage 的登录态）
//	  image-cache\ 图片代理磁盘缓存
//	  logs\        日志
//	  recordings\  录制默认目录

var (
	baseOnce sync.Once
	baseDir  string // 便携模式为 <exe目录>\data；回退模式为空
)

// exeDir 返回可执行文件所在目录；取不到时返回空串。
func exeDir() string {
	exe, err := os.Executable()
	if err != nil || exe == "" {
		return ""
	}
	if resolved, resolveErr := filepath.EvalSymlinks(exe); resolveErr == nil {
		exe = resolved
	}
	return filepath.Dir(exe)
}

// underTempDir 判断路径是否位于系统临时目录（go run / go test 的 exe
// 都在那里，每次构建路径都会变，数据不能跟着走）。
func underTempDir(path string) bool {
	if path == "" {
		return false
	}
	tmp := os.TempDir()
	rel, err := filepath.Rel(tmp, path)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// dirWritable 通过实际创建目录并写入临时文件来探测可写性。
func dirWritable(dir string) bool {
	if dir == "" {
		return false
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false
	}
	probe, err := os.CreateTemp(dir, ".dtv-write-test-*")
	if err != nil {
		return false
	}
	name := probe.Name()
	_ = probe.Close()
	_ = os.Remove(name)
	return true
}

// portableBase 计算并缓存便携数据根目录；返回空串表示回退 AppData。
func portableBase() string {
	baseOnce.Do(func() {
		dir := exeDir()
		if dir == "" || underTempDir(dir) {
			return
		}
		candidate := filepath.Join(dir, "data")
		if !dirWritable(candidate) {
			slog.Warn("exe 目录不可写，数据回退到 AppData", "dir", candidate)
			return
		}
		baseDir = candidate
		migrateLegacyData(candidate)
	})
	return baseDir
}

// migrateLegacyData 首次启用便携布局时，把旧 AppData 布局中的用户数据
// 一次性拷贝过来（只拷贝、不删除，旧目录留作备份）：
//   - %APPDATA%\DTV 下的配置文件（window.json、storage_paths.json 等）
//   - %LOCALAPPDATA%\DTV\WebView2 整体（前端 localStorage 存有登录态、
//     订阅、多画面布局，不迁移等于全部丢失）
//
// 图片缓存 / 日志 / 录制不迁移：前两者可再生，录制体积大且旧配置里的
// 绝对路径仍然有效。
func migrateLegacyData(base string) {
	configDst := filepath.Join(base, "config")
	if _, err := os.Stat(configDst); err == nil {
		return // 已初始化过，不重复迁移
	}

	// 先确认确有旧数据再建目录：全新安装不应留下空的 config 目录，
	// 否则下次启动会误判为"已初始化"而跳过真正的迁移。
	roamingSrc := ""
	if roaming, err := os.UserConfigDir(); err == nil && roaming != "" {
		candidate := filepath.Join(roaming, "DTV")
		if info, statErr := os.Stat(candidate); statErr == nil && info.IsDir() {
			roamingSrc = candidate
		}
	}
	webviewSrc := ""
	if local, err := os.UserCacheDir(); err == nil && local != "" {
		candidate := filepath.Join(local, "DTV", "WebView2")
		if info, statErr := os.Stat(candidate); statErr == nil && info.IsDir() {
			webviewSrc = candidate
		}
	}
	if roamingSrc == "" && webviewSrc == "" {
		return
	}

	if err := os.MkdirAll(configDst, 0o755); err != nil {
		return
	}
	if roamingSrc != "" {
		copyDirShallow(roamingSrc, configDst)
	}
	if webviewSrc != "" {
		if err := copyDirTree(webviewSrc, filepath.Join(base, "webview2")); err != nil {
			slog.Warn("迁移 WebView2 数据失败", "error", err)
		}
	}
	slog.Info("已迁移旧数据到程序目录", "dir", base)
}

// copyDirShallow 拷贝目录下的普通文件（不递归、不覆盖已存在文件）。
func copyDirShallow(src, dst string) {
	entries, err := os.ReadDir(src)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		copyFileIfMissing(filepath.Join(src, entry.Name()), filepath.Join(dst, entry.Name()))
	}
}

func copyFileIfMissing(src, dst string) {
	if _, err := os.Stat(dst); err == nil {
		return
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return
	}
	_ = os.WriteFile(dst, data, 0o600)
}

// copyDirTree 递归拷贝目录（跳过符号链接与已存在的目标文件）。
func copyDirTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil // 单个文件读不到就跳过，尽量多迁移
		}
		rel, relErr := filepath.Rel(src, path)
		if relErr != nil {
			return nil
		}
		target := filepath.Join(dst, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if entry.Type().IsRegular() {
			copyFileIfMissing(path, target)
		}
		return nil
	})
}