package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestDubRequestValidate(t *testing.T) {
	ok := dubRequest{VideoID: "dQw4w9WgXcQ", Voice: "nope", Segments: []dubSegmentInput{
		{Start: 0, End: 1000, Text: "  Hello\n there "},
		{Start: 1000, End: 2000, Text: "Bye"},
	}}
	if err := ok.validate(); err != nil {
		t.Fatal(err)
	}
	if ok.Segments[0].Text != "Hello there" || ok.Voice != defaultKokoroVoice {
		t.Fatalf("not cleaned: %+v", ok)
	}

	bad := []dubRequest{
		{VideoID: "short", Segments: ok.Segments},
		{VideoID: "dQw4w9WgXcQ"},
		{VideoID: "dQw4w9WgXcQ", Segments: []dubSegmentInput{{Start: 0, End: 1000, Text: " "}}},
		{VideoID: "dQw4w9WgXcQ", Segments: []dubSegmentInput{{Start: 500, End: 400, Text: "a"}}},
		{VideoID: "dQw4w9WgXcQ", Segments: []dubSegmentInput{{Start: 500, End: 900, Text: "a"}, {Start: 100, End: 900, Text: "b"}}},
	}
	for i, r := range bad {
		if err := r.validate(); err == nil {
			t.Errorf("case %d: want error", i)
		}
	}
}

// sentences makes n sentences of 3 s each, the first ready of them translated and spoken.
func sentences(n, ready, translated int) []dubSegment {
	segs := make([]dubSegment, n)
	for i := range segs {
		segs[i] = dubSegment{idx: i, start: i * 3000, end: i*3000 + 2500, translated: i < translated, hasAudio: i < ready}
	}
	return segs
}

func newTestJob() *dubJob {
	return &dubJob{speaking: map[int]bool{}, failures: map[int]int{}, filling: true}
}

func TestPlanStartsWithASmallBatchAtTheViewer(t *testing.T) {
	segs := sentences(200, 0, 0)
	p := planWork(segs, 30_000, 1, newTestJob(), nil)
	if p.translate != 10 || p.batch != firstBatch || len(p.speak) != 0 {
		t.Fatalf("plan %+v, want a first batch at sentence 10", p)
	}
}

func TestPlanSpeaksTwoAndTranslatesAhead(t *testing.T) {
	segs := sentences(200, 0, 8)
	p := planWork(segs, 0, 1, newTestJob(), nil)
	if len(p.speak) != speakConcurrency || p.speak[0] != 0 || p.speak[1] != 1 {
		t.Fatalf("speak %v", p.speak)
	}
	if p.translate != 8 || p.batch != translateBatch {
		t.Fatalf("translate %d batch %d, want the next 40 from 8", p.translate, p.batch)
	}
}

func TestPlanStaysInsideTheWindow(t *testing.T) {
	// 3 minutes of 3 s sentences is 60; at 1x nothing past sentence 59 is spoken, nothing past 99 translated.
	segs := sentences(200, 59, 200)
	job := newTestJob()
	p := planWork(segs, 0, 1, job, nil)
	if len(p.speak) != 1 || p.speak[0] != 59 {
		t.Fatalf("speak %v, want only sentence 59", p.speak)
	}
	segs = sentences(200, 60, 100)
	if p = planWork(segs, 0, 1, job, nil); !p.rest || job.filling {
		t.Fatalf("plan %+v filling %v, want rest with a full window", p, job.filling)
	}
	// 60 s later only 2 minutes are ready ahead: still above the 90 s refill mark, so it keeps resting.
	if p = planWork(segs, 60_000, 1, job, nil); !p.rest {
		t.Fatalf("plan %+v, want rest above the refill mark", p)
	}
	// At 100 s only 80 s are ready ahead: refill, speaking from sentence 60 and translating from 100.
	if p = planWork(segs, 100_000, 1, job, nil); p.rest || p.translate != 100 || len(p.speak) != 2 || p.speak[0] != 60 {
		t.Fatalf("plan %+v, want a refill", p)
	}
}

func TestPlanWindowGrowsWithPlaybackRate(t *testing.T) {
	segs := sentences(200, 59, 200)
	if p := planWork(segs, 0, 2, newTestJob(), nil); len(p.speak) != 2 || p.speak[0] != 59 {
		t.Fatalf("speak %v, want work past 3 minutes at 2x", p.speak)
	}
}

func TestPlanFollowsASeekAndSkipsFailures(t *testing.T) {
	segs := sentences(200, 0, 200)
	p := planWork(segs, 300_000, 1, newTestJob(), map[int]bool{100: true})
	if len(p.speak) != 2 || p.speak[0] != 101 || p.speak[1] != 102 {
		t.Fatalf("speak %v, want 101 and 102 after a seek to 5:00 with 100 failed", p.speak)
	}
}

