package services

// recording_service.go 是「独立录制」：后端直接拉平台 FLV 原流落盘，
// 不经过播放器，所以关闭工作台画面 / 移除房间都不影响录制。
//
//   - 最多同时 4 路；原流保存，不转码；H.264+AAC/MP3 封装成 MKV，
//     其他编码（如 HEVC）回退为 FLV 原容器。
//   - 每约 15 分钟在关键帧处切一个分片；最后不足一段也保留。
//   - 斗鱼直链 300 秒寿命：到期前重新取流并按 tag 时间轴接续（同 flv_relay）。
//   - 磁盘剩余不足 1GB 时自动停止；退出软件停止全部录制。
//   - 停止后可后台无损合并分片：校验成功才清理原分片，失败可重试。

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"dtv/internal/appdirs"
	"dtv/internal/platforms/common"
)

const (
	recordingMaxConcurrent   = 4
	recordingSegmentDuration = 15 * time.Minute
	recordingMinFreeBytes    = 1 << 30 // 1GB
	recordingDiskCheckEvery  = 5 * time.Second
	recordingReadBuffer      = 32 * 1024
)

// RecordingSettings 是独立录制的持久化偏好。
type RecordingSettings struct {
	SaveDir       string `json:"saveDir"`
	AutoMerge     bool   `json:"autoMerge"`
	NotifyOnError bool   `json:"notifyOnError"`
}

// RecordingTask 是给前端任务表格的快照。
type RecordingTask struct {
	ID                    string `json:"id"`
	Platform              string `json:"platform"`
	RoomID                string `json:"roomId"`
	Nickname              string `json:"nickname"`
	Quality               string `json:"quality"`
	QualityLabel          string `json:"qualityLabel"`
	Status                string `json:"status"` // recording | stopped | error
	Error                 string `json:"error,omitempty"`
	StartedAt             int64  `json:"startedAt"` // ms
	DurationSeconds       int    `json:"durationSeconds"`
	SavedBytes            int64  `json:"savedBytes"`
	BitrateBps            int64  `json:"bitrateBps"`
	EstimatedBytesPerHour int64  `json:"estimatedBytesPerHour"`
	SegmentCount          int    `json:"segmentCount"`
	Container             string `json:"container"` // mkv | flv
	Dir                   string `json:"dir"`
	MergeState            string `json:"mergeState"` // "" | pending | merging | merged | failed
	MergedPath            string `json:"mergedPath,omitempty"`
	MergeError            string `json:"mergeError,omitempty"`
}

// StreamResolver 由 main.go 注入：按平台复用现有 Service 的取流能力。
type StreamResolver func(platform, roomID string) (*common.StreamInfo, error)

// RecordingService 管理独立录制任务。
type RecordingService struct {
	mu           sync.Mutex
	runs         map[string]*recordingRun
	order        []string
	resolve      StreamResolver
	emit         func(string, any)
	client       *http.Client
	settings     RecordingSettings
	stopTicker   chan struct{}
	shuttingDown bool
}

type recordingRun struct {
	task     RecordingTask // 由 service.mu 保护
	cancel   context.CancelFunc
	segments []recordingSegment
	saved    atomic.Int64
	firstTs  int64 // 全局首个 tag 时间戳（ms），-1 未初始化
	lastTs   int64
	samples  []recordingSample
	done     chan struct{}
}

type recordingSample struct {
	at    time.Time
	bytes int64
}

type recordingSegment struct {
	path       string
	container  string
	codecKey   string
	durationMS int64
}

// NewRecordingService 创建录制服务并启动状态广播。
func NewRecordingService(emit func(string, any), resolve StreamResolver) *RecordingService {
	s := &RecordingService{
		runs:       make(map[string]*recordingRun),
		resolve:    resolve,
		emit:       emit,
		client:     newLiveStreamHTTPClient(),
		settings:   loadRecordingSettings(),
		stopTicker: make(chan struct{}),
	}
	go s.broadcastLoop()
	return s
}

func recordingSettingsFile() string {
	return filepath.Join(appdirs.ConfigDir(), "recording_settings.json")
}

func defaultRecordingSettings() RecordingSettings {
	return RecordingSettings{
		SaveDir:       filepath.Join(appdirs.RecordingsDir(), "live"),
		AutoMerge:     false,
		NotifyOnError: true,
	}
}

