package bilibili

import (
	"strings"
	"testing"
)

// todo02：轮播（live_status==2）也要能播，IsLive 语义为"可播放"。
func TestBilibiliLiveStatusPlayableIncludesLoop(t *testing.T) {
	cases := []struct {
		status int64
		want   bool
	}{
		{0, false},
		{1, true},
		{2, true},
		{3, false},
	}
	for _, c := range cases {
		if got := bilibiliLiveStatus(c.status); got != c.want {
			t.Errorf("bilibiliLiveStatus(%d) = %v, want %v", c.status, got, c.want)
		}
	}
}

// 轮播房 v2 playurl_info 为 null，必须能从 v1 playUrl 响应解析出可播 HLS 地址。
// 样例取自房间 5148 的真实响应（截短了签名参数）。
func TestParsePlayURLV1LoopRoom(t *testing.T) {
	body := []byte(`{"code":0,"message":"OK","ttl":1,"data":{"current_qn":10000,` +
		`"quality_description":[{"qn":10000,"desc":"原画"}],` +
		`"durl":[{"url":"http://d1--cn-gotcha104.bilivideo.com/live-bvc/112220/live_x.m3u8?expires=1&qn=10000","order":1},` +
		`{"url":"https://d1--cn-gotcha104b.bilivideo.com/live-bvc/112220/live_x.m3u8?expires=1&qn=10000","order":2},` +
		`{"url":"","order":3}],"is_dash_auto":false}}`)

	var resp playURLV1Response
	if err := unmarshalJSON(body, &resp); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	info, err := resp.toStreamPlayInfo()
	if err != nil {
		t.Fatalf("toStreamPlayInfo 失败: %v", err)
	}

	if info.CurrentQN != qnOrigin {
		t.Errorf("CurrentQN = %d, want %d", info.CurrentQN, qnOrigin)
	}
	if len(info.AcceptQN) != 1 || info.AcceptQN[0] != qnOrigin {
		t.Errorf("AcceptQN = %v, want [%d]", info.AcceptQN, qnOrigin)
	}
	if info.QNDesc[qnOrigin] != "原画" {
		t.Errorf("QNDesc[10000] = %q, want 原画", info.QNDesc[qnOrigin])
	}
	if len(info.PlayURLs) != 2 {
		t.Fatalf("PlayURLs 数量 = %d, want 2（空 url 应被跳过）", len(info.PlayURLs))
	}
	for _, u := range info.PlayURLs {
		if !strings.HasPrefix(u.URL, "https://") {
			t.Errorf("URL 未升级 https: %s", u.URL)
		}
		if !isHLS(u) {
			t.Errorf("地址应识别为 HLS: %+v", u)
		}
	}

	best, ok := pickPlayable(info.PlayURLs)
	if !ok || best.URL == "" {
		t.Fatalf("pickPlayable 应能选出轮播地址")
	}
}

// v1 业务错误要转成 apiError，而不是当成"没有地址"。
func TestParsePlayURLV1APIError(t *testing.T) {
	resp := playURLV1Response{Code: -400, Msg: "请求错误"}
	if _, err := resp.toStreamPlayInfo(); err == nil {
		t.Fatal("code != 0 应返回错误")
	}
}

// 轮播房实际走点播链路：getRoundPlayVideo 必须能解析出当前稿件与进度。
// 样例取自房间 5148 的真实响应（截掉了签名字段）。
func TestParseRoundPlayVideo(t *testing.T) {
	body := []byte(`{"code":0,"message":"0","ttl":1,"data":{"cid":36921806708,` +
		`"bvid":"BV1x5QfBzEKN","play_time":2995,"sequence":1,"aid":116279679782542,` +
		`"title":"某轮播稿件","pid":1}}`)

	var resp roundPlayResponse
	if err := unmarshalJSON(body, &resp); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	video, err := resp.toRoundPlayVideo()
	if err != nil {
		t.Fatalf("toRoundPlayVideo 失败: %v", err)
	}
	if video.BVID != "BV1x5QfBzEKN" || video.CID != 36921806708 {
		t.Errorf("稿件标识错误: %+v", video)
	}
	if video.PlayTime != 2995 {
		t.Errorf("PlayTime = %d, want 2995", video.PlayTime)
	}
}

