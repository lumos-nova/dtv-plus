package services

// recording_merge.go 实现「录制结束后自动合并分片」：
// 按编码配置分组（格式变化时分别合并），MKV 走 Cluster 级无损拼接，
// FLV 走 tag 级时间戳平移拼接；合并结果重新解析校验，成功才删除原分片。

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func (s *RecordingService) mergeRun(run *recordingRun) {
	s.mu.Lock()
	if run.task.MergeState != "pending" {
		s.mu.Unlock()
		return
	}
	run.task.MergeState = "merging"
	segments := append([]recordingSegment(nil), run.segments...)
	dir := run.task.Dir
	s.mu.Unlock()
	if s.emit != nil {
		s.emit("dtv:recording-update", s.Tasks())
	}

	// 按编码配置分组，保持时间顺序。
	var keys []string
	groups := make(map[string][]recordingSegment)
	for _, segment := range segments {
		if _, ok := groups[segment.codecKey]; !ok {
			keys = append(keys, segment.codecKey)
		}
		groups[segment.codecKey] = append(groups[segment.codecKey], segment)
	}

	base := filepath.Base(dir)
	var mergedPaths []string
	var mergeErr error
	for index, key := range keys {
		group := groups[key]
		final := filepath.Join(dir, fmt.Sprintf("%s-merged-%d.%s", base, index+1, group[0].container))
		if len(group) == 1 {
			mergeErr = os.Rename(group[0].path, final)
		} else {
			mergeErr = mergeRecordingGroup(group, final)
		}
		if mergeErr != nil {
			break
		}
		mergedPaths = append(mergedPaths, final)
	}

	s.mu.Lock()
	if mergeErr != nil {
		run.task.MergeState = "failed"
		run.task.MergeError = mergeErr.Error()
	} else {
		run.task.MergeState = "merged"
		run.task.MergedPath = dir
		if len(mergedPaths) == 1 {
			run.task.MergedPath = mergedPaths[0]
		}
		run.segments = nil
	}
	s.mu.Unlock()
	if s.emit != nil {
		s.emit("dtv:recording-update", s.Tasks())
	}
}

// mergeRecordingGroup 合并同编码的一组（≥2 个）分片并校验。
func mergeRecordingGroup(group []recordingSegment, final string) error {
	paths := make([]string, len(group))
	durations := make([]int64, len(group))
	for i, segment := range group {
		paths[i] = segment.path
		durations[i] = segment.durationMS
	}
	tmp := final + ".tmp"
	var err error
	if group[0].container == "mkv" {
		expected := 0
		for _, path := range paths {
			blocks, countErr := countMKVBlocks(path)
			if countErr != nil {
				return fmt.Errorf("读取分片失败：%w", countErr)
			}
			expected += blocks
		}
		err = mergeMKVSegments(paths, durations, tmp)
		if err == nil {
			_, err = validateMKV(tmp, expected)
		}
	} else {
		err = mergeFLVSegments(paths, durations, tmp)
		if err == nil {
			err = validateFLV(tmp)
		}
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	// 校验成功才清理原分片。
	for _, path := range paths {
		_ = os.Remove(path)
	}
	return nil
}

// mergeFLVSegments 把 FLV 分片按时间戳平移拼接成一个文件。
func mergeFLVSegments(paths []string, durationsMS []int64, outPath string) error {
	if len(paths) == 0 || len(paths) != len(durationsMS) {
		return errors.New("合并参数不完整")
	}
	out, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := out.Write(recordingFlvHeader); err != nil {
		return err
	}
	var offset int64
	for index, path := range paths {
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		demux := &flvDemuxer{}
		demux.push(data)
		demux.skipHeader()
		for {
			tag, ok := demux.nextTag()
			if !ok {
				break
			}
			if index > 0 && (tag.typ == flvTagScript || tag.sequenceHeader) {
				continue
			}
			raw := append([]byte(nil), tag.raw...)
			if index > 0 {
				rewriteFlvTimestamp(raw, int64(tag.timestamp)+offset)
			}
			if _, err := out.Write(raw); err != nil {
				return err
			}
		}
		offset += durationsMS[index]
	}
	return out.Sync()
}

// validateFLV 重新解析合并结果，确认 tag 流完整可读。
func validateFLV(path string) error {
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()
	demux := &flvDemuxer{}
	buf := make([]byte, 64*1024)
	tags := 0
	for {
		n, readErr := in.Read(buf)
		if n > 0 {
			demux.push(buf[:n])
			demux.skipHeader()
			for {
				_, ok := demux.nextTag()
				if !ok {
					break
				}
				tags++
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	if tags == 0 {
		return errors.New("合并结果没有可用的 FLV tag")
	}
	if demux.pending() > 0 {
		return fmt.Errorf("合并结果尾部有 %d 字节无法解析", demux.pending())
	}
	return nil
}