func loadRecordingSettings() RecordingSettings {
	settings := defaultRecordingSettings()
	data, err := os.ReadFile(recordingSettingsFile())
	if err != nil {
		return settings
	}
	var stored RecordingSettings
	if json.Unmarshal(data, &stored) != nil {
		return settings
	}
	if dir := strings.TrimSpace(stored.SaveDir); dir != "" && filepath.IsAbs(dir) {
		settings.SaveDir = filepath.Clean(dir)
	}
	settings.AutoMerge = stored.AutoMerge
	settings.NotifyOnError = stored.NotifyOnError
	return settings
}

// GetSettings 返回当前录制偏好。
func (s *RecordingService) GetSettings() RecordingSettings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.settings
}

// UpdateSettings 校验并持久化录制偏好。
func (s *RecordingService) UpdateSettings(settings RecordingSettings) error {
	dir := strings.TrimSpace(settings.SaveDir)
	if dir == "" {
		dir = defaultRecordingSettings().SaveDir
	}
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return fmt.Errorf("解析保存目录失败：%w", err)
	}
	if err := os.MkdirAll(absolute, 0o755); err != nil {
		return fmt.Errorf("创建保存目录失败：%w", err)
	}
	info, err := os.Stat(absolute)
	if err != nil || !info.IsDir() {
		return errors.New("保存路径不是目录")
	}
	next := RecordingSettings{
		SaveDir:       filepath.Clean(absolute),
		AutoMerge:     settings.AutoMerge,
		NotifyOnError: settings.NotifyOnError,
	}
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(appdirs.ConfigDir(), 0o755); err != nil {
		return err
	}
	path := recordingSettingsFile()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("写入录制设置失败：%w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("保存录制设置失败：%w", err)
	}
	s.mu.Lock()
	s.settings = next
	s.mu.Unlock()
	return nil
}

// OpenSaveDirectory 在系统文件管理器中打开录制保存目录。
func (s *RecordingService) OpenSaveDirectory() error {
	s.mu.Lock()
	dir := s.settings.SaveDir
	s.mu.Unlock()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("创建目录失败：%w", err)
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", dir)
	case "darwin":
		cmd = exec.Command("open", dir)
	default:
		cmd = exec.Command("xdg-open", dir)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("打开目录失败：%w", err)
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// newLiveStreamHTTPClient 与直播流中继共用同一套上游传输参数：
// 斗鱼边缘节点只提供老式 RSA 密钥交换套件，必须显式放开。
func newLiveStreamHTTPClient() *http.Client {
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
		MaxIdleConns:          8,
		IdleConnTimeout:       90 * time.Second,
		ForceAttemptHTTP2:     false,
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS10,
			CipherSuites: []uint16{
				tls.TLS_RSA_WITH_AES_256_GCM_SHA384,
				tls.TLS_RSA_WITH_AES_128_GCM_SHA256,
				tls.TLS_RSA_WITH_AES_256_CBC_SHA,
				tls.TLS_RSA_WITH_AES_128_CBC_SHA,
				tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
				tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
				tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
				tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			},
		},
	}
	return &http.Client{Transport: transport}
}

// Start 开始一路独立录制。quality 取值 best / high / medium / low。
func (s *RecordingService) Start(platform, roomID, quality string) (*RecordingTask, error) {
	platform = strings.TrimSpace(platform)
	roomID = strings.TrimSpace(roomID)
	switch platform {
	case "douyu", "huya", "douyin", "bilibili":
	default:
		return nil, errors.New("不支持的平台")
	}
	if roomID == "" {
		return nil, errors.New("缺少房间号")
	}
	switch quality {
	case "best", "high", "medium", "low":
	default:
		quality = "best"
	}

	s.mu.Lock()
	if s.shuttingDown {
		s.mu.Unlock()
		return nil, errors.New("应用正在退出")
	}
	active := 0
	for _, run := range s.runs {
		if run.task.Status != "recording" {
			continue
		}
		active++
		if run.task.Platform == platform && run.task.RoomID == roomID {
			s.mu.Unlock()
			return nil, errors.New("该直播间已在录制中")
		}
	}
	if active >= recordingMaxConcurrent {
		s.mu.Unlock()
		return nil, fmt.Errorf("最多同时录制 %d 路", recordingMaxConcurrent)
	}
	id := newRecordingID()
	dir := filepath.Join(s.settings.SaveDir,
		fmt.Sprintf("DTV-%s-%s-%s", platform, roomID, time.Now().Format("20060102-150405")))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		s.mu.Unlock()
		return nil, fmt.Errorf("创建录制目录失败：%w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	run := &recordingRun{
		task: RecordingTask{
			ID:        id,
			Platform:  platform,
			RoomID:    roomID,
			Quality:   quality,
			Status:    "recording",
			StartedAt: time.Now().UnixMilli(),
			Container: "mkv",
			Dir:       dir,
		},
		cancel:  cancel,
		firstTs: -1,
		done:    make(chan struct{}),
	}
	s.runs[id] = run
	s.order = append(s.order, id)
	task := run.task
	s.mu.Unlock()

	go s.record(ctx, run)
	return &task, nil
}