func TestParseTranslation(t *testing.T) {
	got, err := parseTranslation("```json\n{\"lines\":[{\"n\":2,\"vi\":\"hai\"},{\"n\":1,\"vi\":\" một \"}],\"terms\":[{\"en\":\"Go\",\"vi\":\"Go\"},{\"en\":\" \",\"vi\":\"x\"}]}\n```", 2)
	if err != nil || got.Lines[0] != "một" || got.Lines[1] != "hai" || len(got.Terms) != 1 {
		t.Fatalf("got %+v, %v", got, err)
	}
	if _, err := parseTranslation(`{"lines":[{"n":1,"vi":"một"}]}`, 2); err == nil {
		t.Fatal("want error for a missing line")
	}
}

func TestChatTranslatorRetriesAndShortens(t *testing.T) {
	var prompts []string
	replies := []string{
		`{"lines":[{"n":1,"vi":"Xin chào"}]}`, // line 2 missing: retried
		`{"lines":[{"n":1,"vi":"Xin chào"},{"n":2,"vi":"một hai ba bốn năm sáu bảy tám chín mười mười một mười hai"}],"terms":[{"en":"Go","vi":"Go"}]}`,
		`{"lines":[{"n":1,"vi":"ngắn gọn"}]}`, // the shortening pass for line 2
	}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer k" {
			http.Error(w, "bad", http.StatusUnauthorized)
			return
		}
		var got struct {
			Messages []chatMessage `json:"messages"`
		}
		json.NewDecoder(r.Body).Decode(&got)
		prompts = append(prompts, got.Messages[1].Content)
		reply := replies[min(len(prompts), len(replies))-1]
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"role": "assistant", "content": reply}}}})
	}))
	defer api.Close()

	tr := &chatTranslator{baseURL: api.URL + "/v1", apiKey: "k", model: "m", client: api.Client()}
	res, err := tr.translate(context.Background(), translateRequest{
		Title:    "Learn Go",
		Glossary: []term{{EN: "goroutine", VI: "goroutine"}},
		Prior:    []string{"Before => Trước"},
		Lines:    []translateLine{{Text: "Hello", Seconds: 2}, {Text: "Let's count to twelve", Seconds: 1}},
	})
	if err != nil || res.Lines[0] != "Xin chào" || res.Lines[1] != "ngắn gọn" || len(res.Terms) != 1 {
		t.Fatalf("got %+v, %v", res, err)
	}
	if len(prompts) != 3 {
		t.Fatalf("%d requests, want translate, retry, shorten", len(prompts))
	}
	for _, want := range []string{"Video title: Learn Go", "- goroutine => goroutine", "Before => Trước", "1. [2.0s, ≤9 âm tiết] Hello"} {
		if !strings.Contains(prompts[0], want) {
			t.Fatalf("prompt lacks %q:\n%s", want, prompts[0])
		}
	}
	if !strings.Contains(prompts[2], "EN: Let's count to twelve") {
		t.Fatalf("shorten prompt:\n%s", prompts[2])
	}
}

func TestMergeGlossaryKeepsFirstChoice(t *testing.T) {
	g := mergeGlossary([]term{{EN: "Go", VI: "Go"}}, []term{{EN: "go", VI: "đi"}, {EN: "channel", VI: "kênh"}})
	if len(g) != 2 || g[0].VI != "Go" || g[1].EN != "channel" {
		t.Fatalf("got %+v", g)
	}
}

// TestChatTranslatorSample translates a short auto-caption excerpt with the real API, for judging quality by eye.
// Run with TRANSLATE_LIVE=1 and the TRANSLATE_* variables set.
func TestChatTranslatorSample(t *testing.T) {
	if os.Getenv("TRANSLATE_LIVE") == "" {
		t.Skip("set TRANSLATE_LIVE=1 to call the real translation API")
	}
	tr := newChatTranslator()
	if tr == nil {
		t.Fatal("TRANSLATE_BASE_URL and TRANSLATE_API_KEY must be set")
	}
	req := translateRequest{Title: "I built a tiny web server in Go (in 20 lines)"}
	for _, l := range sampleCaptions {
		req.Lines = append(req.Lines, translateLine{Text: l.text, Seconds: l.seconds})
	}
	res, err := tr.translate(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	for i, l := range res.Lines {
		t.Logf("%d. [%.1fs] %s\n   => %s (%d âm tiết)", i+1, sampleCaptions[i].seconds, sampleCaptions[i].text, l, syllables(l))
	}
	t.Logf("terms: %+v", res.Terms)
}

// sampleCaptions reads like YouTube auto captions of a coding vlog: no punctuation, run-on, filler words.
var sampleCaptions = []struct {
	text    string
	seconds float64
}{
	{"hey everyone welcome back to the channel so today we're going to do something kind of fun", 4.2},
	{"we're going to build a web server in go and it's literally like twenty lines of code", 3.6},
	{"if you've never touched go before don't worry I'll walk you through every single line", 3.4},
	{"so first thing we need is the net http package which comes with the standard library", 3.5},
	{"you don't have to install anything which is honestly one of my favorite things about go", 3.3},
	{"then we register a handler function and call listen and serve on port eight thousand eighty", 3.9},
	{"and that's it we've got a server running pretty cool right", 2.4},
}
