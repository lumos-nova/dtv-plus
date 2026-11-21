package services

// mkv.go 是独立录制的 Matroska（MKV）封装器：把 FLV tag 里的 H.264 / AAC / MP3
// 原流不转码地装进 MKV。只实现录制需要的最小子集（EBML 头 + Tracks +
// Cluster/SimpleBlock），并提供流式合并与结构校验，供「自动合并分片」使用。
//
// 参考：RFC 8794（EBML）与 Matroska 规范。视频帧保持 avcC 的长度前缀格式
// （V_MPEG4/ISO/AVC 的 CodecPrivate 即 FLV 的 AVC sequence header body），
// 不需要转 Annex-B。

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
)

/* ------------------------------------------------------------ EBML 基础 */

// ebmlVintSize 把长度编码成 EBML 可变长整数（保留 marker 位）。
func ebmlVintSize(size uint64) []byte {
	for length := 1; length <= 8; length++ {
		max := uint64(1)<<(7*length) - 1
		if size < max {
			out := make([]byte, length)
			value := size | uint64(1)<<(7*length)
			for i := length - 1; i >= 0; i-- {
				out[i] = byte(value)
				value >>= 8
			}
			return out
		}
	}
	// 8 字节都装不下时用 unknown size。
	return []byte{0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}
}

func ebmlUintPayload(value uint64) []byte {
	if value == 0 {
		return []byte{0}
	}
	var buf [8]byte
	n := 0
	for i := 7; i >= 0; i-- {
		b := byte(value >> (8 * i))
		if n == 0 && b == 0 {
			continue
		}
		buf[n] = b
		n++
	}
	return buf[:n]
}

func ebmlElement(id uint32, payload []byte) []byte {
	var idBuf [4]byte
	n := 0
	for i := 3; i >= 0; i-- {
		b := byte(id >> (8 * i))
		if n == 0 && b == 0 {
			continue
		}
		idBuf[n] = b
		n++
	}
	out := make([]byte, 0, n+8+len(payload))
	out = append(out, idBuf[:n]...)
	out = append(out, ebmlVintSize(uint64(len(payload)))...)
	out = append(out, payload...)
	return out
}

func ebmlUint(id uint32, value uint64) []byte {
	return ebmlElement(id, ebmlUintPayload(value))
}

func ebmlString(id uint32, value string) []byte {
	return ebmlElement(id, []byte(value))
}

func ebmlFloat(id uint32, value float64) []byte {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], math.Float64bits(value))
	return ebmlElement(id, buf[:])
}

/* ------------------------------------------------------------ 位读取 */

// bitReader 按位读取（SPS 的指数哥伦布编码用）。
type bitReader struct {
	data []byte
	pos  int
	err  bool
}

func (r *bitReader) bit() uint {
	if r.pos/8 >= len(r.data) {
		r.err = true
		return 0
	}
	b := (r.data[r.pos/8] >> (7 - uint(r.pos%8))) & 1
	r.pos++
	return uint(b)
}

func (r *bitReader) bits(n int) uint {
	var value uint
	for i := 0; i < n; i++ {
		value = value<<1 | r.bit()
	}
	return value
}

// ue 无符号指数哥伦布。
func (r *bitReader) ue() uint {
	leading := 0
	for r.bit() == 0 && leading < 32 && !r.err {
		leading++
	}
	if r.err || leading >= 32 {
		r.err = true
		return 0
	}
	return (1 << leading) - 1 + r.bits(leading)
}

// se 有符号指数哥伦布。
func (r *bitReader) se() int {
	k := r.ue()
	if k%2 == 0 {
		return -int(k / 2)
	}
	return int((k + 1) / 2)
}

// skipScalingList 跳过 SPS 里的量化矩阵。
func (r *bitReader) skipScalingList(size int) {
	last, next := 8, 8
	for i := 0; i < size; i++ {
		if next != 0 {
			next = (last + r.se() + 256) % 256
		}
		if next != 0 {
			last = next
		}
	}
}

/* ------------------------------------------------------------ 编码配置解析 */

