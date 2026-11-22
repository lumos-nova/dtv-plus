package bilibili

import (
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"dtv/internal/platforms/common"
)

// round_play.go 负责轮播房（live_status==2）的取流。
//
// 实测结论（2026-11-24，房间 5148）：
//   - 轮播房在 v2 getRoomPlayInfo 里 playurl_info 恒为 null；v1 playUrl 虽然
//     还下发地址，但那些是"冷流"URL：分配的 CDN 节点要么挂起不回包，要么
//     302 到 smtcdns 后 404（TxLiveCode=cold_stream），换节点/换参数都救不活。
//   - 官方网页播放器对轮播房走的是**点播**链路：
//     live/getRoundPlayVideo 拿到当前轮到的稿件（bvid/cid）和已播秒数
//     play_time，再用主站 x/player/playurl（platform=html5&high_quality=1&
//     fnval=1）取整段渐进式 MP4，seek 到 play_time 播放。
//   - x/player/playurl 有风控：Cookie 必须是 "b_nut=<unix>; buvid3=<真实值>"
//     且 **b_nut 在前**（buvid3 在前或占位值 buvid3=i 都返回 HTML 错误页）。
//     buvid3 用 finger/spi 下发的值即可，不需要访问主站首页种 Cookie。
//   - 匿名 html5 链路最高 720P（qn=64）；upos CDN 支持 Range 且
//     Access-Control-Allow-Origin: *，前端 <video> 可直连。

// fetchRoundPlayVideo 查询房间当前轮播到的稿件。
func (c *Client) fetchRoundPlayVideo(roomID string) (*roundPlayVideo, error) {
	params := "room_id=" + queryEscape(roomID) + "&type=flv"
	body, err := c.getRaw(buildURL(urlRoundPlayVideo, params))
	if err != nil {
		return nil, describe("getRoundPlayVideo 请求失败", err)
	}
	var resp roundPlayResponse
	if err := unmarshalJSON(body, &resp); err != nil {
		return nil, describe("getRoundPlayVideo 解析失败", err)
	}
	return resp.toRoundPlayVideo()
}

// roundPlayResponse 是 live/getRoundPlayVideo 的响应模型。
type roundPlayResponse struct {
	Code    int64  `json:"code"`
	Message string `json:"message"`
	Data    struct {
		BVID     string `json:"bvid"`
		CID      any    `json:"cid"`
		PlayTime any    `json:"play_time"`
		Title    string `json:"title"`
	} `json:"data"`
}

// roundPlayVideo 是解析后的"当前轮播稿件"。
type roundPlayVideo struct {
	BVID     string
	CID      int64
	PlayTime int64 // 该稿件已播秒数（播放器需要 seek 到这里）
	Title    string
}

func (resp *roundPlayResponse) toRoundPlayVideo() (*roundPlayVideo, error) {
	if resp.Code != 0 {
		return nil, &apiError{Code: resp.Code, Message: resp.Message, Endpoint: "getRoundPlayVideo"}
	}
	out := &roundPlayVideo{
		BVID:     resp.Data.BVID,
		CID:      jsonInt(resp.Data.CID),
		PlayTime: jsonInt(resp.Data.PlayTime),
		Title:    resp.Data.Title,
	}
	if out.BVID == "" || out.CID <= 0 {
		return nil, fmt.Errorf("getRoundPlayVideo 未返回稿件（bvid/cid 为空）")
	}
	if out.PlayTime < 0 {
		out.PlayTime = 0
	}
	return out, nil
}

