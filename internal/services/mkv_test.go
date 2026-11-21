package services

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// testBitWriter 按位构造 SPS 测试数据。
type testBitWriter struct {
	buf  []byte
	bits int
}

func (w *testBitWriter) write(value uint, n int) {
	for i := n - 1; i >= 0; i-- {
		bit := byte(value>>uint(i)) & 1
		if w.bits%8 == 0 {
			w.buf = append(w.buf, 0)
		}
		w.buf[len(w.buf)-1] |= bit << (7 - uint(w.bits%8))
		w.bits++
	}
}

func (w *testBitWriter) ue(value uint) {
	v := value + 1
	n := 0
	for tmp := v; tmp > 0; tmp >>= 1 {
		n++
	}
	w.write(0, n-1)
	w.write(v, n)
}

// testAvcConfig 构造 baseline 1280x720 的 avcC。
func testAvcConfig(t *testing.T) []byte {
	t.Helper()
	w := &testBitWriter{}
	w.write(0x67, 8) // nal header
	w.write(66, 8)   // profile_idc baseline
	w.write(0, 8)    // constraints
	w.write(30, 8)   // level_idc
	w.ue(0)          // sps id
	w.ue(0)          // log2_max_frame_num_minus4
	w.ue(0)          // poc type
	w.ue(0)          // log2_max_poc_lsb_minus4
	w.ue(1)          // max_num_ref_frames
	w.write(0, 1)    // gaps allowed
	w.ue(79)         // width_mbs_minus1 → 1280
	w.ue(44)         // height_map_minus1 → 720
	w.write(1, 1)    // frame_mbs_only
	w.write(1, 1)    // direct_8x8
	w.write(0, 1)    // no crop
	w.write(1, 1)    // rbsp stop bit
	sps := w.buf
	avcc := []byte{1, 66, 0, 30, 0xff, 0xe1, byte(len(sps) >> 8), byte(len(sps))}
	avcc = append(avcc, sps...)
	avcc = append(avcc, 1, 0, 4, 0x68, 0xce, 0x3c, 0x80)
	return avcc
}

func TestParseAvcDimensions(t *testing.T) {
	width, height, err := parseAvcDimensions(testAvcConfig(t))
	if err != nil {
		t.Fatalf("parseAvcDimensions() error = %v", err)
	}
	if width != 1280 || height != 720 {
		t.Fatalf("dimensions = %dx%d, want 1280x720", width, height)
	}
}

func TestParseAacConfig(t *testing.T) {
	// AOT=2(AAC-LC) freqIdx=4(44100) channels=2 + GASpecificConfig 000
	rate, channels, err := parseAacConfig([]byte{0x12, 0x10})
	if err != nil {
		t.Fatalf("parseAacConfig() error = %v", err)
	}
	if rate != 44100 || channels != 2 {
		t.Fatalf("aac = %v/%d, want 44100/2", rate, channels)
	}
}

func TestParseMp3Header(t *testing.T) {
	// MPEG1 Layer III 44100 stereo：FF FB 90 00
	rate, channels, ok := parseMp3Header([]byte{0xff, 0xfb, 0x90, 0x00})
	if !ok || rate != 44100 || channels != 2 {
		t.Fatalf("mp3 = %v/%d/%v, want 44100/2/true", rate, channels, ok)
	}
}

// writeTestMKV 生成一个含音视频帧的测试分片。
func writeTestMKV(t *testing.T, path string, frames int) int64 {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	muxer, err := newMKVMuxer(file, testAvcConfig(t), []byte{0x12, 0x10}, 10)
	if err != nil {
		t.Fatalf("newMKVMuxer() error = %v", err)
	}
	var last int64
	for i := 0; i < frames; i++ {
		pts := int64(i) * 40
		keyframe := i%50 == 0
		if err := muxer.writeFrame(1, pts, keyframe, []byte{0, 0, 0, 2, 9, byte(i)}); err != nil {
			t.Fatal(err)
		}
		if err := muxer.writeFrame(2, pts, false, []byte{0x21, byte(i)}); err != nil {
			t.Fatal(err)
		}
		last = pts
	}
	if err := muxer.close(); err != nil {
		t.Fatal(err)
	}
	return last + 40
}

