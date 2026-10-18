package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCORSAllowsListedOriginOnly(t *testing.T) {
	h := withCORS("http://localhost:5173, http://127.0.0.1:5173", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))

	pre := httptest.NewRequest(http.MethodOptions, "/v1/speech", nil)
	pre.Header.Set("Origin", "http://localhost:5173")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, pre)
	if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Origin") != "http://localhost:5173" {
		t.Fatalf("preflight: %d %q", rec.Code, rec.Header().Get("Access-Control-Allow-Origin"))
	}

	other := httptest.NewRequest(http.MethodGet, "/v1/voices", nil)
	other.Header.Set("Origin", "https://evil.example")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, other)
	if rec.Code != http.StatusTeapot || rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("unlisted origin: %d %q", rec.Code, rec.Header().Get("Access-Control-Allow-Origin"))
	}
}