func newRecordingID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("r%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

// Stop 停止一路录制（异步收尾；开启自动合并时随后后台合并）。
func (s *RecordingService) Stop(id string) error {
	s.mu.Lock()
	run := s.runs[id]
	s.mu.Unlock()
	if run == nil {
		return errors.New("录制任务不存在")
	}
	run.cancel()
	return nil
}

// StopAll 停止全部录制。
func (s *RecordingService) StopAll() error {
	s.mu.Lock()
	runs := make([]*recordingRun, 0, len(s.runs))
	for _, run := range s.runs {
		runs = append(runs, run)
	}
	s.mu.Unlock()
	for _, run := range runs {
		run.cancel()
	}
	return nil
}

// Tasks 返回全部任务快照（含已停止/出错的，供表格展示与重试合并）。
func (s *RecordingService) Tasks() []RecordingTask {
	s.mu.Lock()
	defer s.mu.Unlock()
	tasks := make([]RecordingTask, 0, len(s.order))
	for _, id := range s.order {
		if run := s.runs[id]; run != nil {
			tasks = append(tasks, s.snapshotLocked(run))
		}
	}
	return tasks
}

// snapshotLocked 汇总运行时统计（调用方持有 s.mu）。
func (s *RecordingService) snapshotLocked(run *recordingRun) RecordingTask {
	task := run.task
	task.SavedBytes = run.saved.Load()
	task.SegmentCount = len(run.segments)
	if run.firstTs >= 0 && run.lastTs > run.firstTs {
		task.DurationSeconds = int((run.lastTs - run.firstTs) / 1000)
	}
	if n := len(run.samples); n >= 2 {
		first, last := run.samples[0], run.samples[n-1]
		if dt := last.at.Sub(first.at).Seconds(); dt > 0.5 {
			bps := int64(float64(last.bytes-first.bytes) * 8 / dt)
			task.BitrateBps = bps
			task.EstimatedBytesPerHour = bps / 8 * 3600
		}
	}
	if task.Status != "recording" {
		task.BitrateBps = 0
	}
	return task
}

// RetryMerge 重试失败的合并。
func (s *RecordingService) RetryMerge(id string) error {
	s.mu.Lock()
	run := s.runs[id]
	if run == nil {
		s.mu.Unlock()
		return errors.New("录制任务不存在")
	}
	if run.task.Status == "recording" || run.task.MergeState != "failed" {
		s.mu.Unlock()
		return errors.New("该任务当前不可重试合并")
	}
	run.task.MergeState = "pending"
	run.task.MergeError = ""
	s.mu.Unlock()
	go s.mergeRun(run)
	return nil
}

// ServiceShutdown 退出软件：停止全部录制并保留分片（不合并）。
func (s *RecordingService) ServiceShutdown() error {
	s.mu.Lock()
	s.shuttingDown = true
	runs := make([]*recordingRun, 0, len(s.runs))
	for _, run := range s.runs {
		runs = append(runs, run)
	}
	s.mu.Unlock()
	for _, run := range runs {
		run.cancel()
	}
	deadline := time.After(3 * time.Second)
	for _, run := range runs {
		select {
		case <-run.done:
		case <-deadline:
		}
	}
	close(s.stopTicker)
	return nil
}

// broadcastLoop 每秒把任务快照推给前端（有任务时才发）。
func (s *RecordingService) broadcastLoop() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.stopTicker:
			return
		case <-ticker.C:
			s.mu.Lock()
			empty := len(s.runs) == 0
			s.mu.Unlock()
			if !empty && s.emit != nil {
				s.emit("dtv:recording-update", s.Tasks())
			}
		}
	}
}

/* ------------------------------------------------------------ 录制循环 */