// parseAvcDimensions 从 avcC（AVC sequence header body）解析像素宽高。
func parseAvcDimensions(avcc []byte) (int, int, error) {
	// avcC: configurationVersion(1) profile(1) compat(1) level(1)
	// lengthSize(1) numSPS(1) [spsLen(2) sps]...
	if len(avcc) < 8 {
		return 0, 0, errors.New("AVC 配置过短")
	}
	numSPS := int(avcc[5] & 0x1f)
	if numSPS < 1 {
		return 0, 0, errors.New("AVC 配置缺少 SPS")
	}
	spsLen := int(avcc[6])<<8 | int(avcc[7])
	if len(avcc) < 8+spsLen || spsLen < 4 {
		return 0, 0, errors.New("AVC 配置 SPS 不完整")
	}
	sps := avcc[8 : 8+spsLen]

	// 去掉防竞争字节（00 00 03 → 00 00）。
	rbsp := make([]byte, 0, len(sps))
	for i := 0; i < len(sps); i++ {
		if i+2 < len(sps) && sps[i] == 0 && sps[i+1] == 0 && sps[i+2] == 3 {
			rbsp = append(rbsp, 0, 0)
			i += 2
			continue
		}
		rbsp = append(rbsp, sps[i])
	}

	r := &bitReader{data: rbsp}
	r.bits(8) // nal header
	profile := r.bits(8)
	r.bits(8) // constraint flags + reserved
	r.bits(8) // level_idc
	r.ue()    // sps id
	chroma := uint(1)
	separatePlane := uint(0)
	if profile == 100 || profile == 110 || profile == 122 || profile == 244 ||
		profile == 44 || profile == 83 || profile == 86 || profile == 118 ||
		profile == 128 || profile == 138 || profile == 139 || profile == 134 || profile == 135 {
		chroma = r.ue()
		if chroma == 3 {
			separatePlane = r.bits(1)
		}
		r.ue() // bit_depth_luma_minus8
		r.ue() // bit_depth_chroma_minus8
		r.bits(1)
		if r.bits(1) != 0 { // seq_scaling_matrix_present
			count := 8
			if chroma == 3 {
				count = 12
			}
			for i := 0; i < count; i++ {
				if r.bits(1) != 0 {
					if i < 6 {
						r.skipScalingList(16)
					} else {
						r.skipScalingList(64)
					}
				}
			}
		}
	}
	r.ue() // log2_max_frame_num_minus4
	pocType := r.ue()
	switch pocType {
	case 0:
		r.ue() // log2_max_pic_order_cnt_lsb_minus4
	case 1:
		r.bits(1)
		r.se()
		r.se()
		n := r.ue()
		for i := uint(0); i < n; i++ {
			r.se()
		}
	}
	r.ue()    // max_num_ref_frames
	r.bits(1) // gaps_in_frame_num_value_allowed
	widthMbs := r.ue() + 1
	heightMap := r.ue() + 1
	frameMbsOnly := r.bits(1)
	if frameMbsOnly == 0 {
		r.bits(1) // mb_adaptive_frame_field
	}
	r.bits(1) // direct_8x8_inference
	cropLeft, cropRight, cropTop, cropBottom := uint(0), uint(0), uint(0), uint(0)
	if r.bits(1) != 0 {
		cropLeft = r.ue()
		cropRight = r.ue()
		cropTop = r.ue()
		cropBottom = r.ue()
	}
	if r.err {
		return 0, 0, errors.New("SPS 解析失败")
	}

	width := int(widthMbs * 16)
	height := int(heightMap * 16 * (2 - frameMbsOnly))
	subWidthC, subHeightC := 2, 2
	switch chroma {
	case 0:
		subWidthC, subHeightC = 1, 1
	case 2:
		subWidthC, subHeightC = 2, 1
	case 3:
		if separatePlane == 0 {
			subWidthC, subHeightC = 1, 1
		} else {
			subWidthC, subHeightC = 0, 0
		}
	}
	if subWidthC > 0 && subHeightC > 0 {
		width -= int((cropLeft + cropRight) * uint(subWidthC))
		height -= int((cropTop + cropBottom) * uint(subHeightC) * (2 - frameMbsOnly))
	}
	if width <= 0 || height <= 0 || width > 16384 || height > 16384 {
		return 0, 0, fmt.Errorf("SPS 尺寸不合理：%dx%d", width, height)
	}
	return width, height, nil
}

