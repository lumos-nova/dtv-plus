package douyin

import (
	"encoding/json"
	"fmt"

	"dtv/internal/platforms/common"
)

// 开播提醒引擎专用的轻量入口。
//
// 与 Streamer 的区别：Streamer 走 resolveRoomCached（页面 + reflow 两步，
// 带 30s 缓存），适合"点开一个房间"；提醒引擎要盯上百个房间，必须
// 把「web_rid → 内部 roomId」的映射持久化下来，平时只发 reflow 一步
// （实测匿名可用、单次 ~70KB），失效时才回源房间页重新解析映射。

// RoomStatus 是 reflow 接口返回的房间开播状态（不含取流地址）。
type RoomStatus struct {
	InternalID string
	Title      string
	Nickname   string
	Avatar     string
	Cover      string
	Viewers    int64
	IsLive     bool
}

// ResolveInternalID 解析 web_rid 对应的内部 roomId（只打开房间页，不发 reflow）。
// 房间页请求经过 guardedRoomPage 的冷却/重试保护，风控期间会返回
// 含「服务器拦截」的 FATAL 错误。
func (c *Client) ResolveInternalID(webRID string) (string, error) {
	normalized := NormalizeRoomID(webRID)
	if normalized == "" {
		return "", fmt.Errorf("房间号为空")
	}
	html, err := c.guardedRoomPage(normalized)
	if err != nil {
		return "", err
	}
	internalID := extractInternalRoomID(html)
	if internalID == "" {
		return "", common.Fatal("抖音房间 %s 页面里没有找到内部 roomId（房间可能不存在或页面结构变更）", normalized)
	}
	return internalID, nil
}

// StatusByInternalID 用内部 roomId 查开播状态（只发 reflow，不打开房间页）。
//
// 上游 status_code=10011 表示内部 roomId 已失效（主播重开后房间会换新 ID），
// 此时返回 ErrInternalIDStale，调用方应重新解析映射；
// 房间下播时 status_code=0 且 room.status=4，属于正常返回。
func (c *Client) StatusByInternalID(internalID string) (*RoomStatus, error) {
	params := [][2]string{
		{"type_id", reflowTypeID},
		{"live_id", paramLiveID},
		{"version_code", reflowVersionCode},
		{"app_id", reflowAppID},
		{"room_id", internalID},
		{"msToken", GenerateMsToken(107)},
	}
	headers := map[string]string{
		"User-Agent":      desktopUA,
		"Referer":         urlLiveHome,
		"Accept":          "application/json, text/plain, */*",
		"Accept-Language": "zh-CN,zh;q=0.9",
	}

	var resp reflowResponse
	if err := c.http.GetJSON(signedURL(urlReflow, params), headers, &resp); err != nil {
		return nil, err
	}
	if resp.StatusCode == reflowCodeInvalidRoom {
		return nil, ErrInternalIDStale
	}

	var data reflowData
	if len(resp.Data) > 0 {
		if err := json.Unmarshal(resp.Data, &data); err != nil {
			return nil, fmt.Errorf("解析抖音房间数据失败: %w", err)
		}
	}
	if data.Room == nil {
		return nil, fmt.Errorf("抖音房间数据为空（status_code=%d）", resp.StatusCode)
	}
	room := data.Room
	return &RoomStatus{
		InternalID: internalID,
		Title:      room.Title,
		Nickname:   room.Owner.Nickname,
		Avatar:     room.Owner.AvatarThumb.first(),
		Cover:      room.Cover.first(),
		Viewers:    viewersOf(room),
		IsLive:     isRoomLive(room),
	}, nil
}

// reflowCodeInvalidRoom 是 reflow 对无效内部 roomId 的返回码（实测 2026-11）。
const reflowCodeInvalidRoom = 10011

// ErrInternalIDStale 表示内部 roomId 已失效，需要重新解析映射。
var ErrInternalIDStale = fmt.Errorf("抖音内部 roomId 已失效（status_code=%d）", reflowCodeInvalidRoom)