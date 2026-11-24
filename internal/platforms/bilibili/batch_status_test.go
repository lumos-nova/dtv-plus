package bilibili

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// newBatchTestClient 把所有出站请求重定向到本地 TLS 测试服务器。
func newBatchTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewTLSServer(handler)
	t.Cleanup(srv.Close)
	addr := srv.Listener.Addr().String()

	c := NewClient()
	c.http.SetDialContext(func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, addr)
	})
	c.http.SetTLSClientConfig(&tls.Config{InsecureSkipVerify: true})
	return c
}

func TestStatusByUIDsParsesBatch(t *testing.T) {
	var gotForm string
	c := newBatchTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("应为 POST, got %s", r.Method)
		}
		_ = r.ParseForm()
		gotForm = r.PostForm.Encode()
		_, _ = w.Write([]byte(`{"code":0,"data":{
			"5148":{"uid":5148,"room_id":22603245,"short_id":5148,"title":"轮播中","live_status":2,"area_v2_name":"网游","live_time":1700000000},
			"6":{"uid":6,"room_id":77,"short_id":0,"title":"直播中","live_status":1},
			"7":{"uid":7,"room_id":88,"short_id":0,"title":"","live_status":0}
		}}`))
	})

	out, err := c.StatusByUIDs([]string{"5148", "6", "7", "404"})
	if err != nil {
		t.Fatalf("批量状态应成功: %v", err)
	}
	if !strings.Contains(gotForm, "uids%5B%5D=5148") || !strings.Contains(gotForm, "uids%5B%5D=404") {
		t.Fatalf("表单应包含全部 uids[]: %s", gotForm)
	}
	if len(out) != 3 {
		t.Fatalf("缺失 UID 不应出现在结果里, got %d", len(out))
	}
	loop := out["5148"]
	if !loop.IsLive() || !loop.IsLoop() || loop.RoomID != "22603245" || loop.Title != "轮播中" {
		t.Fatalf("轮播房解析错误: %+v", loop)
	}
	live := out["6"]
	if !live.IsLive() || live.IsLoop() {
		t.Fatalf("直播房解析错误: %+v", live)
	}
	offline := out["7"]
	if offline.IsLive() {
		t.Fatalf("下播房不应 IsLive: %+v", offline)
	}
}

func TestStatusByUIDsChunksLargeList(t *testing.T) {
	calls := 0
	c := newBatchTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		_ = r.ParseForm()
		if n := len(r.PostForm["uids[]"]); n > batchStatusChunk {
			t.Errorf("单批 UID 数超限: %d", n)
		}
		_, _ = w.Write([]byte(`{"code":0,"data":{}}`))
	})

	uids := make([]string, batchStatusChunk+1)
	for i := range uids {
		uids[i] = "1"
	}
	if _, err := c.StatusByUIDs(uids); err != nil {
		t.Fatalf("分批请求应成功: %v", err)
	}
	if calls != 2 {
		t.Fatalf("201 个 UID 应分 2 批, got %d", calls)
	}
}

func TestStatusByUIDsAPIError(t *testing.T) {
	c := newBatchTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"code":-412,"msg":"request was banned"}`))
	})
	if _, err := c.StatusByUIDs([]string{"1"}); err == nil {
		t.Fatal("code!=0 应返回错误")
	}
}

func TestRoomUID(t *testing.T) {
	c := newBatchTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.RawQuery, "room_id=5148") {
			t.Errorf("应带 room_id 参数: %s", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"code":0,"data":{"uid":3985676}}`))
	})
	uid, err := c.RoomUID("https://live.bilibili.com/5148")
	if err != nil {
		t.Fatalf("RoomUID 应成功: %v", err)
	}
	if uid != "3985676" {
		t.Fatalf("UID 解析错误: %s", uid)
	}
}