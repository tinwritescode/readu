package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Legacy Vbee API: POST starts a job, GET polls it, then the audio link is
// fetched. The job needs a callback_url, which we don't use.
const (
	vbeeCreateURL = "https://vbee.vn/api/v1/tts"
	vbeeStatusURL = "https://vbee.vn/api/v1/tts/"
	vbeePollEvery = time.Second
	vbeePollLimit = 90
)

type vbeeClient struct {
	appID       string
	token       string
	callbackURL string
	client      *http.Client
}

type vbeeCreateRequest struct {
	AppID        string `json:"app_id"`
	ResponseType string `json:"response_type"`
	CallbackURL  string `json:"callback_url"`
	InputText    string `json:"input_text"`
	VoiceCode    string `json:"voice_code"`
	AudioType    string `json:"audio_type"`
	Bitrate      int    `json:"bitrate"`
	SpeedRate    string `json:"speed_rate"`
}

type vbeeEnvelope struct {
	Result struct {
		RequestID string `json:"request_id"`
		Status    string `json:"status"`
		AudioLink string `json:"audio_link"`
	} `json:"result"`
	Status       int    `json:"status"`
	ErrorCode    int    `json:"error_code"`
	ErrorMessage string `json:"error_message"`
}

// synthesize turns one chunk of text into MP3 bytes.
func (v *vbeeClient) synthesize(ctx context.Context, text, voice string, speed float64) ([]byte, error) {
	id, err := v.create(ctx, text, voice, speed)
	if err != nil {
		return nil, err
	}
	link, err := v.waitForLink(ctx, id)
	if err != nil {
		return nil, err
	}
	return v.download(ctx, link)
}

func (v *vbeeClient) create(ctx context.Context, text, voice string, speed float64) (string, error) {
	body, err := json.Marshal(vbeeCreateRequest{
		AppID:        v.appID,
		ResponseType: "indirect",
		CallbackURL:  v.callbackURL,
		InputText:    text,
		VoiceCode:    voice,
		AudioType:    "mp3",
		Bitrate:      128,
		SpeedRate:    fmt.Sprintf("%.1f", speed),
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, vbeeCreateURL, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+v.token)

	env, err := v.doEnvelope(req)
	if err != nil {
		return "", err
	}
	if env.Result.RequestID == "" {
		return "", fmt.Errorf("vbee create: no request_id")
	}
	return env.Result.RequestID, nil
}

// waitForLink polls the job until it succeeds or fails, or the poll limit runs out.
func (v *vbeeClient) waitForLink(ctx context.Context, id string) (string, error) {
	for i := 0; i < vbeePollLimit; i++ {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(vbeePollEvery):
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, vbeeStatusURL+id, nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("Authorization", "Bearer "+v.token)
		env, err := v.doEnvelope(req)
		if err != nil {
			return "", err
		}
		switch env.Result.Status {
		case "SUCCESS":
			if env.Result.AudioLink == "" {
				return "", errors.New("vbee: SUCCESS without audio_link")
			}
			return env.Result.AudioLink, nil
		case "FAILURE":
			return "", errors.New("vbee: job failed")
		}
	}
	return "", errors.New("vbee: timed out waiting for audio")
}

func (v *vbeeClient) download(ctx context.Context, link string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return nil, err
	}
	resp, err := v.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("vbee audio download: HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

func (v *vbeeClient) doEnvelope(req *http.Request) (vbeeEnvelope, error) {
	resp, err := v.client.Do(req)
	if err != nil {
		return vbeeEnvelope{}, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return vbeeEnvelope{}, err
	}
	var env vbeeEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return vbeeEnvelope{}, fmt.Errorf("vbee HTTP %d: %s", resp.StatusCode, data)
	}
	if resp.StatusCode != http.StatusOK || env.Status != 1 {
		return vbeeEnvelope{}, fmt.Errorf("vbee HTTP %d: %d %s", resp.StatusCode, env.ErrorCode, env.ErrorMessage)
	}
	return env, nil
}