func TestMKVMuxAndMergeRoundtrip(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "part-001.mkv")
	second := filepath.Join(dir, "part-002.mkv")
	d1 := writeTestMKV(t, first, 200) // 8 秒，跨多个 cluster
	d2 := writeTestMKV(t, second, 100)

	blocks1, err := countMKVBlocks(first)
	if err != nil || blocks1 != 400 {
		t.Fatalf("countMKVBlocks(first) = %d, %v; want 400", blocks1, err)
	}
	blocks2, err := countMKVBlocks(second)
	if err != nil || blocks2 != 200 {
		t.Fatalf("countMKVBlocks(second) = %d, %v; want 200", blocks2, err)
	}

	merged := filepath.Join(dir, "merged.mkv")
	if err := mergeMKVSegments([]string{first, second}, []int64{d1, d2}, merged); err != nil {
		t.Fatalf("mergeMKVSegments() error = %v", err)
	}
	maxTS, err := validateMKV(merged, blocks1+blocks2)
	if err != nil {
		t.Fatalf("validateMKV() error = %v", err)
	}
	if maxTS < d1 {
		t.Fatalf("merged maxTS = %d, want >= first duration %d", maxTS, d1)
	}
	// 合并文件必须以 EBML 头开始且包含 matroska doctype。
	data, err := os.ReadFile(merged)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data[:64], []byte("matroska")) {
		t.Fatal("merged file missing matroska doctype")
	}
	// 可选：把合并样本落盘，供外部 ffmpeg 做真实解码验证。
	if dump := os.Getenv("DTV_MKV_DUMP"); dump != "" {
		if err := os.WriteFile(dump, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMergeFLVSegmentsShiftsTimestamps(t *testing.T) {
	dir := t.TempDir()
	makeTag := func(typ byte, ts uint32, payload []byte) []byte {
		size := len(payload)
		tag := []byte{typ, byte(size >> 16), byte(size >> 8), byte(size),
			byte(ts >> 16), byte(ts >> 8), byte(ts), byte(ts >> 24), 0, 0, 0}
		tag = append(tag, payload...)
		total := 11 + size
		return append(tag, byte(total>>24), byte(total>>16), byte(total>>8), byte(total))
	}
	writeFLV := func(path string, base uint32) {
		var buf bytes.Buffer
		buf.Write(recordingFlvHeader)
		// 视频关键帧 tag：frameType/keyframe + codec7，AVCPacketType1 + CTS0。
		buf.Write(makeTag(9, base, []byte{0x17, 1, 0, 0, 0, 1, 2, 3}))
		buf.Write(makeTag(8, base+20, []byte{0xaf, 1, 4, 5}))
		buf.Write(makeTag(9, base+40, []byte{0x27, 1, 0, 0, 0, 6, 7}))
		if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	first := filepath.Join(dir, "a.flv")
	second := filepath.Join(dir, "b.flv")
	writeFLV(first, 0)
	writeFLV(second, 0)
	merged := filepath.Join(dir, "merged.flv")
	if err := mergeFLVSegments([]string{first, second}, []int64{80, 80}, merged); err != nil {
		t.Fatalf("mergeFLVSegments() error = %v", err)
	}
	if err := validateFLV(merged); err != nil {
		t.Fatalf("validateFLV() error = %v", err)
	}
	data, err := os.ReadFile(merged)
	if err != nil {
		t.Fatal(err)
	}
	demux := &flvDemuxer{}
	demux.push(data)
	demux.skipHeader()
	var timestamps []uint32
	for {
		tag, ok := demux.nextTag()
		if !ok {
			break
		}
		timestamps = append(timestamps, tag.timestamp)
	}
	want := []uint32{0, 20, 40, 80, 100, 120}
	if len(timestamps) != len(want) {
		t.Fatalf("merged tags = %v, want %v", timestamps, want)
	}
	for i := range want {
		if timestamps[i] != want[i] {
			t.Fatalf("merged timestamps = %v, want %v", timestamps, want)
		}
	}
}
