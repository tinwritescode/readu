package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

const (
	vbeeVoicesURL = "https://vbee.vn/api/public/v1/voices"
	voicesTTL     = time.Hour
)

type voice struct {
	Code   string `json:"code"`
	Name   string `json:"name"`
	Gender string `json:"gender"`
}

// voiceCatalog caches the Vbee Vietnamese voice list. Voices change rarely,
// so one fetch an hour is enough.
type voiceCatalog struct {
	mu      sync.Mutex
	vbee    *vbeeClient
	voices  []voice
	fetched time.Time
}

func (c *voiceCatalog) get(ctx context.Context) ([]voice, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.voices != nil && time.Since(c.fetched) < voicesTTL {
		return c.voices, nil
	}
	voices, err := c.vbee.listVoices(ctx)
	if err != nil {
		return nil, err
	}
	c.voices, c.fetched = voices, time.Now()
	return voices, nil
}

// listVoices returns every Vietnamese Vbee voice. The endpoint is paginated,
// but 100 is more than the catalog holds, so one page is read.
func (v *vbeeClient) listVoices(ctx context.Context) ([]voice, error) {
	q := url.Values{}
	q.Set("voiceOwnership", "VBEE")
	q.Set("languageCode", "vi-VN")
	q.Set("limit", "100")

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, vbeeVoicesURL+"?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("App-Id", v.appID)
	req.Header.Set("Authorization", "Bearer "+v.token)

	resp, err := v.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("vbee voices: HTTP %d", resp.StatusCode)
	}

	var body struct {
		Result struct {
			Voices []voice `json:"voices"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &body); err != nil {
		return nil, fmt.Errorf("vbee voices: %w", err)
	}
	if len(body.Result.Voices) == 0 {
		return nil, errors.New("vbee voices: empty list")
	}
	return body.Result.Voices, nil
}
