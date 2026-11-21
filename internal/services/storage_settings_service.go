package services

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"dtv/internal/appdirs"
	"dtv/internal/logging"
	"github.com/wailsapp/wails/v3/pkg/application"
)

type StorageSettingsService struct {
	imageProxy *ImageProxyService
}

func NewStorageSettingsService(imageProxy *ImageProxyService) *StorageSettingsService {
	return &StorageSettingsService{imageProxy: imageProxy}
}

func (s *StorageSettingsService) GetPaths() appdirs.StorageDirs {
	return appdirs.StoragePaths()
}

func (s *StorageSettingsService) PickDirectory() (string, error) {
	app := application.Get()
	if app == nil || app.Dialog == nil {
		return "", errors.New("当前环境不支持系统文件对话框")
	}
	path, err := app.Dialog.OpenFile().
		SetTitle("选择存储目录").
		SetMessage("选择一个本机目录").
		CanChooseFiles(false).
		CanChooseDirectories(true).
		CanCreateDirectories(true).
		PromptForSingleSelection()
	if err != nil {
		return "", fmt.Errorf("打开目录选择框失败：%w", err)
	}
	return strings.TrimSpace(path), nil
}

func (s *StorageSettingsService) SetPaths(paths appdirs.StorageDirs) error {
	normalized, err := appdirs.NormalizeStoragePaths(paths)
	if err != nil {
		return err
	}

	previous := appdirs.StoragePaths()
	if err := logging.SetDirectory(normalized.LogsDir); err != nil {
		return fmt.Errorf("切换日志目录失败：%w", err)
	}
	if s.imageProxy != nil {
		if err := s.imageProxy.SetCacheDir(normalized.CacheDir); err != nil {
			rollbackErr := logging.SetDirectory(previous.LogsDir)
			return errors.Join(
				fmt.Errorf("切换缓存目录失败：%w", err),
				wrapRollbackError("恢复日志目录失败", rollbackErr),
			)
		}
	}
	if err := appdirs.SaveStoragePaths(normalized); err != nil {
		var rollbackErr error
		if s.imageProxy != nil {
			rollbackErr = s.imageProxy.SetCacheDir(previous.CacheDir)
		}
		logRollbackErr := logging.SetDirectory(previous.LogsDir)
		return errors.Join(
			fmt.Errorf("保存存储设置失败：%w", err),
			wrapRollbackError("恢复缓存目录失败", rollbackErr),
			wrapRollbackError("恢复日志目录失败", logRollbackErr),
		)
	}
	return nil
}

// TempCleanupResult 是「清理临时文件」的结果统计。
type TempCleanupResult struct {
	RemovedFiles int   `json:"removedFiles"`
	FreedBytes   int64 `json:"freedBytes"`
}

// OpenDirectory 在系统文件管理器中打开一个已配置的存储目录。
//
// 出于安全考虑只接受当前设置里的缓存 / 日志 / 录制目录，
// 不接受前端传来的任意路径。
func (s *StorageSettingsService) OpenDirectory(path string) error {
	cleaned := filepath.Clean(strings.TrimSpace(path))
	if cleaned == "" || cleaned == "." {
		return errors.New("目录路径为空")
	}
	paths := appdirs.StoragePaths()
	allowed := false
	for _, candidate := range []string{paths.CacheDir, paths.LogsDir, paths.RecordingsDir} {
		if pathsEqual(candidate, cleaned) {
			allowed = true
			break
		}
	}
	if !allowed {
		return errors.New("只能打开设置中的存储目录")
	}
	if err := os.MkdirAll(cleaned, 0o755); err != nil {
		return fmt.Errorf("创建目录失败：%w", err)
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", cleaned)
	case "darwin":
		cmd = exec.Command("open", cleaned)
	default:
		cmd = exec.Command("xdg-open", cleaned)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("打开目录失败：%w", err)
	}
	// explorer 即使成功也常以退出码 1 结束，这里只回收子进程，不关心退出码。
	go func() { _ = cmd.Wait() }()
	return nil
}

func pathsEqual(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// CleanTempFiles 删除录制目录里遗留的临时文件（*.tmp / *.part）。
//
// 只清理明确的临时扩展名，不触碰用户已保存的 WebM / MP4 / GIF。
func (s *StorageSettingsService) CleanTempFiles() (TempCleanupResult, error) {
	dir := appdirs.RecordingsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return TempCleanupResult{}, nil
		}
		return TempCleanupResult{}, fmt.Errorf("读取录制目录失败：%w", err)
	}
	var result TempCleanupResult
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		if ext != ".tmp" && ext != ".part" {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		info, infoErr := entry.Info()
		if infoErr == nil {
			result.FreedBytes += info.Size()
		}
		if removeErr := os.Remove(path); removeErr != nil {
			return result, fmt.Errorf("删除临时文件 %s 失败：%w", entry.Name(), removeErr)
		}
		result.RemovedFiles++
	}
	return result, nil
}

func wrapRollbackError(message string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s：%w", message, err)
}
