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

func TestPickNextSegmentFollowsViewer(t *testing.T) {
	segs := []dubSegment{
		{idx: 0, start: 0, hasAudio: true},
		{idx: 1, start: 1000},
		{idx: 2, start: 2000},
		{idx: 3, start: 3000},
	}
	if got := pickNextSegment(segs, 2500, nil); got != 2 {
		t.Fatalf("from 2.5s: got %d, want the sentence playing then", got)
	}
	if got := pickNextSegment(segs, 3500, map[int]bool{3: true}); got != 1 {
		t.Fatalf("after the end: got %d, want wrap to first missing", got)
	}
	for i := range segs {
		segs[i].hasAudio = true
	}
	if got := pickNextSegment(segs, 0, nil); got != -1 {
		t.Fatalf("all done: got %d", got)
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
