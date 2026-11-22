package bilibili

import "testing"

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