package main

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

type fakeTranslator struct{ calls atomic.Int32 }

func (f *fakeTranslator) translate(_ context.Context, _, lines []string) ([]string, error) {
	f.calls.Add(1)
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = "vi:" + l
	}
	return out, nil
}

func testDubRequest() *dubRequest {
	r := &dubRequest{VideoID: "dQw4w9WgXcQ", Voice: "duc_an", Segments: []dubSegmentInput{
		{Start: 0, End: 1000, Text: "One."},
		{Start: 1000, End: 2000, Text: "Two."},
		{Start: 2000, End: 3000, Text: "Three."},
	}}
	if err := r.validate(); err != nil {
		panic(err)
	}
	return r
}

func TestDubJobTranslatesAndSpeaksEverySegment(t *testing.T) {
	db := testDB(t)
	tr := &fakeTranslator{}
	speak := func(_ context.Context, text, voice string) ([]byte, error) {
		return []byte(voice + ":" + text), nil
	}
	d := newDubService(db, tr, speak)
	ctx := context.Background()

	req := testDubRequest()
	id, err := d.store.upsert(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if again, err := d.store.upsert(ctx, testDubRequest()); err != nil || again != id {
		t.Fatalf("same captions should reuse dub %d, got %d, %v", id, again, err)
	}

	d.jobs.touch(id, req.Voice, 1500)
	deadline := time.Now().Add(5 * time.Second)
	var st dubStatus
	for time.Now().Before(deadline) {
		if st, err = d.status(ctx, id, req.Voice); err != nil {
			t.Fatal(err)
		}
		if st.Stage == "done" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if st.Stage != "done" || len(st.Ready) != 3 || st.Translated != 3 {
		t.Fatalf("status %+v", st)
	}
	if tr.calls.Load() != 2 {
		// Starting at 1.5s translates sentences 1-2 first, then wraps to sentence 0.
		t.Fatalf("translator called %d times, want 2", tr.calls.Load())
	}
	audio, err := d.store.audio(ctx, id, 1, req.Voice)
	if err != nil || string(audio) != "duc_an:vi:Two." {
		t.Fatalf("audio %q, %v", audio, err)
	}
}

func TestDubQuotaCountsVideosPerDay(t *testing.T) {
	a, sender, _ := newTestAuth(t)
	d := newDubService(a.db, &fakeTranslator{}, nil)
	ctx := context.Background()
	r, _ := loginAs(t, a, sender, "dub@example.com")
	acc, ok := a.sessionAccount(r)
	if !ok {
		t.Fatal("no account")
	}

	first, err := d.store.upsert(ctx, testDubRequest())
	if err != nil {
		t.Fatal(err)
	}
	other := testDubRequest()
	other.VideoID = "aaaaaaaaaaa"
	second, err := d.store.upsert(ctx, other)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.store.chargeQuota(ctx, acc, first, 1); err != nil {
		t.Fatal(err)
	}
	if err := d.store.chargeQuota(ctx, acc, first, 1); err != nil {
		t.Fatalf("reopening a counted video should be free: %v", err)
	}
	if err := d.store.chargeQuota(ctx, acc, second, 1); !errors.Is(err, errQuotaExceeded) {
		t.Fatalf("want quota error, got %v", err)
	}
	acc.Plan = "pro"
	if err := d.store.chargeQuota(ctx, acc, second, 1); err != nil {
		t.Fatalf("paid plan is not limited: %v", err)
	}
	if used, err := d.store.usedToday(ctx, acc.UserID); err != nil || used != 1 {
		t.Fatalf("used %d, %v", used, err)
	}
}
