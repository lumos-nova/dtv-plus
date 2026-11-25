package services

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExportServiceStreamUpload(t *testing.T) {
	svc := NewExportService()
	t.Cleanup(func() { _ = svc.Close() })

	// 目标目录不存在时也应能创建，并落在指定路径（含子目录）。
	target := filepath.Join(t.TempDir(), "nested", "recording.mp4")
	session, err := svc.CreateSession(target)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if !strings.HasPrefix(session.URL, "http://127.0.0.1:") {
		t.Fatalf("上传地址不是 loopback: %s", session.URL)
	}
	if session.Token == "" || !strings.Contains(session.URL, session.Token) {
		t.Fatalf("会话缺少一次性 token: %+v", session)
	}

	payload := []byte("fake mp4 payload for streaming upload")
	resp, err := http.Post(session.URL, "application/octet-stream", bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("上传状态码 = %d, body = %s", resp.StatusCode, body)
	}
	var result struct {
		Path  string `json:"path"`
		Bytes int64  `json:"bytes"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("解析上传响应: %v", err)
	}
	if result.Path != target || result.Bytes != int64(len(payload)) {
		t.Fatalf("上传响应与预期不符: %+v", result)
	}
	written, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("读取落盘文件: %v", err)
	}
	if !bytes.Equal(written, payload) {
		t.Fatalf("落盘内容不一致: got %q", written)
	}

	// token 单次有效：第二次上传必须被拒绝。
	resp, err = http.Post(session.URL, "application/octet-stream", bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("重复 POST: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("重复上传状态码 = %d, 期望 410", resp.StatusCode)
	}
}

func TestExportServiceRejectsOversize(t *testing.T) {
	original := exportMaxBytes
	exportMaxBytes = 8
	t.Cleanup(func() { exportMaxBytes = original })

	svc := NewExportService()
	t.Cleanup(func() { _ = svc.Close() })

	dir := t.TempDir()
	target := filepath.Join(dir, "too-big.mp4")
	session, err := svc.CreateSession(target)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	resp, err := http.Post(session.URL, "application/octet-stream", bytes.NewReader([]byte("123456789")))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("超限上传状态码 = %d, 期望 413", resp.StatusCode)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("超限上传不应留下目标文件: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("读取目录: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".dtv-export-") {
			t.Fatalf("超限上传残留临时文件: %s", entry.Name())
		}
	}
}

func TestExportServiceCancel(t *testing.T) {
	svc := NewExportService()
	t.Cleanup(func() { _ = svc.Close() })

	target := filepath.Join(t.TempDir(), "cancelled.mp4")
	session, err := svc.CreateSession(target)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := svc.Cancel(session.Token); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	resp, err := http.Post(session.URL, "application/octet-stream", bytes.NewReader([]byte("x")))
	if err != nil {
		t.Fatalf("POST after cancel: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("取消后的上传状态码 = %d, 期望 410", resp.StatusCode)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("取消后不应留下目标文件: %v", err)
	}
}
