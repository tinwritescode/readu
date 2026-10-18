package main

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

type fakeTranslator struct{ calls atomic.Int32 }

func (f *fakeTranslator) translate(_ context.Context, req translateRequest) (translateResult, error) {
	f.calls.Add(1)
	out := make([]string, len(req.Lines))
	for i, l := range req.Lines {
		out[i] = "vi:" + l.Text
	}
	return translateResult{Lines: out, Terms: []term{{EN: "Two", VI: "Hai"}}}, nil
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
	d := newDubService(db, tr, speak, nil)
	ctx := context.Background()

	req := testDubRequest()
	id, err := d.store.upsert(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if again, err := d.store.upsert(ctx, testDubRequest()); err != nil || again != id {
		t.Fatalf("same captions should reuse dub %d, got %d, %v", id, again, err)
	}

	d.jobs.touch(id, req.Voice, 0, 1)
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
	if tr.calls.Load() != 1 {
		// The first batch the viewer waits on holds up to 8 sentences, so 3 go in one call.
		t.Fatalf("translator called %d times, want 1", tr.calls.Load())
	}
	if _, _, glossary, err := d.store.context(ctx, id); err != nil || len(glossary) != 1 || glossary[0].VI != "Hai" {
		t.Fatalf("glossary %+v, %v", glossary, err)
	}
	audio, err := d.store.audio(ctx, id, 1, req.Voice)
	if err != nil || string(audio) != "duc_an:vi:Two." {
		t.Fatalf("audio %q, %v", audio, err)
	}
}

func TestDubQuotaCountsListenedMinutes(t *testing.T) {
	a, sender, _ := newTestAuth(t)
	d := newDubService(a.db, &fakeTranslator{}, nil, nil)
	ctx := context.Background()
	r, _ := loginAs(t, a, sender, "dub@example.com")
	acc, ok := a.sessionAccount(r)
	if !ok {
		t.Fatal("no account")
	}
	id, err := d.store.upsert(ctx, testDubRequest()) // three sentences of 1 s each
	if err != nil {
		t.Fatal(err)
	}

	const limit = 1500 // ms
	if err := d.store.chargeListen(ctx, acc, id, 0, limit); err != nil {
		t.Fatal(err)
	}
	if err := d.store.chargeListen(ctx, acc, id, 0, limit); err != nil {
		t.Fatalf("hearing a sentence again should be free: %v", err)
	}
	if err := d.store.chargeListen(ctx, acc, id, 1, limit); err != nil {
		t.Fatalf("1 s used of 1.5 s: %v", err)
	}
	if err := d.store.chargeListen(ctx, acc, id, 2, limit); !errors.Is(err, errQuotaExceeded) {
		t.Fatalf("want quota error after 2 s, got %v", err)
	}
	if used, err := d.store.usedTodayMs(ctx, acc.UserID); err != nil || used != 2000 {
		t.Fatalf("used %d ms, %v", used, err)
	}
	acc.Plan = "pro"
	if err := d.store.chargeListen(ctx, acc, id, 2, limit); err != nil {
		t.Fatalf("paid plan is not limited: %v", err)
	}
}
