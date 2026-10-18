package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestKokoroSynthesizeSendsTokenAndRequest(t *testing.T) {
	var got kokoroRequest
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/synthesize" || r.Header.Get("X-Worker-Token") != "secret" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		json.NewDecoder(r.Body).Decode(&got)
		w.Write([]byte("mp3"))
	}))
	defer worker.Close()

	k := &kokoroClient{url: worker.URL, token: "secret", client: worker.Client(), sem: make(chan struct{}, 1)}
	audio, err := k.synthesize(context.Background(), "Xin chào", "mai_loan", 1.2)
	if err != nil || string(audio) != "mp3" {
		t.Fatalf("audio %q, err %v", audio, err)
	}
	if got != (kokoroRequest{Text: "Xin chào", Voice: "mai_loan", Speed: 1.2, Format: "mp3"}) {
		t.Fatalf("worker got %+v", got)
	}
}

func TestKokoroSynthesizeReportsWorkerError(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer worker.Close()

	k := &kokoroClient{url: worker.URL, client: worker.Client(), sem: make(chan struct{}, 1)}
	if _, err := k.synthesize(context.Background(), "a", "mai_loan", 1); err == nil {
		t.Fatal("want error for HTTP 500")
	}
}

func TestKokoroRetriesWhileWorkerWakes(t *testing.T) {
	calls := 0
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 3 {
			http.Error(w, "waking", http.StatusBadGateway)
			return
		}
		w.Write([]byte("mp3"))
	}))
	defer worker.Close()

	k := &kokoroClient{url: worker.URL, client: worker.Client(), sem: make(chan struct{}, 1), retryEvery: time.Millisecond}
	audio, err := k.synthesize(context.Background(), "a", "mai_loan", 1)
	if err != nil || string(audio) != "mp3" || calls != 3 {
		t.Fatalf("audio %q, err %v, calls %d", audio, err, calls)
	}
}

func TestKokoroDoesNotRetryBadRequest(t *testing.T) {
	calls := 0
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		http.Error(w, "voice is not available", http.StatusBadRequest)
	}))
	defer worker.Close()

	k := &kokoroClient{url: worker.URL, client: worker.Client(), sem: make(chan struct{}, 1), retryEvery: time.Millisecond}
	if _, err := k.synthesize(context.Background(), "a", "x", 1); err == nil || calls != 1 {
		t.Fatalf("err %v, calls %d", err, calls)
	}
}

func TestKokoroUnconfigured(t *testing.T) {
	if _, err := (&kokoroClient{}).synthesize(context.Background(), "a", "mai_loan", 1); err == nil {
		t.Fatal("want error when KOKORO_WORKER_URL is empty")
	}
}
