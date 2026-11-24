package douyin

import (
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestStatusByInternalIDLive(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/webcast/room/reflow/info/") {
			t.Errorf("应只发 reflow 请求: %s", r.URL.Path)
		}
		if !strings.Contains(r.URL.RawQuery, "room_id=7702034233618877218") {
			t.Errorf("应带内部 roomId: %s", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"status_code":0,"data":{"room":{
			"id_str":"7702034233618877218","title":"标题","status":2,
			"owner":{"nickname":"主播","avatar_thumb":{"url_list":["https://a/x.jpg"]}},
			"room_view_stats":{"display_value":1234}
		}}}`))
	})

	st, err := c.StatusByInternalID("7702034233618877218")
	if err != nil {
		t.Fatalf("reflow 状态应成功: %v", err)
	}
	if !st.IsLive || st.Title != "标题" || st.Nickname != "主播" || st.Viewers != 1234 {
		t.Fatalf("状态解析错误: %+v", st)
	}
}

func TestStatusByInternalIDOfflineIsNotError(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		// 实测：主播下播后旧内部 ID 仍返回 status_code=0 + room.status=4
		_, _ = w.Write([]byte(`{"status_code":0,"data":{"room":{"id_str":"1","status":4,"title":"旧标题"}}}`))
	})
	st, err := c.StatusByInternalID("1")
	if err != nil {
		t.Fatalf("下播应是正常返回而非错误: %v", err)
	}
	if st.IsLive {
		t.Fatal("status=4 不应在播")
	}
}

func TestStatusByInternalIDStale(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status_code":10011}`))
	})
	_, err := c.StatusByInternalID("999")
	if !errors.Is(err, ErrInternalIDStale) {
		t.Fatalf("10011 应返回 ErrInternalIDStale, got %v", err)
	}
}

func TestResolveInternalID(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/123456") {
			t.Errorf("应打开房间页: %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`<html>{\"roomId\":\"7702034233618877218\"}</html>`))
	})
	id, err := c.ResolveInternalID("https://live.douyin.com/123456")
	if err != nil {
		t.Fatalf("解析内部 ID 应成功: %v", err)
	}
	if id != "7702034233618877218" {
		t.Fatalf("内部 ID 错误: %s", id)
	}
}