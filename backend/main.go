// Command vtts-backend turns text into MP3 with Vbee, keeping the Vbee keys
// on the server. The app posts text and gets audio back.
//
// Environment:
//
//	VBEE_APP_ID        App ID from the Vbee console (required)
//	VBEE_ACCESS_TOKEN  Access token for the app (required)
//	RESEND_API_KEY     Resend key used to email login codes (required)
//	MAIL_FROM          sender of login emails (default "vTTS Reader <onboarding@resend.dev>")
//	CACHE_DIR          where synthesized chunks are kept (default ./cache)
//	PORT               listen port (default 8080)
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	maxRequestChars = 20000
	// vbeeMaxChars keeps each job short enough to poll quickly and to retry alone.
	vbeeMaxChars = 300
	minSpeed     = 0.1
	maxSpeed     = 1.9
)

var voicePattern = regexp.MustCompile(`^[a-z0-9_-]{1,80}$`)

type speechRequest struct {
	Text  string  `json:"text"`
	Voice string  `json:"voice"`
	Speed float64 `json:"speed"`
}

type server struct {
	vbee     *vbeeClient
	voices   *voiceCatalog
	cacheDir string
	auth     *authService
}

func main() {
	appID := os.Getenv("VBEE_APP_ID")
	token := os.Getenv("VBEE_ACCESS_TOKEN")
	if appID == "" || token == "" {
		log.Fatal("set VBEE_APP_ID and VBEE_ACCESS_TOKEN")
	}
	resendKey := os.Getenv("RESEND_API_KEY")
	if resendKey == "" {
		log.Fatal("set RESEND_API_KEY")
	}
	cacheDir := envOr("CACHE_DIR", "cache")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		log.Fatal(err)
	}

	vbee := &vbeeClient{
		appID:       appID,
		token:       token,
		callbackURL: envOr("CALLBACK_URL", "https://example.com/callback"),
		client:      &http.Client{Timeout: 60 * time.Second},
	}
	s := &server{
		vbee:     vbee,
		voices:   &voiceCatalog{vbee: vbee},
		cacheDir: cacheDir,
		auth: newAuthService(&resendSender{
			apiKey: resendKey,
			from:   envOr("MAIL_FROM", "vTTS Reader <onboarding@resend.dev>"),
			client: &http.Client{Timeout: 20 * time.Second},
		}),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", handleRoot)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("GET /docs", handleDocs)
	mux.HandleFunc("GET /openapi.json", handleOpenAPI)
	mux.HandleFunc("GET /v1/voices", s.handleVoices)
	mux.HandleFunc("POST /v1/auth/code", s.handleRequestCode)
	mux.HandleFunc("POST /v1/auth/session", s.handleVerify)
	mux.HandleFunc("DELETE /v1/auth/session", s.handleLogout)
	mux.HandleFunc("POST /v1/speech", s.handleSpeech)

	addr := ":" + envOr("PORT", "8080")
	log.Printf("listening on %s, cache %s", addr, cacheDir)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func (s *server) handleSpeech(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req speechRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	text := strings.TrimSpace(req.Text)
	switch {
	case text == "":
		writeError(w, http.StatusBadRequest, "text is empty")
		return
	case utf8.RuneCountInString(text) > maxRequestChars:
		writeError(w, http.StatusBadRequest, "text is too long")
		return
	case !voicePattern.MatchString(req.Voice):
		writeError(w, http.StatusBadRequest, "voice is missing or malformed")
		return
	case req.Speed < minSpeed || req.Speed > maxSpeed:
		writeError(w, http.StatusBadRequest, "speed must be between 0.1 and 1.9")
		return
	}

	var out bytes.Buffer
	for _, chunk := range splitText(text, vbeeMaxChars) {
		audio, err := s.chunkAudio(r.Context(), chunk, req.Voice, req.Speed)
		if err != nil {
			log.Printf("synthesize failed: %v", err)
			writeError(w, http.StatusBadGateway, "speech service failed")
			return
		}
		out.Write(audio)
	}

	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Content-Length", strconv.Itoa(out.Len()))
	w.Write(out.Bytes())
}

func (s *server) handleVoices(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	voices, err := s.voices.get(r.Context())
	if err != nil {
		log.Printf("list voices failed: %v", err)
		writeError(w, http.StatusBadGateway, "voice list unavailable")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string][]voice{"voices": voices})
}

// chunkAudio returns cached audio for a chunk, or synthesizes and caches it.
func (s *server) chunkAudio(ctx context.Context, chunk, voice string, speed float64) ([]byte, error) {
	speedKey := strconv.FormatFloat(speed, 'f', 2, 64)
	sum := sha256.Sum256([]byte(voice + "\x00" + speedKey + "\x00" + chunk))
	key := hex.EncodeToString(sum[:])
	path := filepath.Join(s.cacheDir, key[:2], key+".mp3")

	if data, err := os.ReadFile(path); err == nil {
		return data, nil
	}

	audio, err := s.vbee.synthesize(ctx, chunk, voice, speed)
	if err != nil {
		return nil, err
	}
	if len(audio) == 0 {
		return nil, errors.New("empty audio from vbee")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, audio, 0o644); err != nil {
		return nil, err
	}
	return audio, nil
}

func (s *server) authorized(r *http.Request) bool {
	return s.auth.authorized(r)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