var aacSampleRates = []float64{
	96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
	16000, 12000, 11025, 8000, 7350,
}

// parseAacConfig 从 AudioSpecificConfig 解析采样率与声道数。
func parseAacConfig(asc []byte) (float64, int, error) {
	if len(asc) < 2 {
		return 0, 0, errors.New("AAC 配置过短")
	}
	r := &bitReader{data: asc}
	aot := r.bits(5)
	if aot == 31 {
		aot = r.bits(6) + 32
	}
	freqIndex := r.bits(4)
	var rate float64
	if freqIndex == 15 {
		rate = float64(r.bits(24))
	} else if int(freqIndex) < len(aacSampleRates) {
		rate = aacSampleRates[freqIndex]
	}
	channels := r.bits(4)
	if aot == 5 || aot == 29 { // SBR / PS：扩展采样率
		extIndex := r.bits(4)
		if extIndex == 15 {
			rate = float64(r.bits(24))
		} else if int(extIndex) < len(aacSampleRates) {
			rate = aacSampleRates[extIndex]
		}
		if aot == 29 {
			channels = 2
		}
	}
	if r.err || rate <= 0 {
		return 0, 0, errors.New("AAC 配置解析失败")
	}
	ch := int(channels)
	if ch == 7 {
		ch = 8
	}
	if ch <= 0 || ch > 8 {
		return 0, 0, errors.New("AAC 声道数不合理")
	}
	return rate, ch, nil
}

// parseMp3Header 从首个 MP3 帧头解析采样率与声道数。
func parseMp3Header(data []byte) (float64, int, bool) {
	if len(data) < 4 {
		return 0, 0, false
	}
	if data[0] != 0xff || data[1]&0xe0 != 0xe0 {
		return 0, 0, false
	}
	version := uint(data[1]>>3) & 3 // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
	layer := uint(data[1]>>1) & 3   // 1=Layer III
	if version == 1 || layer != 1 {
		return 0, 0, false
	}
	srIndex := uint(data[2]>>2) & 3
	if srIndex == 3 {
		return 0, 0, false
	}
	var rates []float64
	switch version {
	case 3:
		rates = []float64{44100, 48000, 32000}
	case 2:
		rates = []float64{22050, 24000, 16000}
	default:
		rates = []float64{11025, 12000, 8000}
	}
	mode := uint(data[3]>>6) & 3 // 3=mono
	channels := 2
	if mode == 3 {
		channels = 1
	}
	return rates[srIndex], channels, true
}

/* ------------------------------------------------------------ MKV 封装 */

const (
	ebmlIDHeader        = 0x1A45DFA3
	ebmlIDVersion       = 0x4286
	ebmlIDReadVersion   = 0x42F7
	ebmlIDMaxIDLength   = 0x42F2
	ebmlIDMaxSizeLength = 0x42F3
	ebmlIDDocType       = 0x4282
	ebmlIDDocTypeVer    = 0x4287
	ebmlIDDocTypeRead   = 0x4285

	mkvIDSegment       = 0x18538067
	mkvIDInfo          = 0x1549A966
	mkvIDTimecodeScale = 0x2AD7B1
	mkvIDDuration      = 0x4489
	mkvIDMuxingApp     = 0x4D80
	mkvIDWritingApp    = 0x5741
	mkvIDTracks        = 0x1654AE6B
	mkvIDTrackEntry    = 0xAE
	mkvIDTrackNumber   = 0xD7
	mkvIDTrackUID      = 0x73C5
	mkvIDTrackType     = 0x83
	mkvIDFlagLacing    = 0x9C
	mkvIDCodecID       = 0x86
	mkvIDCodecPrivate  = 0x63A2
	mkvIDVideo         = 0xE0
	mkvIDPixelWidth    = 0xB0
	mkvIDPixelHeight   = 0xBA
	mkvIDAudio         = 0xE1
	mkvIDSamplingFreq  = 0xB5
	mkvIDChannels      = 0x9F
	mkvIDCluster       = 0x1F43B675
	mkvIDTimecode      = 0xE7
	mkvIDSimpleBlock   = 0xA3
)

