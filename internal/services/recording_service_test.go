package services

import (
	"path/filepath"
	"testing"

	"dtv/internal/platforms/common"
)

func TestPickRecordingVariant(t *testing.T) {
	variants := []common.StreamVariant{
		{ID: "0", Label: "原画", URL: "https://x/or.flv", Format: "flv"},
		{ID: "4", Label: "蓝光4M", URL: "https://x/4.flv", Format: "flv"},
		{ID: "3", Label: "超清", URL: "https://x/3.flv", Format: "flv"},
		{ID: "2", Label: "高清", URL: "https://x/2.flv", Format: "flv"},
		{ID: "hls", Label: "原画HLS", URL: "https://x/or.m3u8", Format: "hls"},
	}
	cases := []struct {
		target string
		wantID string
	}{
		{"best", "0"},
		{"high", "4"},
		{"medium", "2"},
		{"low", "2"},
		{"unknown", "0"},
	}
	for _, c := range cases {
		got := pickRecordingVariant(variants, c.target)
		if got == nil || got.ID != c.wantID {
			t.Errorf("pickRecordingVariant(%s) = %v, want %s", c.target, got, c.wantID)
		}
	}
	if got := pickRecordingVariant([]common.StreamVariant{{Format: "hls", URL: "x.m3u8"}}, "best"); got != nil {
		t.Errorf("HLS-only variants should be rejected, got %v", got)
	}
}

func TestRecordingStartLimits(t *testing.T) {
	root := t.TempDir()
	t.Setenv("APPDATA", filepath.Join(root, "roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(root, "local"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "xdg-config"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(root, "xdg-cache"))

	gate := make(chan struct{})
	svc := NewRecordingService(nil, func(platform, roomID string) (*common.StreamInfo, error) {
		<-gate // 让任务停留在 recording 状态
		return nil, errStreamOffline
	})
	defer func() {
		close(gate)
		_ = svc.ServiceShutdown()
	}()

	for i := 0; i < recordingMaxConcurrent; i++ {
		if _, err := svc.Start("douyu", string(rune('1'+i)), "best"); err != nil {
			t.Fatalf("Start #%d error = %v", i+1, err)
		}
	}
	if _, err := svc.Start("douyu", "9", "best"); err == nil {
		t.Fatal("5th concurrent recording should be rejected")
	}
	if _, err := svc.Start("douyu", "1", "best"); err == nil {
		t.Fatal("duplicate room recording should be rejected")
	}
	if _, err := svc.Start("twitch", "1", "best"); err == nil {
		t.Fatal("unsupported platform should be rejected")
	}
}

func TestRecordingSettingsRoundtrip(t *testing.T) {
	root := t.TempDir()
	t.Setenv("APPDATA", filepath.Join(root, "roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(root, "local"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "xdg-config"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(root, "xdg-cache"))

	svc := NewRecordingService(nil, nil)
	defer func() { _ = svc.ServiceShutdown() }()
	want := RecordingSettings{
		SaveDir:       filepath.Join(root, "records"),
		AutoMerge:     true,
		NotifyOnError: false,
	}
	if err := svc.UpdateSettings(want); err != nil {
		t.Fatalf("UpdateSettings() error = %v", err)
	}
	if got := svc.GetSettings(); got != want {
		t.Fatalf("GetSettings() = %+v, want %+v", got, want)
	}
	reloaded := loadRecordingSettings()
	if reloaded != want {
		t.Fatalf("loadRecordingSettings() = %+v, want %+v", reloaded, want)
	}
}
