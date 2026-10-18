package main

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"vtts-backend/dub"
)

type fakeTranslator struct{ calls atomic.Int32 }

func (f *fakeTranslator) Translate(_ context.Context, req dub.TranslateRequest) (dub.TranslateResult, error) {
	f.calls.Add(1)
	out := make([]string, len(req.Lines))
	for i, l := range req.Lines {
		out[i] = "vi:" + l.Text
	}
	return dub.TranslateResult{Lines: out, Terms: []dub.Term{{EN: "Two", VI: "Hai"}}}, nil
}

func testDubRequest() *dub.Request {
	r := &dub.Request{VideoID: "dQw4w9WgXcQ", Voice: "duc_an", Segments: []dub.SegmentInput{
		{Start: 0, End: 1000, Text: "One."},
		{Start: 1000, End: 2000, Text: "Two."},
		{Start: 2000, End: 3000, Text: "Three."},
	}}
	if err := r.Validate(); err != nil {
		panic(err)
	}
	return r
}

func TestDubJobTranslatesAndSpeaksEverySegment(t *testing.T) {
	store := dub.NewPGStore(testDB(t))
	tr := &fakeTranslator{}
	speak := func(_ context.Context, text, voice string) ([]byte, error) {
		return []byte(voice + ":" + text), nil
	}
	d := dub.New(store, tr, speak, nil, dub.Limits{"free": defaultFreeDailyMinutes})
	ctx := context.Background()

	req := testDubRequest()
	id, err := store.Upsert(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if again, err := store.Upsert(ctx, testDubRequest()); err != nil || again != id {
		t.Fatalf("same captions should reuse dub %d, got %d, %v", id, again, err)
	}

	if err := d.Poll(ctx, id, req.Voice, 0, 1); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	var st dub.Status
	for time.Now().Before(deadline) {
		if st, err = d.Status(ctx, id, req.Voice); err != nil {
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
	if _, _, glossary, err := store.VideoContext(ctx, id); err != nil || len(glossary) != 1 || glossary[0].VI != "Hai" {
		t.Fatalf("glossary %+v, %v", glossary, err)
	}
	audio, err := store.Audio(ctx, id, 1, req.Voice)
	if err != nil || string(audio) != "duc_an:vi:Two." {
		t.Fatalf("audio %q, %v", audio, err)
	}
	if err := d.Poll(ctx, id+1000, req.Voice, 0, 1); !errors.Is(err, dub.ErrNotFound) {
		t.Fatalf("unknown dub: %v", err)
	}
}

func TestDubQuotaCountsListenedMinutes(t *testing.T) {
	a, sender, _ := newTestAuth(t)
	store := dub.NewPGStore(a.db)
	ctx := context.Background()
	r, _ := loginAs(t, a, sender, "dub@example.com")
	acc, ok := a.sessionAccount(r)
	if !ok {
		t.Fatal("no account")
	}
	id, err := store.Upsert(ctx, testDubRequest()) // three sentences of 1 s each
	if err != nil {
		t.Fatal(err)
	}

	const limit = 1500 // ms
	if err := store.ChargeListen(ctx, acc.UserID, id, 0, limit); err != nil {
		t.Fatal(err)
	}
	if err := store.ChargeListen(ctx, acc.UserID, id, 0, limit); err != nil {
		t.Fatalf("hearing a sentence again should be free: %v", err)
	}
	if err := store.ChargeListen(ctx, acc.UserID, id, 1, limit); err != nil {
		t.Fatalf("1 s used of 1.5 s: %v", err)
	}
	if err := store.ChargeListen(ctx, acc.UserID, id, 2, limit); !errors.Is(err, dub.ErrQuotaExceeded) {
		t.Fatalf("want quota error after 2 s, got %v", err)
	}
	if used, err := store.UsedTodayMs(ctx, acc.UserID); err != nil || used != 2000 {
		t.Fatalf("used %d ms, %v", used, err)
	}

	// Through the service: a free account with no minutes left is refused, an unlimited plan is not counted.
	d := dub.New(store, &fakeTranslator{}, nil, nil, dub.Limits{"free": 0, "premium": 300, "max": dub.Unlimited})
	if err := store.SaveAudio(ctx, id, 2, "duc_an", []byte("mp3")); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Listen(ctx, dubAccount(acc), id, 2, "duc_an"); !errors.Is(err, dub.ErrQuotaExceeded) {
		t.Fatalf("free account over quota: %v", err)
	}
	acc.Plan = "pro" // not a plan: gets the free allowance
	if _, err := d.Listen(ctx, dubAccount(acc), id, 2, "duc_an"); !errors.Is(err, dub.ErrQuotaExceeded) {
		t.Fatalf("unknown plan should be limited like free: %v", err)
	}
	acc.Plan = "max"
	if audio, err := d.Listen(ctx, dubAccount(acc), id, 2, "duc_an"); err != nil || string(audio) != "mp3" {
		t.Fatalf("max is not limited: %q, %v", audio, err)
	}
	if used, limit, err := d.Quota(ctx, dub.Account{UserID: acc.UserID, Plan: "premium"}); err != nil || used != 2 || limit != 300*60 {
		t.Fatalf("premium quota %d/%d, %v", used, limit, err)
	}
	if _, limit, _ := d.Quota(ctx, dubAccount(acc)); limit != dub.Unlimited {
		t.Fatalf("max quota limit %d", limit)
	}
	if _, err := d.Listen(ctx, dubAccount(acc), id, 0, "duc_an"); !errors.Is(err, dub.ErrNotReady) {
		t.Fatalf("missing audio: %v", err)
	}
}

func TestSetPlan(t *testing.T) {
	a, sender, clock := newTestAuth(t)
	ctx := context.Background()
	r, _ := loginAs(t, a, sender, "max@example.com")

	if err := a.setPlan(ctx, "max@example.com", "gold", nil); !errors.Is(err, errNoSuchPlan) {
		t.Fatalf("unknown plan: %v", err)
	}
	if err := a.setPlan(ctx, "max@example.com", "max", nil); err != nil {
		t.Fatal(err)
	}
	if acc, ok := a.sessionAccount(r); !ok || acc.Plan != "max" {
		t.Fatalf("after upgrade %+v %v", acc, ok)
	}

	// An email that never signed in gets its plan on the first sign-in.
	until := clock.t.Add(24 * time.Hour)
	if err := a.setPlan(ctx, "new@example.com", "premium", &until); err != nil {
		t.Fatal(err)
	}
	r2, _ := loginAs(t, a, sender, "new@example.com")
	if acc, _ := a.sessionAccount(r2); acc.Plan != "premium" {
		t.Fatalf("new account plan %q", acc.Plan)
	}
	// Once the plan ends the account is free again.
	clock.t = until.Add(time.Minute)
	if acc, _ := a.sessionAccount(r2); acc.Plan != "free" {
		t.Fatalf("expired plan still %q", acc.Plan)
	}
}