// vodPlayURLResponse 是主站 x/player/playurl（html5 渐进式 MP4）的响应模型。
type vodPlayURLResponse struct {
	Code    int64  `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Quality     any      `json:"quality"`
		TimeLength  any      `json:"timelength"` // 毫秒
		AcceptDesc  []string `json:"accept_description"`
		DURL        []struct {
			URL    string   `json:"url"`
			Backup []string `json:"backup_url"`
		} `json:"durl"`
	} `json:"data"`
}

// vodPlayURLs 提取主地址 + 备用地址（全部升级 https）。
func (resp *vodPlayURLResponse) vodPlayURLs() ([]string, error) {
	if resp.Code != 0 {
		return nil, &apiError{Code: resp.Code, Message: resp.Message, Endpoint: "player/playurl"}
	}
	var urls []string
	for _, d := range resp.Data.DURL {
		for _, raw := range append([]string{d.URL}, d.Backup...) {
			if raw != "" {
				urls = append(urls, enforceHTTPS(raw))
			}
		}
	}
	if len(urls) == 0 {
		return nil, fmt.Errorf("player/playurl 未返回播放地址")
	}
	return urls, nil
}

// vodCookie 拼主站接口的风控 Cookie。
//
// 顺序敏感：b_nut 必须在 buvid3 之前（实测反过来会被风控拦成 HTML 页）。
func vodCookie(buvid string) string {
	return "b_nut=" + strconv.FormatInt(time.Now().Unix(), 10) + "; buvid3=" + buvid
}

// fetchVODPlayURL 用主站接口取轮播稿件的渐进式 MP4 地址。
func (c *Client) fetchVODPlayURL(video *roundPlayVideo) ([]string, error) {
	buvid := c.Cookie()
	if idx := strings.Index(buvid, "buvid3="); idx >= 0 {
		rest := buvid[idx+len("buvid3="):]
		if end := strings.IndexByte(rest, ';'); end >= 0 {
			rest = rest[:end]
		}
		buvid = strings.TrimSpace(rest)
	} else {
		buvid = ""
	}
	if buvid == "" || buvid == "i" {
		buvid = c.buvidValue()
	}
	if buvid == "" {
		return nil, fmt.Errorf("获取 buvid3 失败，无法请求轮播稿件地址")
	}

	params := "cid=" + strconv.FormatInt(video.CID, 10) +
		"&bvid=" + queryEscape(video.BVID) +
		"&qn=64&fnval=1&fourk=1&platform=html5&high_quality=1"
	target := buildURL(urlVODPlayURL, params)

	resp, err := c.http.Get(target, map[string]string{
		"User-Agent": desktopUA,
		"Referer":    "https://www.bilibili.com/video/" + video.BVID,
		"Cookie":     vodCookie(buvid),
	})
	if err != nil {
		return nil, describe("player/playurl 请求失败", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 12<<20))
	if err != nil {
		return nil, describe("player/playurl 读取失败", err)
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("player/playurl HTTP %d", resp.StatusCode)
	}

	var parsed vodPlayURLResponse
	if err := unmarshalJSON(body, &parsed); err != nil {
		// 风控拦截时返回的是 HTML 错误页而不是 JSON
		return nil, fmt.Errorf("player/playurl 返回异常内容（疑似风控）: %w", err)
	}
	return parsed.vodPlayURLs()
}

// loopVariant 组装轮播房的唯一档位（渐进式 MP4，seek 到当前播放进度）。
func loopVariant(video *roundPlayVideo, urls []string) common.StreamVariant {
	label := "轮播 720P"
	url := urls[0]
	if video.PlayTime > 0 {
		// Media Fragments：原生 <video> 会自动 seek 到该秒数
		url += "#t=" + strconv.FormatInt(video.PlayTime, 10)
	}
	return common.StreamVariant{
		ID:     "loop",
		Label:  label,
		URL:    url,
		Format: "mp4",
		URLs:   urls,
	}
}

// resolveLoopVariant 走点播链路解析轮播房地址；失败返回 nil（由调用方回退）。
func (c *Client) resolveLoopVariant(roomID string) *common.StreamVariant {
	video, err := c.fetchRoundPlayVideo(roomID)
	if err != nil {
		debugLog("轮播稿件查询失败: %v", err)
		return nil
	}
	urls, err := c.fetchVODPlayURL(video)
	if err != nil {
		debugLog("轮播稿件取流失败: %v", err)
		return nil
	}
	variant := loopVariant(video, urls)
	return &variant
}