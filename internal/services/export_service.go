package services

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// 本地回环导出服务：前端把录制 Blob 以 HTTP POST 流式上传，Go 侧边读边写盘。
//
// 取代旧的 base64 IPC：旧方案要在 JS 里拿到完整 ArrayBuffer、拼出 1.33 倍的
// base64 字符串、再经 Wails JSON 解码回完整 []byte，大文件会同时占三份内存。
// 这里只传一个一次性 token 和小小的会话信息，文件字节不经过 IPC。
//
// 安全边界：
//   - 只监听 127.0.0.1 的随机端口；
//   - token 由 crypto/rand 生成、单次有效、10 分钟过期；
//   - 写入目标目录的临时文件，写满再做原子 rename；
//   - 强制 256MiB 上限（同时看 Content-Length 和实际读取字节数）。

const exportTokenTTL = 10 * time.Minute

// 用变量而非常量，便于单测把上限调小，不必真的生成 256MiB 数据。
var exportMaxBytes int64 = 256 << 20

// ExportSession 是后端返回给前端的上传会话。URL 已带上一次性 token。
type ExportSession struct {
	Token string `json:"token"`
	URL   string `json:"url"`
	Path  string `json:"path"`
	Name  string `json:"name"`
}

type exportSessionState struct {
	mu        sync.Mutex
	path      string
	tempPath  string
	createdAt time.Time
}

// ExportService 管理 loopback HTTP server 与一次性上传会话。
type ExportService struct {
	mu       sync.Mutex
	server   *http.Server
	baseURL  string
	sessions map[string]*exportSessionState
}

// NewExportService 创建导出服务；HTTP server 在第一次创建会话时懒启动。
func NewExportService() *ExportService {
	return &ExportService{sessions: make(map[string]*exportSessionState)}
}

func (s *ExportService) ensureServer() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.baseURL != "" {
		return s.baseURL, nil
	}

	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("启动本地导出服务失败：%w", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/upload", s.handleUpload)
	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	s.server = server
	s.baseURL = "http://" + listener.Addr().String()
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			slog.Warn("本地导出服务退出", "error", err)
		}
	}()
	return s.baseURL, nil
}

// CreateSession 为已经确定好落盘路径的文件创建一个一次性上传会话。
func (s *ExportService) CreateSession(path string) (*ExportSession, error) {
	if filepath.Clean(path) == "" || path == "." {
		return nil, fmt.Errorf("导出路径为空")
	}
	base, err := s.ensureServer()
	if err != nil {
		return nil, err
	}

	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return nil, fmt.Errorf("生成导出令牌失败：%w", err)
	}
	token := hex.EncodeToString(tokenBytes)

	s.mu.Lock()
	s.pruneExpiredLocked()
	s.sessions[token] = &exportSessionState{path: path, createdAt: time.Now()}
	s.mu.Unlock()

	return &ExportSession{
		Token: token,
		URL:   base + "/upload?token=" + url.QueryEscape(token),
		Path:  path,
		Name:  filepath.Base(path),
	}, nil
}

// Cancel 丢弃一个未使用（或已失败）的会话并清理其临时文件。
// 上传进行中时会等待 handler 释放会话锁，避免一边写一边删。
func (s *ExportService) Cancel(token string) error {
	s.mu.Lock()
	state := s.sessions[token]
	delete(s.sessions, token)
	s.mu.Unlock()
	if state == nil {
		return nil
	}

	state.mu.Lock()
	defer state.mu.Unlock()
	if state.tempPath != "" {
		_ = os.Remove(state.tempPath)
		state.tempPath = ""
	}
	return nil
}