// mkvUnknownSize 是 Segment 的 unknown size（直播式追加写）。
var mkvUnknownSize = []byte{0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}

// mkvMuxer 把归一化到 0 起点的 PTS（毫秒）帧写进一个 MKV 分片。
// Cluster 在内存里聚合（≤5 秒），flush 时以已知 size 写出，方便后续流式合并。
type mkvMuxer struct {
	w            io.Writer
	hasAudio     bool
	audioCodecID string
	cluster      []byte
	clusterStart int64
	clusterLast  int64
	clusterOpen  bool
	lastVideoKey int64
	closed       bool
	// MP3 流的采样率要等首帧才能知道，头部先缓存。
	pendingHeader     []byte
	pendingVideoTrack []byte
	pendingFrames     []mkvPendingFrame
}

type mkvPendingFrame struct {
	track    uint64
	ptsMS    int64
	keyframe bool
	data     []byte
}

// newMKVMuxer 解析编码配置并写出文件头 + Tracks。
// videoCfg 是 avcC；audioCfg 是 AAC 的 AudioSpecificConfig（MP3 时为 nil）。
func newMKVMuxer(w io.Writer, videoCfg, audioCfg []byte, audioFormat byte) (*mkvMuxer, error) {
	width, height, err := parseAvcDimensions(videoCfg)
	if err != nil {
		return nil, err
	}
	m := &mkvMuxer{w: w, lastVideoKey: -1}

	header := ebmlElement(ebmlIDHeader, concatBytes(
		ebmlUint(ebmlIDVersion, 1),
		ebmlUint(ebmlIDReadVersion, 1),
		ebmlUint(ebmlIDMaxIDLength, 4),
		ebmlUint(ebmlIDMaxSizeLength, 8),
		ebmlString(ebmlIDDocType, "matroska"),
		ebmlUint(ebmlIDDocTypeVer, 2),
		ebmlUint(ebmlIDDocTypeRead, 2),
	))
	info := ebmlElement(mkvIDInfo, concatBytes(
		ebmlUint(mkvIDTimecodeScale, 1_000_000), // 1ms
		ebmlString(mkvIDMuxingApp, "DTV"),
		ebmlString(mkvIDWritingApp, "DTV"),
	))
	videoTrack := ebmlElement(mkvIDTrackEntry, concatBytes(
		ebmlUint(mkvIDTrackNumber, 1),
		ebmlUint(mkvIDTrackUID, 1),
		ebmlUint(mkvIDTrackType, 1),
		ebmlUint(mkvIDFlagLacing, 0),
		ebmlString(mkvIDCodecID, "V_MPEG4/ISO/AVC"),
		ebmlElement(mkvIDCodecPrivate, videoCfg),
		ebmlElement(mkvIDVideo, concatBytes(
			ebmlUint(mkvIDPixelWidth, uint64(width)),
			ebmlUint(mkvIDPixelHeight, uint64(height)),
		)),
	))
	tracksPayload := videoTrack
	if audioFormat == 10 && len(audioCfg) > 0 { // AAC
		rate, channels, aacErr := parseAacConfig(audioCfg)
		if aacErr != nil {
			return nil, aacErr
		}
		m.hasAudio = true
		m.audioCodecID = "A_AAC"
		tracksPayload = concatBytes(tracksPayload, audioTrackElement(2, "A_AAC", audioCfg, rate, channels))
	} else if audioFormat == 2 { // MP3：配置从首帧解析，由 writeFrame 前的 setMp3Info 补充
		m.hasAudio = true
		m.audioCodecID = "A_MPEG/L3"
	}
	if m.audioCodecID == "A_AAC" || !m.hasAudio {
		if _, err := w.Write(concatBytes(header, segmentStart(), info, ebmlElement(mkvIDTracks, tracksPayload))); err != nil {
			return nil, err
		}
	} else {
		// MP3 需要等首帧才知道采样率；先缓存头部，setMp3Info 时写出。
		m.pendingHeader = concatBytes(header, segmentStart(), info)
		m.pendingVideoTrack = videoTrack
	}
	return m, nil
}

