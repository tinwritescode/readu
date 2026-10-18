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
}
type kokoroRequest struct {
	Text   string  `json:"text"`
	Voice  string  `json:"voice"`
	Speed  float64 `json:"speed"`
	Format string  `json:"format"`
}

func newKokoroClient() *kokoroClient {
	return &kokoroClient{url: strings.TrimRight(os.Getenv("KOKORO_WORKER_URL"), "/"), token: os.Getenv("KOKORO_WORKER_TOKEN"), client: &http.Client{Timeout: 95 * time.Second}, sem: make(chan struct{}, 1)}
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
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, k.url+"/synthesize", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if k.token != "" {
		req.Header.Set("X-Worker-Token", k.token)
	}
	resp, err := k.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("kokoro HTTP %d: %s", resp.StatusCode, b)
	}
	return io.ReadAll(resp.Body)
}