func (s *RecordingService) record(ctx context.Context, run *recordingRun) {
	defer close(run.done)
	writer := &recordingWriter{s: s, run: run, segFirstTs: -1}
	err := s.recordStream(ctx, run, writer)
	writer.closeSegment()

	s.mu.Lock()
	if err != nil && !errors.Is(err, context.Canceled) {
		run.task.Status = "error"
		run.task.Error = err.Error()
	} else {
		run.task.Status = "stopped"
	}
	autoMerge := s.settings.AutoMerge && !s.shuttingDown && len(run.segments) > 0
	if autoMerge {
		run.task.MergeState = "pending"
	}
	notify := s.settings.NotifyOnError && run.task.Status == "error"
	task := s.snapshotLocked(run)
	s.mu.Unlock()

	if notify && s.emit != nil {
		s.emit("dtv:recording-error", map[string]any{
			"message":  task.Error,
			"nickname": task.Nickname,
			"platform": task.Platform,
			"roomId":   task.RoomID,
		})
	}
	if s.emit != nil {
		s.emit("dtv:recording-update", s.Tasks())
	}
	if autoMerge {
		go s.mergeRun(run)
	}
}

func (s *RecordingService) recordStream(ctx context.Context, run *recordingRun, writer *recordingWriter) error {
	platform, roomID, quality := run.task.Platform, run.task.RoomID, run.task.Quality
	variant, nickname, err := s.resolveRecordingVariant(platform, roomID, quality)
	if err != nil {
		return err
	}
	s.mu.Lock()
	run.task.Nickname = nickname
	run.task.QualityLabel = variant.Label
	s.mu.Unlock()

	body, err := s.openRecordingStream(ctx, variant.URL, platform, roomID)
	if err != nil {
		return err
	}
	defer func() { _ = body.Close() }()

	demux := &flvDemuxer{}
	timeline := &flvTimeline{}
	continuation := false
	waitingKeyframe := false
	segmentStarted := time.Now()
	nextRenewAttempt := time.Time{}
	buf := make([]byte, recordingReadBuffer)
	lastDiskCheck := time.Now()
	lastSample := time.Time{}

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		n, readErr := body.Read(buf)
		if n > 0 {
			demux.push(buf[:n])
			demux.skipHeader()
			for {
				tag, ok := demux.nextTag()
				if !ok {
					break
				}
				if continuation {
					if waitingKeyframe {
						if tag.typ == flvTagScript || tag.sequenceHeader {
							continue
						}
						if !(tag.typ == flvTagVideo && tag.keyframe && timeline.isAhead(tag)) {
							continue
						}
						waitingKeyframe = false
					} else if tag.typ != flvTagScript && !timeline.isAhead(tag) {
						continue
					}
				}
				timeline.observe(tag)
				if writeErr := writer.write(tag); writeErr != nil {
					return writeErr
				}
				s.mu.Lock()
				if run.firstTs < 0 {
					run.firstTs = int64(tag.timestamp)
				}
				if int64(tag.timestamp) > run.lastTs {
					run.lastTs = int64(tag.timestamp)
				}
				s.mu.Unlock()
			}
			if demux.pending() > flvMaxPending {
				return errors.New("直播流无法按 FLV 解析，已停止录制")
			}
			// RECORD_STREAM_CONTINUED
			now := time.Now()
			if now.Sub(lastSample) >= 500*time.Millisecond {
				lastSample = now
				s.mu.Lock()
				run.samples = append(run.samples, recordingSample{at: now, bytes: run.saved.Load()})
				cutoff := now.Add(-10 * time.Second)
				for len(run.samples) > 2 && run.samples[0].at.Before(cutoff) {
					run.samples = run.samples[1:]
				}
				s.mu.Unlock()
			}
			if now.Sub(lastDiskCheck) >= recordingDiskCheckEvery {
				lastDiskCheck = now
				if free, diskErr := diskFreeBytes(run.task.Dir); diskErr == nil && free < recordingMinFreeBytes {
					return errors.New("磁盘剩余不足 1 GB，已停止录制")
				}
			}
			// 斗鱼直链 300 秒寿命：提前重新取流接续。
			if platform == "douyu" &&
				time.Since(segmentStarted)+flvRenewLead >= flvStreamTTL &&
				now.After(nextRenewAttempt) {
				next, renewErr := s.renewRecording(ctx, run, platform, roomID, quality)
				if renewErr == nil {
					_ = body.Close()
					body = next
					demux.reset()
					continuation = true
					waitingKeyframe = true
					segmentStarted = time.Now()
				} else {
					nextRenewAttempt = now.Add(5 * time.Second)
					if errors.Is(renewErr, errStreamOffline) {
						return nil
					}
				}
			}
		}
		if readErr == nil {
			continue
		}
		_ = body.Close()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if platform != "douyu" {
			// 其他平台直链没有硬寿命：上游结束视为主播下播，正常停止。
			return nil
		}
		reopened := false
		for attempt := 0; attempt < flvMaxFailures; attempt++ {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(flvRetryDelay):
			}
			next, renewErr := s.renewRecording(ctx, run, platform, roomID, quality)
			if renewErr == nil {
				body = next
				demux.reset()
				continuation = true
				waitingKeyframe = true
				segmentStarted = time.Now()
				reopened = true
				break
			}
			if errors.Is(renewErr, errStreamOffline) {
				return nil
			}
		}
		if !reopened {
			return errors.New("斗鱼续流失败，录制已停止")
		}
	}
}

