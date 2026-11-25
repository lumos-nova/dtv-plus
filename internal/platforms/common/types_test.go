package common

import (
	"errors"
	"testing"
)

func TestCollectSearchPagesMergesAndDedups(t *testing.T) {
	pages := map[int][]SearchHit{
		1: {{ID: "a"}, {ID: "b"}},
		2: {{ID: "b"}, {ID: "c"}}, // b 与第一页重复
	}
	got, err := CollectSearchPages(func(page, _ int) ([]SearchHit, error) {
		return pages[page], nil
	}, 2, 20)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 3 || got[0].ID != "a" || got[1].ID != "b" || got[2].ID != "c" {
		t.Fatalf("expected a,b,c deduped in order, got %+v", got)
	}
}

func TestCollectSearchPagesFirstPageError(t *testing.T) {
	want := errors.New("boom")
	_, err := CollectSearchPages(func(int, int) ([]SearchHit, error) {
		return nil, want
	}, 2, 20)
	if !errors.Is(err, want) {
		t.Fatalf("expected first-page error to propagate, got %v", err)
	}
}

func TestCollectSearchPagesLaterPageErrorKeepsEarlier(t *testing.T) {
	got, err := CollectSearchPages(func(page int, _ int) ([]SearchHit, error) {
		if page == 1 {
			return []SearchHit{{ID: "a"}}, nil
		}
		return nil, errors.New("later fail")
	}, 2, 20)
	if err != nil {
		t.Fatalf("later-page error should be swallowed, got %v", err)
	}
	if len(got) != 1 || got[0].ID != "a" {
		t.Fatalf("expected earlier results kept, got %+v", got)
	}
}

func TestCollectSearchPagesStopsOnEmpty(t *testing.T) {
	calls := 0
	got, err := CollectSearchPages(func(int, int) ([]SearchHit, error) {
		calls++
		return []SearchHit{}, nil
	}, 3, 20)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if calls != 1 {
		t.Fatalf("expected stop after first empty page, calls=%d", calls)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty result, got %+v", got)
	}
}