// 没在轮播 / 稿件为空时要报错，而不是给出空地址。
func TestParseRoundPlayVideoInvalid(t *testing.T) {
	for _, body := range []string{
		`{"code":-400,"message":"请求错误"}`,
		`{"code":0,"data":{"cid":0,"bvid":"","play_time":0}}`,
	} {
		var resp roundPlayResponse
		if err := unmarshalJSON([]byte(body), &resp); err != nil {
			t.Fatalf("解析失败: %v", err)
		}
		if _, err := resp.toRoundPlayVideo(); err == nil {
			t.Errorf("应返回错误: %s", body)
		}
	}
}

// 主站 playurl（html5）响应要能提取主/备 MP4 地址并升级 https。
func TestParseVODPlayURL(t *testing.T) {
	body := []byte(`{"code":0,"message":"OK","ttl":1,"data":{"quality":64,` +
		`"format":"mp4720","timelength":7211311,` +
		`"durl":[{"url":"http://upos-sz-estgcos.bilivideo.com/upgcxcode/08/67/36921806708/x-1-16.mp4?e=1",` +
		`"backup_url":["https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/08/67/36921806708/x-1-16.mp4?e=1"]}]}}`)

	var resp vodPlayURLResponse
	if err := unmarshalJSON(body, &resp); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	urls, err := resp.vodPlayURLs()
	if err != nil {
		t.Fatalf("vodPlayURLs 失败: %v", err)
	}
	if len(urls) != 2 {
		t.Fatalf("地址数量 = %d, want 2", len(urls))
	}
	for _, u := range urls {
		if !strings.HasPrefix(u, "https://") {
			t.Errorf("URL 未升级 https: %s", u)
		}
	}
	if variantFormat(urls[0]) != "mp4" {
		t.Errorf("variantFormat 应识别为 mp4: %s", urls[0])
	}
}

// 风控返回 HTML 错误页时必须报错（不能当成"没有地址"静默吞掉）。
func TestParseVODPlayURLRiskControlHTML(t *testing.T) {
	body := []byte(`<!DOCTYPE html><html lang="zh-cn"><head></head><body></body></html>`)
	var resp vodPlayURLResponse
	if err := unmarshalJSON(body, &resp); err == nil {
		t.Fatal("HTML 应解析失败")
	}
}

// 轮播档位：mp4 格式 + #t= 进度（原生 <video> 靠它 seek 到当前播放点）。
func TestLoopVariantMediaFragment(t *testing.T) {
	video := &roundPlayVideo{BVID: "BV1x5QfBzEKN", CID: 36921806708, PlayTime: 2995}
	urls := []string{"https://upos-sz-estgcos.bilivideo.com/x-1-16.mp4?e=1"}
	variant := loopVariant(video, urls)

	if variant.Format != "mp4" || variant.ID != "loop" {
		t.Errorf("档位格式/ID 错误: %+v", variant)
	}
	if !strings.HasSuffix(variant.URL, "#t=2995") {
		t.Errorf("URL 应带 #t=2995 进度: %s", variant.URL)
	}

	video.PlayTime = 0
	if got := loopVariant(video, urls).URL; strings.Contains(got, "#t=") {
		t.Errorf("进度为 0 时不应加 fragment: %s", got)
	}
}

// 主站风控 Cookie：b_nut 必须在 buvid3 之前（顺序反了会被拦成 HTML 页）。
func TestVODCookieOrder(t *testing.T) {
	cookie := vodCookie("ABC123infoc")
	nutIdx := strings.Index(cookie, "b_nut=")
	buvidIdx := strings.Index(cookie, "buvid3=ABC123infoc")
	if nutIdx < 0 || buvidIdx < 0 || nutIdx > buvidIdx {
		t.Errorf("Cookie 顺序错误: %s", cookie)
	}
}