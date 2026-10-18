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
	got, err := parseTranslation("```json\n{\"lines\":[{\"n\":2,\"vi\":\"hai\"},{\"n\":1,\"vi\":\" một \"}]}\n```", 2)
	if err != nil || got[0] != "một" || got[1] != "hai" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := parseTranslation(`{"lines":[{"n":1,"vi":"một"}]}`, 2); err == nil {
		t.Fatal("want error for a missing line")
	}
}

func TestChatTranslatorSendsBatch(t *testing.T) {
	var got struct {
		Model    string        `json:"model"`
		Messages []chatMessage `json:"messages"`
	}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer k" {
			http.Error(w, "bad", http.StatusUnauthorized)
			return
		}
		json.NewDecoder(r.Body).Decode(&got)
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{
			"role": "assistant", "content": `{"lines":[{"n":1,"vi":"Xin chào"}]}`,
		}}}})
	}))
	defer api.Close()

	tr := &chatTranslator{baseURL: api.URL + "/v1", apiKey: "k", model: "m", client: api.Client()}
	out, err := tr.translate(context.Background(), []string{"Before"}, []string{"Hello"})
	if err != nil || len(out) != 1 || out[0] != "Xin chào" {
		t.Fatalf("got %q, %v", out, err)
	}
	if got.Model != "m" || !strings.Contains(got.Messages[1].Content, "Before") || !strings.Contains(got.Messages[1].Content, "1. Hello") {
		t.Fatalf("request %+v", got)
	}
}

// TestChatTranslatorLive calls the real endpoint. Run with TRANSLATE_LIVE=1 and the TRANSLATE_* variables set.
func TestChatTranslatorLive(t *testing.T) {
	if os.Getenv("TRANSLATE_LIVE") == "" {
		t.Skip("set TRANSLATE_LIVE=1 to call the real translation API")
	}
	tr := newChatTranslator()
	if tr == nil {
		t.Fatal("TRANSLATE_BASE_URL and TRANSLATE_API_KEY must be set")
	}
	out, err := tr.translate(context.Background(), nil, []string{
		"Today we're going to build a tiny web server in Go.",
		"It only takes about twenty lines of code",
		"so let's get started.",
	})
	if err != nil {
		t.Fatal(err)
	}
	for i, l := range out {
		t.Logf("%d: %s", i+1, l)
	}
}
