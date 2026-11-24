package bilibili

import (
	"fmt"
	"strings"
)

// 批量开播状态接口（开播提醒引擎专用）。
//
// get_status_info_by_uids 按主播 UID 一次查一批房间的开播状态：
// 匿名可用、无需 WBI 签名（2026-11 实测 500 个 UID 一次请求也正常返回，
// 耗时 <200ms）。关注上百个 B 站主播时，用它替代逐房间 getInfoByRoom，
// 一轮只发 1~2 个请求，5 秒级轮询也不会触碰风控。
const urlStatusByUIDs = "https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids"

// batchStatusChunk 单次请求的 UID 数。上游实测 500 也接受，取 200 保守值。
const batchStatusChunk = 200

// RoomStatus 是批量接口返回的单个房间状态。
type RoomStatus struct {
	UID        string
	RoomID     string // 真实 room_id
	ShortID    string // 短号（没有则为 "0"）
	Title      string
	AreaName   string
	LiveStatus int64 // 0=未开播 1=直播中 2=轮播
	LiveTime   int64 // 开播时间戳（秒）
}

// IsLive 与 Streamer 的语义一致：直播或轮播都算"可播"。
func (s RoomStatus) IsLive() bool { return s.LiveStatus == 1 || s.LiveStatus == 2 }

// IsLoop 报告是否轮播中。
func (s RoomStatus) IsLoop() bool { return s.LiveStatus == 2 }

// StatusByUIDs 按 UID 批量查开播状态。
//
// 返回 map 以 UID 字符串为键；不存在/已注销的 UID 不会出现在结果里。
// 超过 batchStatusChunk 个 UID 时自动分批串行请求。
func (c *Client) StatusByUIDs(uids []string) (map[string]RoomStatus, error) {
	out := make(map[string]RoomStatus, len(uids))
	for start := 0; start < len(uids); start += batchStatusChunk {
		end := start + batchStatusChunk
		if end > len(uids) {
			end = len(uids)
		}
		chunk := uids[start:end]
		form := "uids[]=" + strings.Join(chunk, "&uids[]=")

		var resp struct {
			Code int64  `json:"code"`
			Msg  string `json:"msg"`
			Data map[string]struct {
				UID        any    `json:"uid"`
				RoomID     any    `json:"room_id"`
				ShortID    any    `json:"short_id"`
				Title      string `json:"title"`
				AreaV2Name string `json:"area_v2_name"`
				LiveStatus any    `json:"live_status"`
				LiveTime   any    `json:"live_time"`
			} `json:"data"`
		}
		if err := c.http.PostFormJSON(urlStatusByUIDs, form, c.headers(), &resp); err != nil {
			return nil, describe("批量开播状态请求失败", err)
		}
		if resp.Code != 0 {
			return nil, &apiError{Code: resp.Code, Message: resp.Msg, Endpoint: "Room/get_status_info_by_uids"}
		}
		for uid, item := range resp.Data {
			out[uid] = RoomStatus{
				UID:        uid,
				RoomID:     jsonString(item.RoomID),
				ShortID:    jsonString(item.ShortID),
				Title:      item.Title,
				AreaName:   item.AreaV2Name,
				LiveStatus: jsonInt(item.LiveStatus),
				LiveTime:   jsonInt(item.LiveTime),
			}
		}
	}
	return out, nil
}

// RoomUID 返回房间对应的主播 UID（room_get_info，匿名可用）。
// 开播提醒引擎用它把关注里的房间号换成批量接口需要的 UID。
func (c *Client) RoomUID(roomID string) (string, error) {
	normalized := NormalizeRoomID(roomID)
	if normalized == "" {
		return "", fmt.Errorf("房间号为空")
	}
	target := buildURL(urlRoomGetInfo, "room_id="+queryEscape(normalized))
	body, err := c.getRaw(target)
	if err != nil {
		return "", describe("room_get_info 请求失败", err)
	}
	var resp struct {
		Code int64  `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			UID any `json:"uid"`
		} `json:"data"`
	}
	if err := unmarshalJSON(body, &resp); err != nil {
		return "", describe("room_get_info 解析失败", err)
	}
	if resp.Code != 0 {
		return "", &apiError{Code: resp.Code, Message: resp.Msg, Endpoint: "Room/get_info"}
	}
	uid := jsonString(resp.Data.UID)
	if uid == "" || uid == "0" {
		return "", fmt.Errorf("房间 %s 未返回主播 UID", normalized)
	}
	return uid, nil
}