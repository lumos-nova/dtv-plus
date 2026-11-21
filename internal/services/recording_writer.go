package services

// recording_writer.go 把 FLV tag 写进录制分片：
// H.264 + AAC/MP3 → MKV（mkv.go），其余编码 → FLV 原容器直通。
// 每约 15 分钟在视频关键帧处切分片；编码配置变化时也切分片
//（合并阶段按编码分组，保证「格式变化时分别合并」）。

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

// recordingFlvHeader 是标准 FLV 文件头（音视频都有 + 9 字节偏移 + PreviousTagSize0）。
var recordingFlvHeader = []byte{'F', 'L', 'V', 1, 5, 0, 0, 0, 9, 0, 0, 0, 0}

type recordingWriter struct {
	s   *RecordingService
	run *recordingRun

	segIndex         int
	file             *os.File
	bw               *bufio.Writer
	muxer            *mkvMuxer
	container        string
	codecKey         string
	segFirstTs       int64
	segLastPts       int64
	flvHeaderWritten bool

	decided     bool
	videoCodec  byte
	audioFormat byte
	videoCfg    []byte
	audioCfg    []byte
	pending     []flvTag
}

// countingWriter 把写入字节数实时累加到任务的 saved 计数。
type countingWriter struct {
	w   *os.File
	run *recordingRun
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	if n > 0 {
		c.run.saved.Add(int64(n))
	}
	return n, err
}