func (s *RecordingService) resolveRecordingVariant(platform, roomID, quality string) (*common.StreamVariant, string, error) {
	if s.resolve == nil {
		return nil, "", errors.New("取流能力未初始化")
	}
	info, err := s.resolve(platform, roomID)
	if err != nil {
		return nil, "", err
	}
	if info == nil || !info.IsLive {
		return nil, "", fmt.Errorf("%w：房间 %s", errStreamOffline, roomID)
	}
	variant := pickRecordingVariant(info.Variants, quality)
	if variant == nil {
		return nil, info.Nickname, errors.New("该房间没有可录制的 FLV 直播流")
	}
	return variant, info.Nickname, nil
}

func (s *RecordingService) renewRecording(ctx context.Context, run *recordingRun, platform, roomID, quality string) (io.ReadCloser, error) {
	variant, _, err := s.resolveRecordingVariant(platform, roomID, quality)
	if err != nil {
		return nil, err
	}
	body, err := s.openRecordingStream(ctx, variant.URL, platform, roomID)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	run.task.QualityLabel = variant.Label
	s.mu.Unlock()
	return body, nil
}

func (s *RecordingService) openRecordingStream(ctx context.Context, target, platform, roomID string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, fmt.Errorf("上游地址不合法：%w", err)
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "video/x-flv,application/octet-stream,*/*")
	req.Header.Set("Range", "bytes=0-")
	req.Header.Set("Connection", "keep-alive")
	referer := map[string]string{
		"douyu":    "https://www.douyu.com/",
		"huya":     "https://www.huya.com/",
		"douyin":   "https://live.douyin.com/",
		"bilibili": "https://live.bilibili.com/",
	}[platform]
	if referer != "" {
		req.Header.Set("Referer", referer+roomID)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("连接直播流失败：%w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		_ = resp.Body.Close()
		return nil, fmt.Errorf("直播流返回 HTTP %d：%s", resp.StatusCode, strings.TrimSpace(string(detail)))
	}
	return resp.Body, nil
}

// pickRecordingVariant 在 FLV 档位里按目标挑一个：best 原画/最高，
// high 蓝光/超清优先，medium 高清优先，low 最低档。
func pickRecordingVariant(variants []common.StreamVariant, target string) *common.StreamVariant {
	var flv []common.StreamVariant
	for _, v := range variants {
		if v.Format == "flv" || strings.Contains(v.URL, ".flv") {
			flv = append(flv, v)
		}
	}
	if len(flv) == 0 {
		return nil
	}
	best := &flv[0]
	for i := range flv {
		if variantScore(flv[i].Label) > variantScore(best.Label) {
			best = &flv[i]
		}
	}
	switch target {
	case "high":
		for i := range flv {
			score := variantScore(flv[i].Label)
			if score == 4 || score == 5 {
				return &flv[i]
			}
		}
		return best
	case "medium":
		for i := range flv {
			if variantScore(flv[i].Label) == 3 {
				return &flv[i]
			}
		}
		return best
	case "low":
		lowest := &flv[0]
		for i := range flv {
			if variantScore(flv[i].Label) < variantScore(lowest.Label) {
				lowest = &flv[i]
			}
		}
		return lowest
	default:
		return best
	}
}

func variantScore(label string) int {
	l := strings.ToLower(label)
	switch {
	case strings.Contains(l, "原画") || strings.Contains(l, "origin") || strings.Contains(l, "source"):
		return 6
	case strings.Contains(l, "蓝光") || strings.Contains(l, "bluray") || strings.Contains(l, "uhd"):
		return 5
	case strings.Contains(l, "超清"):
		return 4
	case strings.Contains(l, "高清") || strings.Contains(l, "hd") || strings.Contains(l, "high"):
		return 3
	case strings.Contains(l, "标清") || strings.Contains(l, "sd"):
		return 2
	case strings.Contains(l, "流畅") || strings.Contains(l, "ld") || strings.Contains(l, "md"):
		return 1
	default:
		return 3
	}
}
