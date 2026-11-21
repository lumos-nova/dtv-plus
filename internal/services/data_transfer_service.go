// Package services 是 Go 业务逻辑与前端之间的 IPC 边界。
package services

import (
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"dtv/internal/appdirs"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// DataTransferFile 是原生文件对话框的返回结果。
//
// Content 只在导入时有值；Path / Name 在导入和导出时都会返回。
type DataTransferFile struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Content string `json:"content"`
}

// DataTransferService 提供 JSON 配置文件的导入 / 导出能力。
//
// 只负责系统文件对话框和磁盘读写，配置内容的序列化与合并逻辑都在前端
// （frontend/src/lib/configTransfer.ts），这样可以和局域网同步共用一套
// 增量合并规则。
type DataTransferService struct{}

// NewDataTransferService 创建配置文件传输服务。
func NewDataTransferService() *DataTransferService {
	return &DataTransferService{}
}

// PickImportJSONFile 打开系统文件选择框并读取选中的 JSON 文件。
//
// 用户取消时返回 (nil, nil)，前端据此静默忽略。
func (s *DataTransferService) PickImportJSONFile() (*DataTransferFile, error) {
	app := application.Get()
	if app == nil || app.Dialog == nil {
		return nil, fmt.Errorf("当前环境不支持系统文件对话框")
	}

	path, err := app.Dialog.OpenFile().
		SetTitle("导入 DTV 配置").
		SetMessage("选择由 DTV 导出的 JSON 配置文件").
		AddFilter("DTV 配置", "*.json").
		CanCreateDirectories(false).
		PromptForSingleSelection()
	if err != nil {
		return nil, fmt.Errorf("打开文件对话框失败：%w", err)
	}
	if strings.TrimSpace(path) == "" {
		return nil, nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取配置文件失败：%w", err)
	}

	return &DataTransferFile{
		Name:    filepath.Base(path),
		Path:    path,
		Content: string(data),
	}, nil
}

// SaveExportJSONFile 打开系统保存框并写入配置文本。
//
// suggestedName 为空时使用 dtv-config.json；用户取消时返回 (nil, nil)。
func (s *DataTransferService) SaveExportJSONFile(content string, suggestedName string) (*DataTransferFile, error) {
	app := application.Get()
	if app == nil || app.Dialog == nil {
		return nil, fmt.Errorf("当前环境不支持系统文件对话框")
	}

	name := strings.TrimSpace(suggestedName)
	if name == "" {
		name = "dtv-config.json"
	}
	if !strings.HasSuffix(strings.ToLower(name), ".json") {
		name += ".json"
	}

	path, err := func() (string, error) {
		dialog := app.Dialog.SaveFile()
		dialog.SetOptions(&application.SaveFileDialogOptions{Title: "导出 DTV 配置"})
		return dialog.
			SetMessage("选择配置文件的保存位置").
			AddFilter("DTV 配置", "*.json").
			SetFilename(name).
			CanCreateDirectories(true).
			AllowsOtherFileTypes(true).
			PromptForSingleSelection()
	}()
	if err != nil {
		return nil, fmt.Errorf("打开保存对话框失败：%w", err)
	}
	if strings.TrimSpace(path) == "" {
		return nil, nil
	}
	if filepath.Ext(path) == "" {
		path += ".json"
	}

	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return nil, fmt.Errorf("写入配置文件失败：%w", err)
	}

	return &DataTransferFile{
		Name: filepath.Base(path),
		Path: path,
	}, nil
}

