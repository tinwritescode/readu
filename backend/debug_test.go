package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testKey = "ab" + "cdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

// newDebugServer serves the debug routes over a temp cache holding one labelled chunk.
func newDebugServer(t *testing.T, token string) (*http.ServeMux, string) {
	t.Helper()
	dir := t.TempDir()
	s := &server{cacheDir: dir, debugToken: token}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/debug/cache", s.handleDebugList)
	mux.HandleFunc("DELETE /v1/debug/cache", s.handleDebugClear)
	mux.HandleFunc("DELETE /v1/debug/cache/{key}", s.handleDebugDeleteOne)

	path := filepath.Join(dir, testKey[:2], testKey+".mp3")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("mp3"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeCacheMeta(path, "voice-a", 1, "Xin chào bệ hạ."); err != nil {
		t.Fatal(err)
	}
	return mux, dir
}

func call(mux *http.ServeMux, method, target, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestDebugRoutesHiddenWithoutToken(t *testing.T) {
	mux, _ := newDebugServer(t, "")
	if rec := call(mux, "GET", "/v1/debug/cache", "anything"); rec.Code != http.StatusNotFound {
		t.Fatalf("list without DEBUG_TOKEN = %d, want 404", rec.Code)
	}
}

func TestDebugRoutesRejectWrongToken(t *testing.T) {
	mux, _ := newDebugServer(t, "secret")
	if rec := call(mux, "GET", "/v1/debug/cache", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token = %d, want 401", rec.Code)
	}
	if rec := call(mux, "GET", "/v1/debug/cache", "wrong"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token = %d, want 401", rec.Code)
	}
}

func TestDebugListShowsLabelledEntries(t *testing.T) {
	mux, _ := newDebugServer(t, "secret")
	rec := call(mux, "GET", "/v1/debug/cache", "secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("list = %d", rec.Code)
	}
	var body struct {
		Count   int          `json:"count"`
		Bytes   int64        `json:"bytes"`
		Entries []cacheEntry `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Count != 1 || body.Bytes != 3 {
		t.Fatalf("count/bytes = %d/%d, want 1/3", body.Count, body.Bytes)
	}
	e := body.Entries[0]
	if e.Key != testKey || e.Voice != "voice-a" || e.Preview != "Xin chào bệ hạ." {
		t.Fatalf("entry = %+v", e)
	}
}

func TestDebugDeleteOneRemovesFilesAndRejectsBadKey(t *testing.T) {
	mux, dir := newDebugServer(t, "secret")
	if rec := call(mux, "DELETE", "/v1/debug/cache/not-a-key", "secret"); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad key = %d, want 400", rec.Code)
	}
	if rec := call(mux, "DELETE", "/v1/debug/cache/"+testKey, "secret"); rec.Code != http.StatusNoContent {
		t.Fatalf("delete = %d, want 204", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(dir, testKey[:2], testKey+".json")); !os.IsNotExist(err) {
		t.Fatalf("sidecar still present: %v", err)
	}
}

func TestDebugClearRemovesEverything(t *testing.T) {
	mux, dir := newDebugServer(t, "secret")
	if rec := call(mux, "DELETE", "/v1/debug/cache", "secret"); rec.Code != http.StatusNoContent {
		t.Fatalf("clear = %d, want 204", rec.Code)
	}
	rec := call(mux, "GET", "/v1/debug/cache", "secret")
	if !strings.Contains(rec.Body.String(), `"count":0`) {
		t.Fatalf("after clear: %s", rec.Body.String())
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*", "*"))
	if len(files) != 0 {
		t.Fatalf("files left: %v", files)
	}
}

func TestDebugListIsEmptyArrayNotNull(t *testing.T) {
	mux, _ := newDebugServer(t, "secret")
	call(mux, "DELETE", "/v1/debug/cache", "secret")
	rec := call(mux, "GET", "/v1/debug/cache", "secret")
	if !strings.Contains(rec.Body.String(), `"entries":[]`) {
		t.Fatalf("empty list should carry an empty array: %s", rec.Body.String())
	}
}