func audioTrackElement(number uint64, codec string, private []byte, rate float64, channels int) []byte {
	parts := [][]byte{
		ebmlUint(mkvIDTrackNumber, number),
		ebmlUint(mkvIDTrackUID, number),
		ebmlUint(mkvIDTrackType, 2),
		ebmlUint(mkvIDFlagLacing, 0),
		ebmlString(mkvIDCodecID, codec),
	}
	if len(private) > 0 {
		parts = append(parts, ebmlElement(mkvIDCodecPrivate, private))
	}
	parts = append(parts, ebmlElement(mkvIDAudio, concatBytes(
		ebmlFloat(mkvIDSamplingFreq, rate),
		ebmlUint(mkvIDChannels, uint64(channels)),
	)))
	return ebmlElement(mkvIDTrackEntry, concatBytes(parts...))
}

func segmentStart() []byte {
	var idBuf = []byte{0x18, 0x53, 0x80, 0x67}
	return append(append([]byte(nil), idBuf...), mkvUnknownSize...)
}

func concatBytes(parts ...[]byte) []byte {
	total := 0
	for _, p := range parts {
		total += len(p)
	}
	out := make([]byte, 0, total)
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

// writeFrame 写入一帧（ptsMS 已归一化到分片 0 起点）。track 1=视频 2=音频。
func (m *mkvMuxer) writeFrame(track uint64, ptsMS int64, keyframe bool, data []byte) error {
	if m.closed || len(data) == 0 {
		return nil
	}
	if m.pendingHeader != nil {
		if track == 2 {
			rate, channels, ok := parseMp3Header(data)
			if !ok {
				rate, channels = 44100, 2
			}
			tracks := concatBytes(m.pendingVideoTrack, audioTrackElement(2, "A_MPEG/L3", nil, rate, channels))
			if _, err := m.w.Write(concatBytes(m.pendingHeader, ebmlElement(mkvIDTracks, tracks))); err != nil {
				return err
			}
			m.pendingHeader = nil
			m.pendingVideoTrack = nil
			for _, frame := range m.pendingFrames {
				if err := m.appendBlock(frame.track, frame.ptsMS, frame.keyframe, frame.data); err != nil {
					return err
				}
			}
			m.pendingFrames = nil
		} else {
			if len(m.pendingFrames) > 512 {
				// 音频迟迟不来：按纯视频写头，后续音频帧丢弃。
				if _, err := m.w.Write(concatBytes(m.pendingHeader, ebmlElement(mkvIDTracks, m.pendingVideoTrack))); err != nil {
					return err
				}
				m.pendingHeader = nil
				m.pendingVideoTrack = nil
				m.hasAudio = false
				for _, frame := range m.pendingFrames {
					if err := m.appendBlock(frame.track, frame.ptsMS, frame.keyframe, frame.data); err != nil {
						return err
					}
				}
				m.pendingFrames = nil
			} else {
				m.pendingFrames = append(m.pendingFrames, mkvPendingFrame{track, ptsMS, keyframe, append([]byte(nil), data...)})
				return nil
			}
		}
	}
	if track == 2 && !m.hasAudio {
		return nil
	}
	return m.appendBlock(track, ptsMS, keyframe, data)
}

func (m *mkvMuxer) appendBlock(track uint64, ptsMS int64, keyframe bool, data []byte) error {
	if ptsMS < 0 {
		ptsMS = 0
	}
	needNewCluster := !m.clusterOpen
	if m.clusterOpen {
		rel := ptsMS - m.clusterStart
		age := ptsMS - m.clusterLast
		if rel > 30_000 || rel < -30_000 || age > 5_000 {
			needNewCluster = true
		} else if track == 1 && keyframe && ptsMS-m.clusterStart >= 2_000 {
			needNewCluster = true
		}
	}
	if needNewCluster {
		if err := m.flushCluster(); err != nil {
			return err
		}
		m.clusterStart = ptsMS
		m.clusterLast = ptsMS
		m.clusterOpen = true
	}
	if ptsMS > m.clusterLast {
		m.clusterLast = ptsMS
	}
	rel := ptsMS - m.clusterStart
	block := make([]byte, 0, 4+len(data))
	block = append(block, byte(0x80|track))
	block = append(block, byte(int16(rel)>>8), byte(int16(rel)))
	flags := byte(0)
	if track == 1 && keyframe {
		flags = 0x80
	}
	block = append(block, flags)
	block = append(block, data...)
	m.cluster = append(m.cluster, ebmlElement(mkvIDSimpleBlock, block)...)
	return nil
}

func (m *mkvMuxer) flushCluster() error {
	if !m.clusterOpen || len(m.cluster) == 0 {
		m.cluster = nil
		m.clusterOpen = false
		return nil
	}
	payload := concatBytes(ebmlUint(mkvIDTimecode, uint64(m.clusterStart)), m.cluster)
	if _, err := m.w.Write(ebmlElement(mkvIDCluster, payload)); err != nil {
		return err
	}
	m.cluster = nil
	m.clusterOpen = false
	return nil
}

// close 落盘最后一个 cluster。MP3 头部还悬着时按纯视频收尾。
func (m *mkvMuxer) close() error {
	if m.closed {
		return nil
	}
	m.closed = true
	if m.pendingHeader != nil {
		if _, err := m.w.Write(concatBytes(m.pendingHeader, ebmlElement(mkvIDTracks, m.pendingVideoTrack))); err != nil {
			return err
		}
		m.pendingHeader = nil
		for _, frame := range m.pendingFrames {
			if err := m.appendBlock(frame.track, frame.ptsMS, frame.keyframe, frame.data); err != nil {
				return err
			}
		}
		m.pendingFrames = nil
	}
	return m.flushCluster()
}

/* ------------------------------------------------------------ EBML 读取 */

// ebmlReadID 读取元素 ID（保留 marker 位）。
func ebmlReadID(r io.Reader) (uint32, error) {
	var first [1]byte
	if _, err := io.ReadFull(r, first[:]); err != nil {
		return 0, err
	}
	b := first[0]
	length := 0
	switch {
	case b&0x80 != 0:
		length = 1
	case b&0x40 != 0:
		length = 2
	case b&0x20 != 0:
		length = 3
	case b&0x10 != 0:
		length = 4
	default:
		return 0, errors.New("EBML ID 非法")
	}
	id := uint32(b)
	for i := 1; i < length; i++ {
		if _, err := io.ReadFull(r, first[:]); err != nil {
			return 0, err
		}
		id = id<<8 | uint32(first[0])
	}
	return id, nil
}

// ebmlReadSize 读取元素长度；unknown size 返回 (0, true)。
func ebmlReadSize(r io.Reader) (uint64, bool, error) {
	var first [1]byte
	if _, err := io.ReadFull(r, first[:]); err != nil {
		return 0, false, err
	}
	b := first[0]
	length := 0
	for mask := byte(0x80); mask != 0; mask >>= 1 {
		length++
		if b&mask != 0 {
			break
		}
	}
	if length == 0 || length > 8 {
		return 0, false, errors.New("EBML size 非法")
	}
	value := uint64(b & (0xff >> length))
	allOnes := value == uint64(1)<<(7*length)-1
	for i := 1; i < length; i++ {
		if _, err := io.ReadFull(r, first[:]); err != nil {
			return 0, false, err
		}
		value = value<<8 | uint64(first[0])
		if first[0] != 0xff {
			allOnes = false
		}
	}
	if length > 1 && allOnes {
		return 0, true, nil
	}
	return value, false, nil
}

// byteReader 是带消费计数的内存读取器。
type byteReader struct {
	data     []byte
	pos      int
	consumed int
}

func newByteReader(data []byte) *byteReader { return &byteReader{data: data} }

func (r *byteReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	n := copy(p, r.data[r.pos:])
	r.pos += n
	r.consumed += n
	return n, nil
}

func (r *byteReader) ReadByte() (byte, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	b := r.data[r.pos]
	r.pos++
	r.consumed++
	return b, nil
}

// mkvTopLevel 流式遍历 Segment 的直接子元素（Info / Tracks / Cluster…）。
// handler 返回 false 时停止；payload 逐个读入内存（Cluster 有 64MB 上限）。
func mkvTopLevel(r io.Reader, handler func(id uint32, payload []byte) bool) error {
	id, err := ebmlReadID(r)
	if err != nil {
		return err
	}
	if id != ebmlIDHeader {
		return errors.New("不是 EBML 文件")
	}
	size, unknown, err := ebmlReadSize(r)
	if err != nil {
		return err
	}
	if unknown {
		return errors.New("EBML 头长度未知")
	}
	if _, err := io.CopyN(io.Discard, r, int64(size)); err != nil {
		return err
	}
	id, err = ebmlReadID(r)
	if err != nil {
		return err
	}
	if id != mkvIDSegment {
		return errors.New("缺少 Matroska Segment")
	}
	if _, _, err := ebmlReadSize(r); err != nil {
		return err
	}
	for {
		id, err := ebmlReadID(r)
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		size, unknown, err := ebmlReadSize(r)
		if err != nil {
			return err
		}
		if unknown {
			return fmt.Errorf("Segment 子元素 %#x 长度未知", id)
		}
		if size > 64<<20 {
			return fmt.Errorf("Segment 子元素 %#x 过大（%d）", id, size)
		}
		payload := make([]byte, size)
		if _, err := io.ReadFull(r, payload); err != nil {
			return err
		}
		if !handler(id, payload) {
			return nil
		}
	}
}

// mkvClusterTimecode 读取 cluster payload 的首个 Timecode 元素
// （本封装器保证 Timecode 是第一个子元素），返回值与已消费字节数。
func mkvClusterTimecode(payload []byte) (uint64, int, error) {
	r := newByteReader(payload)
	id, err := ebmlReadID(r)
	if err != nil {
		return 0, 0, err
	}
	if id != mkvIDTimecode {
		return 0, 0, errors.New("cluster 缺少前置 Timecode")
	}
	size, unknown, err := ebmlReadSize(r)
	if err != nil || unknown {
		return 0, 0, errors.New("cluster Timecode 长度非法")
	}
	if size > 8 {
		return 0, 0, errors.New("cluster Timecode 过长")
	}
	var value uint64
	for i := uint64(0); i < size; i++ {
		b, err := r.ReadByte()
		if err != nil {
			return 0, 0, err
		}
		value = value<<8 | uint64(b)
	}
	return value, r.consumed, nil
}

/* ------------------------------------------------------------ 合并 / 校验 */

// mergeMKVSegments 把同一编码配置的多个分片无损合并成一个文件：
// 复用首片的 Tracks，Cluster 的 Timecode 依次加上前面分片的时长偏移。
func mergeMKVSegments(paths []string, durationsMS []int64, outPath string) error {
	if len(paths) == 0 || len(paths) != len(durationsMS) {
		return errors.New("合并参数不完整")
	}
	out, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer out.Close()
	w := bufio.NewWriterSize(out, 1<<20)
	header := ebmlElement(ebmlIDHeader, concatBytes(
		ebmlUint(ebmlIDVersion, 1),
		ebmlUint(ebmlIDReadVersion, 1),
		ebmlUint(ebmlIDMaxIDLength, 4),
		ebmlUint(ebmlIDMaxSizeLength, 8),
		ebmlString(ebmlIDDocType, "matroska"),
		ebmlUint(ebmlIDDocTypeVer, 2),
		ebmlUint(ebmlIDDocTypeRead, 2),
	))
	if _, err := w.Write(concatBytes(header, segmentStart())); err != nil {
		return err
	}

	var offset int64
	for index, path := range paths {
		in, openErr := os.Open(path)
		if openErr != nil {
			return openErr
		}
		var walkErr error
		err = mkvTopLevel(in, func(id uint32, payload []byte) bool {
			switch id {
			case mkvIDInfo:
				if index == 0 {
					total := int64(0)
					for _, d := range durationsMS {
						total += d
					}
					info := ebmlElement(mkvIDInfo, concatBytes(
						ebmlUint(mkvIDTimecodeScale, 1_000_000),
						ebmlFloat(mkvIDDuration, float64(total)),
						ebmlString(mkvIDMuxingApp, "DTV"),
						ebmlString(mkvIDWritingApp, "DTV"),
					))
					_, walkErr = w.Write(info)
				}
			case mkvIDTracks:
				if index == 0 {
					_, walkErr = w.Write(ebmlElement(mkvIDTracks, payload))
				}
			case mkvIDCluster:
				tc, consumed, tcErr := mkvClusterTimecode(payload)
				if tcErr != nil {
					walkErr = tcErr
					return false
				}
				merged := concatBytes(ebmlUint(mkvIDTimecode, uint64(int64(tc)+offset)), payload[consumed:])
				_, walkErr = w.Write(ebmlElement(mkvIDCluster, merged))
			}
			return walkErr == nil
		})
		_ = in.Close()
		if err == nil {
			err = walkErr
		}
		if err != nil {
			return fmt.Errorf("读取分片 %s 失败：%w", path, err)
		}
		offset += durationsMS[index]
	}
	if err := w.Flush(); err != nil {
		return err
	}
	return out.Sync()
}

// validateMKV 重新解析合并结果：统计 SimpleBlock 数与最大时间戳。
// 结构不完整 / 帧数不足时返回错误，调用方据此保留原分片。
func validateMKV(path string, expectBlocks int) (int64, error) {
	in, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	blocks := 0
	var maxTS int64
	tracksSeen := false
	var walkErr error
	err = mkvTopLevel(in, func(id uint32, payload []byte) bool {
		switch id {
		case mkvIDTracks:
			tracksSeen = true
		case mkvIDCluster:
			tc, consumed, tcErr := mkvClusterTimecode(payload)
			if tcErr != nil {
				walkErr = tcErr
				return false
			}
			r := newByteReader(payload[consumed:])
			for {
				blockID, idErr := ebmlReadID(r)
				if idErr == io.EOF {
					break
				}
				if idErr != nil {
					walkErr = idErr
					return false
				}
				size, unknown, sizeErr := ebmlReadSize(r)
				if sizeErr != nil || unknown {
					walkErr = errors.New("cluster 子元素长度非法")
					return false
				}
				if blockID == mkvIDSimpleBlock && size >= 3 {
					blocks++
					var head [3]byte
					if _, readErr := io.ReadFull(r, head[:]); readErr == nil {
						rel := int64(int16(uint16(head[1])<<8 | uint16(head[2])))
						if ts := int64(tc) + rel; ts > maxTS {
							maxTS = ts
						}
					}
					if _, skipErr := io.CopyN(io.Discard, r, int64(size)-3); skipErr != nil {
						walkErr = skipErr
						return false
					}
					continue
				}
				if _, skipErr := io.CopyN(io.Discard, r, int64(size)); skipErr != nil {
					walkErr = skipErr
					return false
				}
			}
		}
		return true
	})
	if err == nil {
		err = walkErr
	}
	if err != nil {
		return 0, err
	}
	if !tracksSeen || blocks == 0 {
		return 0, errors.New("合并结果缺少轨道或帧数据")
	}
	if expectBlocks > 0 && blocks < expectBlocks {
		return 0, fmt.Errorf("合并结果帧数不足：%d < %d", blocks, expectBlocks)
	}
	return maxTS, nil
}

// countMKVBlocks 统计分片里的 SimpleBlock 数（合并校验的期望值）。
func countMKVBlocks(path string) (int, error) {
	in, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	blocks := 0
	var walkErr error
	err = mkvTopLevel(in, func(id uint32, payload []byte) bool {
		if id != mkvIDCluster {
			return true
		}
		_, consumed, tcErr := mkvClusterTimecode(payload)
		if tcErr != nil {
			walkErr = tcErr
			return false
		}
		r := newByteReader(payload[consumed:])
		for {
			blockID, idErr := ebmlReadID(r)
			if idErr == io.EOF {
				break
			}
			if idErr != nil {
				walkErr = idErr
				return false
			}
			size, unknown, sizeErr := ebmlReadSize(r)
			if sizeErr != nil || unknown {
				walkErr = errors.New("cluster 子元素长度非法")
				return false
			}
			if blockID == mkvIDSimpleBlock {
				blocks++
			}
			if _, skipErr := io.CopyN(io.Discard, r, int64(size)); skipErr != nil {
				walkErr = skipErr
				return false
			}
		}
		return true
	})
	if err == nil {
		err = walkErr
	}
	return blocks, err
}