// SaveRecordingFile prompts for a destination and writes a WebM, MP4, or GIF recording.
func (s *DataTransferService) SaveRecordingFile(encodedContent string, suggestedName string) (*DataTransferFile, error) {
	const maxRecordingBytes = 256 << 20
	if len(encodedContent) > base64.StdEncoding.EncodedLen(maxRecordingBytes) {
		return nil, fmt.Errorf("录制文件超过 256 MiB 限制")
	}
	content, err := base64.StdEncoding.DecodeString(encodedContent)
	if err != nil {
		return nil, fmt.Errorf("解码录制文件失败：%w", err)
	}
	if len(content) == 0 || len(content) > maxRecordingBytes {
		return nil, fmt.Errorf("录制文件为空或超过 256 MiB 限制")
	}

	app := application.Get()
	if app == nil || app.Dialog == nil {
		return nil, fmt.Errorf("当前环境不支持系统文件对话框")
	}
	name := filepath.Base(strings.TrimSpace(suggestedName))
	if name == "." || name == "" {
		name = "dtv-recording.webm"
	}
	extension := strings.ToLower(filepath.Ext(name))
	if extension != ".webm" && extension != ".mp4" && extension != ".gif" {
		return nil, fmt.Errorf("不支持的录制文件类型")
	}
	if err := os.MkdirAll(appdirs.RecordingsDir(), 0o755); err != nil {
		return nil, fmt.Errorf("创建录制目录失败：%w", err)
	}
	dialog := app.Dialog.SaveFile()
	dialog.SetOptions(&application.SaveFileDialogOptions{Title: "保存直播回溯"})
	path, err := dialog.
		SetMessage("选择直播录制文件的保存位置").
		SetDirectory(appdirs.RecordingsDir()).
		SetFilename(name).
		AddFilter("MP4 视频", "*.mp4").
		AddFilter("WebM 视频", "*.webm").
		AddFilter("GIF 动图", "*.gif").
		CanCreateDirectories(true).
		AllowsOtherFileTypes(true).
		PromptForSingleSelection()
	if err != nil {
		return nil, fmt.Errorf("打开录制保存对话框失败：%w", err)
	}
	if strings.TrimSpace(path) == "" {
		return nil, nil
	}
	selectedExtension := strings.ToLower(filepath.Ext(path))
	if selectedExtension == "" {
		path += extension
	} else if selectedExtension != extension {
		return nil, fmt.Errorf("所选扩展名与录制文件内容不一致")
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		return nil, fmt.Errorf("写入录制文件失败：%w", err)
	}
	return &DataTransferFile{Name: filepath.Base(path), Path: path}, nil
}

// SaveRecordingToHighlights 把回溯精彩导出直接写入「精彩片段保存位置」，
// 不弹保存对话框（弹窗里已有明确的保存目录）。同名时自动加序号。
func (s *DataTransferService) SaveRecordingToHighlights(encodedContent string, suggestedName string) (*DataTransferFile, error) {
	const maxRecordingBytes = 256 << 20
	if len(encodedContent) > base64.StdEncoding.EncodedLen(maxRecordingBytes) {
		return nil, fmt.Errorf("录制文件超过 256 MiB 限制")
	}
	content, err := base64.StdEncoding.DecodeString(encodedContent)
	if err != nil {
		return nil, fmt.Errorf("解码录制文件失败：%w", err)
	}
	if len(content) == 0 || len(content) > maxRecordingBytes {
		return nil, fmt.Errorf("录制文件为空或超过 256 MiB 限制")
	}
	name := filepath.Base(strings.TrimSpace(suggestedName))
	if name == "." || name == "" {
		name = "dtv-highlight.mp4"
	}
	extension := strings.ToLower(filepath.Ext(name))
	if extension != ".webm" && extension != ".mp4" && extension != ".gif" {
		return nil, fmt.Errorf("不支持的录制文件类型")
	}
	dir := appdirs.RecordingsDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("创建精彩片段目录失败：%w", err)
	}
	path := filepath.Join(dir, name)
	stem := strings.TrimSuffix(name, filepath.Ext(name))
	for index := 1; ; index++ {
		if _, statErr := os.Stat(path); os.IsNotExist(statErr) {
			break
		}
		path = filepath.Join(dir, fmt.Sprintf("%s-%d%s", stem, index, extension))
		if index > 999 {
			return nil, fmt.Errorf("精彩片段目录同名文件过多")
		}
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		return nil, fmt.Errorf("写入精彩片段失败：%w", err)
	}
	return &DataTransferFile{Name: filepath.Base(path), Path: path}, nil
}

// CopyFileToClipboard 把导出的文件放进系统剪贴板（可直接粘贴到资源管理器）。
//
// 只允许操作精彩片段目录内的文件。Windows 用 PowerShell 的
// Set-Clipboard -Path（CF_HDROP）；其他平台返回错误，前端回退为复制路径文本。
func (s *DataTransferService) CopyFileToClipboard(path string) error {
	cleaned := filepath.Clean(strings.TrimSpace(path))
	if cleaned == "" || cleaned == "." {
		return fmt.Errorf("文件路径为空")
	}
	rel, err := filepath.Rel(appdirs.RecordingsDir(), cleaned)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return fmt.Errorf("只能复制精彩片段目录内的文件")
	}
	if info, statErr := os.Stat(cleaned); statErr != nil || info.IsDir() {
		return fmt.Errorf("文件不存在")
	}
	if runtime.GOOS != "windows" {
		return fmt.Errorf("当前平台暂不支持复制文件，请改用复制路径")
	}
	script := fmt.Sprintf("Set-Clipboard -Path '%s'", strings.ReplaceAll(cleaned, "'", "''"))
	cmd := exec.Command("powershell", "-NoProfile", "-STA", "-Command", script)
	if output, runErr := cmd.CombinedOutput(); runErr != nil {
		return fmt.Errorf("复制文件失败：%s", strings.TrimSpace(string(output)))
	}
	return nil
}
