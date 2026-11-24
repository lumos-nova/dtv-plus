package douyin

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"dtv/internal/platforms/common"
)

// newTestClient 构造一个把所有出站请求重定向到本地 TLS 测试服务器的客户端。
// 不跑 warmup，避免测试期间访问真实网络。
func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewTLSServer(handler)
	t.Cleanup(srv.Close)
	addr := srv.Listener.Addr().String()

	c := &Client{http: common.NewHttpClient(), rooms: make(map[string]*roomCacheEntry)}
	c.http.SetDialContext(func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, addr)
	})
	c.http.SetTLSClientConfig(&tls.Config{InsecureSkipVerify: true})
	return c
}

func TestHtmlBlocked(t *testing.T) {
	if !htmlBlocked(`<html>verify_data={"a":1}</html>`) {
		t.Fatal("verify_data 页面应判定为拦截")
	}
	if !htmlBlocked(`<title>验证码中间页</title>`) {
		t.Fatal("验证码中间页应判定为拦截")
	}
	if htmlBlocked(`<html>正常房间页</html>`) {
		t.Fatal("正常页面不应判定为拦截")
	}
}

func TestIsBlockedError(t *testing.T) {
	if !isBlockedError(common.Fatal("本次请求受到服务器拦截，请稍后再试")) {
		t.Fatal("拦截错误应被识别")
	}
	if isBlockedError(common.Fatal("房间不存在")) {
		t.Fatal("非拦截错误不应被识别")
	}
	if isBlockedError(nil) {
		t.Fatal("nil 不应被识别")
	}
}

func TestGuardedRoomPageRetriesTransientBlock(t *testing.T) {
	var hits int32
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&hits, 1) == 1 {
			_, _ = w.Write([]byte(`<html>verify_data={}</html>`))
			return
		}
		_, _ = w.Write([]byte(`<html>ok</html>`))
	})

	html, err := c.guardedRoomPage("123")
	if err != nil {
		t.Fatalf("瞬时拦截应重试成功: %v", err)
	}
	if !strings.Contains(html, "ok") {
		t.Fatalf("应拿到第二次请求的页面, got %q", html)
	}
	if c.coolingDown() {
		t.Fatal("重试成功后不应进入冷却")
	}
}

func TestGuardedRoomPageCooldownAfterPersistentBlock(t *testing.T) {
	var hits int32
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		_, _ = w.Write([]byte(`<html>verify_data={}</html>`))
	})

	_, err := c.guardedRoomPage("123")
	if err == nil || !strings.Contains(err.Error(), "服务器拦截") {
		t.Fatalf("持续拦截应返回拦截错误, got %v", err)
	}
	if !c.coolingDown() {
		t.Fatal("持续拦截后应进入冷却")
	}

	// 冷却期内不应再发请求
	before := atomic.LoadInt32(&hits)
	_, err = c.guardedRoomPage("123")
	if err == nil || !strings.Contains(err.Error(), "服务器拦截") {
		t.Fatalf("冷却期应直接返回拦截错误, got %v", err)
	}
	if atomic.LoadInt32(&hits) != before {
		t.Fatal("冷却期内不应再打房间页")
	}
}

func TestResolveRoomCachedDedupsAndFallsBackToStale(t *testing.T) {
	bundle := &roomBundle{WebRID: "123", InternalID: "7711540398426032930"}
	c := &Client{rooms: make(map[string]*roomCacheEntry)}

	// 预置一份新鲜缓存：TTL 内直接命中，不发任何请求
	c.rooms["123"] = &roomCacheEntry{done: true, at: time.Now(), bundle: bundle}
	got, err := c.resolveRoomCached("123")
	if err != nil || got != bundle {
		t.Fatalf("TTL 内应命中缓存: %v %v", got, err)
	}

	// 缓存过期 + 风控冷却中：应回退过期缓存而不是报错
	c.rooms["123"].at = time.Now().Add(-2 * roomCacheTTL)
	c.noteBlocked()
	got, err = c.resolveRoomCached("123")
	if err != nil || got != bundle {
		t.Fatalf("风控冷却期应回退过期缓存: %v %v", got, err)
	}

	// 无缓存 + 冷却中：返回拦截错误
	_, err = c.resolveRoomCached("456")
	if err == nil || !strings.Contains(err.Error(), "服务器拦截") {
		t.Fatalf("无缓存且冷却中应返回拦截错误, got %v", err)
	}
}

func TestResolveRoomCachedSingleFlight(t *testing.T) {
	var pageHits, reflowHits int32
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.Host, "amemv") || strings.Contains(r.URL.Path, "reflow") {
			atomic.AddInt32(&reflowHits, 1)
			_, _ = w.Write([]byte(`{"status_code":0,"data":{"room":{"id_str":"7711540398426032930","status":2}}}`))
			return
		}
		atomic.AddInt32(&pageHits, 1)
		time.Sleep(80 * time.Millisecond)
		_, _ = w.Write([]byte(`<html>\"roomId\":\"7711540398426032930\"</html>`))
	})

	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = c.resolveRoomCached("123")
		}()
	}
	wg.Wait()

	if n := atomic.LoadInt32(&pageHits); n != 1 {
		t.Fatalf("5 个并发请求应合并为 1 次房间页请求, 实际 %d 次", n)
	}
	if n := atomic.LoadInt32(&reflowHits); n != 1 {
		t.Fatalf("reflow 也应只请求 1 次, 实际 %d 次", n)
	}
}