// Close 停止 HTTP server 并清理所有未完成的临时文件（应用退出时调用）。
func (s *ExportService) Close() error {
	s.mu.Lock()
	states := make([]*exportSessionState, 0, len(s.sessions))
	for token, state := range s.sessions {
		states = append(states, state)
		delete(s.sessions, token)
	}
	server := s.server
	s.server = nil
	s.baseURL = ""
	s.mu.Unlock()

	for _, state := range states {
		state.mu.Lock()
		if state.tempPath != "" {
			_ = os.Remove(state.tempPath)
			state.tempPath = ""
		}
		state.mu.Unlock()
	}
	if server != nil {
		return server.Close()
	}
	return nil
}

func (s *ExportService) pruneExpiredLocked() {
	for token, state := range s.sessions {
		if time.Since(state.createdAt) > exportTokenTTL {
			delete(s.sessions, token)
		}
	}
}

func setExportCORS(w http.ResponseWriter) {
	// WebView 页面与 loopback 不同源，必须放行 CORS；认证靠 URL 里的随机 token，
	// 不使用 cookie / Authorization，因此 "*" 不会带来凭据泄露。
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func (s *ExportService) handleUpload(w http.ResponseWriter, r *http.Request) {
	setExportCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST", http.StatusMethodNotAllowed)
		return
	}

	token := r.URL.Query().Get("token")
	s.mu.Lock()
	state := s.sessions[token]
	// 单次有效：不管上传成功与否，取出来就从会话表里移除。
	delete(s.sessions, token)
	s.mu.Unlock()
	if state == nil || time.Since(state.createdAt) > exportTokenTTL {
		http.Error(w, "导出会话无效或已过期", http.StatusGone)
		return
	}

	state.mu.Lock()
	defer state.mu.Unlock()

	if r.ContentLength > exportMaxBytes {
		http.Error(w, "录制文件超过 256 MiB 限制", http.StatusRequestEntityTooLarge)
		return
	}

	dir := filepath.Dir(state.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		http.Error(w, "创建导出目录失败", http.StatusInternalServerError)
		return
	}
	tmp, err := os.CreateTemp(dir, ".dtv-export-*")
	if err != nil {
		http.Error(w, "创建临时文件失败", http.StatusInternalServerError)
		return
	}
	state.tempPath = tmp.Name()
	removeTemp := func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		state.tempPath = ""
	}

	// LimitReader 同时兜住 chunked 请求（没有 Content-Length 的情况）。
	written, err := io.Copy(tmp, io.LimitReader(r.Body, exportMaxBytes+1))
	if err != nil {
		removeTemp()
		http.Error(w, "写入录制文件失败", http.StatusInternalServerError)
		return
	}
	if written > exportMaxBytes {
		removeTemp()
		http.Error(w, "录制文件超过 256 MiB 限制", http.StatusRequestEntityTooLarge)
		return
	}
	if written == 0 {
		removeTemp()
		http.Error(w, "录制文件为空", http.StatusBadRequest)
		return
	}
	if err := tmp.Close(); err != nil {
		removeTemp()
		http.Error(w, "关闭临时文件失败", http.StatusInternalServerError)
		return
	}
	state.tempPath = ""

	// Windows 上 os.Rename 不会覆盖已存在的目标文件。先把旧文件挪到备份名，
	// 新文件就位成功再删除备份；中途失败则把备份还原，不丢用户原有文件。
	backup := ""
	if _, statErr := os.Stat(state.path); statErr == nil {
		backup = fmt.Sprintf("%s.dtv-backup-%d", state.path, time.Now().UnixNano())
		if err := os.Rename(state.path, backup); err != nil {
			_ = os.Remove(tmp.Name())
			http.Error(w, "覆盖已有文件失败", http.StatusInternalServerError)
			return
		}
	}
	if err := os.Rename(tmp.Name(), state.path); err != nil {
		if backup != "" {
			_ = os.Rename(backup, state.path)
		}
		_ = os.Remove(tmp.Name())
		http.Error(w, "保存录制文件失败", http.StatusInternalServerError)
		return
	}
	if backup != "" {
		_ = os.Remove(backup)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]any{
		"path":  state.path,
		"bytes": written,
	}); err != nil {
		slog.Warn("写入导出响应失败", "error", err)
	}
}
