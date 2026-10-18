package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type kokoroClient struct {
	url, token string
	client     *http.Client
	sem        chan struct{}
	retryEvery time.Duration
}
type kokoroRequest struct {
	Text   string  `json:"text"`
	Voice  string  `json:"voice"`
	Speed  float64 `json:"speed"`
	Format string  `json:"format"`
}

func newKokoroClient() *kokoroClient {
	return &kokoroClient{url: strings.TrimRight(os.Getenv("KOKORO_WORKER_URL"), "/"), token: os.Getenv("KOKORO_WORKER_TOKEN"), client: &http.Client{Timeout: 95 * time.Second}, sem: make(chan struct{}, speakConcurrency), retryEvery: 2 * time.Second}
}
func (k *kokoroClient) synthesize(ctx context.Context, text, voice string, speed float64) ([]byte, error) {
	if k == nil || k.url == "" {
		return nil, fmt.Errorf("kokoro is not configured")
	}
	select {
	case k.sem <- struct{}{}:
		defer func() { <-k.sem }()
	case <-time.After(120 * time.Second):
		return nil, fmt.Errorf("kokoro worker busy")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	body, err := json.Marshal(kokoroRequest{Text: text, Voice: voice, Speed: speed, Format: "mp3"})
	if err != nil {
		return nil, err
	}
	// The worker sleeps when idle. Waking it and loading the model takes about half a minute,
	// during which requests fail to connect or get a 502, so those are retried until the deadline.
	for {
		audio, retry, err := k.post(ctx, body)
		if err == nil || !retry {
			return audio, err
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("%w (last error: %v)", ctx.Err(), err)
		case <-time.After(k.retryEvery):
		}
	}
}

// wake asks the worker's health check until it answers, which starts a sleeping worker without using its CPU.
func (k *kokoroClient) wake(ctx context.Context) error {
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, k.url+"/healthz", nil)
		if err != nil {
			return err
		}
		resp, err := k.client.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(k.retryEvery):
		}
	}
}

// post sends one synthesize request. retry reports whether the failure looks like a waking worker.
func (k *kokoroClient) post(ctx context.Context, body []byte) (audio []byte, retry bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, k.url+"/synthesize", bytes.NewReader(body))
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Content-Type", "application/json")
	if k.token != "" {
		req.Header.Set("X-Worker-Token", k.token)
	}
	resp, err := k.client.Do(req)
	if err != nil {
		return nil, ctx.Err() == nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, resp.StatusCode == http.StatusBadGateway || resp.StatusCode == http.StatusServiceUnavailable,
			fmt.Errorf("kokoro HTTP %d: %s", resp.StatusCode, b)
	}
	audio, err = io.ReadAll(resp.Body)
	return audio, false, err
}