func (w *recordingWriter) write(tag flvTag) error {
	if tag.typ == flvTagScript {
		return nil
	}
	if len(tag.raw) < 11+2+4 {
		return nil
	}
	if tag.sequenceHeader {
		return w.observeConfig(tag)
	}
	if !w.decided {
		// tag.raw 指向解复用缓冲，跨 chunk 缓存必须拷贝。
		copied := tag
		copied.raw = append([]byte(nil), tag.raw...)
		w.pending = append(w.pending, copied)
		if tag.typ == flvTagVideo || len(w.pending) >= 96 {
			if err := w.decide(); err != nil {
				return err
			}
			pending := w.pending
			w.pending = nil
			for _, item := range pending {
				if err := w.writeMedia(item); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return w.writeMedia(tag)
}

// observeConfig 记录 / 更新编码配置；配置变化时切分片。
func (w *recordingWriter) observeConfig(tag flvTag) error {
	payload := tag.raw[11 : len(tag.raw)-4]
	if tag.typ == flvTagVideo {
		if len(payload) < 5 {
			return nil
		}
		codec := tag.raw[11] & 0x0f
		cfg := append([]byte(nil), payload[5:]...)
		if w.decided && (codec != w.videoCodec || !bytes.Equal(cfg, w.videoCfg)) {
			w.closeSegment()
			w.decided = false
			w.pending = nil
		}
		w.videoCodec = codec
		w.videoCfg = cfg
		return nil
	}
	format := tag.raw[11] >> 4
	var cfg []byte
	if format == 10 && len(payload) > 2 {
		cfg = append([]byte(nil), payload[2:]...)
	}
	if w.decided && (format != w.audioFormat || !bytes.Equal(cfg, w.audioCfg)) {
		w.closeSegment()
		w.decided = false
		w.pending = nil
	}
	w.audioFormat = format
	w.audioCfg = cfg
	return nil
}

// decide 选定容器并打开第一个分片。
func (w *recordingWriter) decide() error {
	w.decided = true
	mkvOK := w.videoCodec == 7 && len(w.videoCfg) > 0 &&
		(w.audioFormat == 0 || w.audioFormat == 2 || (w.audioFormat == 10 && len(w.audioCfg) > 0))
	if mkvOK {
		w.container = "mkv"
	} else {
		w.container = "flv"
	}
	sum := sha256.Sum256(append(append([]byte(w.container), w.videoCfg...), w.audioCfg...))
	w.codecKey = hex.EncodeToString(sum[:8])
	return w.openSegment()
}

func (w *recordingWriter) openSegment() error {
	w.segIndex++
	w.segFirstTs = -1
	w.segLastPts = 0
	path := filepath.Join(w.run.task.Dir, fmt.Sprintf("part-%03d.%s", w.segIndex, w.container))
	file, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("创建录制分片失败：%w", err)
	}
	w.file = file
	w.bw = bufio.NewWriterSize(&countingWriter{w: file, run: w.run}, 256*1024)
	if w.container == "mkv" {
		muxer, muxErr := newMKVMuxer(w.bw, w.videoCfg, w.audioCfg, w.audioFormat)
		if muxErr != nil {
			// SPS/ASC 解析失败（罕见流）：回退 FLV 原容器，保证仍能录。
			_ = w.bw.Flush()
			_ = file.Close()
			_ = os.Remove(path)
			w.container = "flv"
			sum := sha256.Sum256(append(append([]byte("flv"), w.videoCfg...), w.audioCfg...))
			w.codecKey = hex.EncodeToString(sum[:8])
			path = filepath.Join(w.run.task.Dir, fmt.Sprintf("part-%03d.flv", w.segIndex))
			file, err = os.Create(path)
			if err != nil {
				return fmt.Errorf("创建录制分片失败：%w", err)
			}
			w.file = file
			w.bw = bufio.NewWriterSize(&countingWriter{w: file, run: w.run}, 256*1024)
		} else {
			w.muxer = muxer
		}
	}
	w.s.mu.Lock()
	w.run.task.Container = w.container
	w.s.mu.Unlock()
	return nil
}

func (w *recordingWriter) writeMedia(tag flvTag) error {
	// 15 分钟分段：只在视频关键帧处切，保证每个分片可独立播放。
	if tag.typ == flvTagVideo && tag.keyframe &&
		w.segFirstTs >= 0 && w.segLastPts >= recordingSegmentDuration.Milliseconds() {
		w.closeSegment()
		if err := w.openSegment(); err != nil {
			return err
		}
	}
	if w.segFirstTs < 0 {
		w.segFirstTs = int64(tag.timestamp)
	}
	dts := int64(tag.timestamp) - w.segFirstTs
	pts := tag.pts - w.segFirstTs
	if dts < 0 {
		dts = 0
	}
	if pts < 0 {
		pts = dts
	}
	if pts > w.segLastPts {
		w.segLastPts = pts
	}
	payload := tag.raw[11 : len(tag.raw)-4]
	if w.muxer != nil {
		if tag.typ == flvTagVideo {
			if len(payload) < 5 {
				return nil
			}
			return w.muxer.writeFrame(1, pts, tag.keyframe, payload[5:])
		}
		if w.audioFormat == 10 {
			if len(payload) < 2 {
				return nil
			}
			return w.muxer.writeFrame(2, dts, false, payload[2:])
		}
		return w.muxer.writeFrame(2, dts, false, payload[1:])
	}
	// FLV 直通：拷贝 tag 并把时间戳归一化到分片 0 起点。
	raw := append([]byte(nil), tag.raw...)
	rewriteFlvTimestamp(raw, dts)
	if !w.flvHeaderWritten {
		w.flvHeaderWritten = true
		if _, err := w.bw.Write(recordingFlvHeader); err != nil {
			return err
		}
	}
	_, err := w.bw.Write(raw)
	return err
}

// rewriteFlvTimestamp 原地改写 tag 头里的时间戳（低 24 位 + 高 8 位扩展）。
func rewriteFlvTimestamp(raw []byte, ts int64) {
	if ts < 0 {
		ts = 0
	}
	if ts > int64(^uint32(0)) {
		ts = int64(^uint32(0))
	}
	if len(raw) >= 8 {
		raw[4] = byte(ts >> 16)
		raw[5] = byte(ts >> 8)
		raw[6] = byte(ts)
		raw[7] = byte(ts >> 24)
	}
}

func (w *recordingWriter) closeSegment() {
	if w.file == nil {
		return
	}
	if w.muxer != nil {
		_ = w.muxer.close()
		w.muxer = nil
	}
	_ = w.bw.Flush()
	path := w.file.Name()
	_ = w.file.Close()
	w.file = nil
	w.bw = nil
	w.flvHeaderWritten = false
	duration := w.segLastPts + 40 // 补一帧的时长估计
	w.s.mu.Lock()
	w.run.segments = append(w.run.segments, recordingSegment{
		path:       path,
		container:  w.container,
		codecKey:   w.codecKey,
		durationMS: duration,
	})
	w.s.mu.Unlock()
}
