// Command vtts-backend turns text into MP3 with the Kokoro Vietnamese worker.
// The app posts text and gets audio back.
//
// Environment:
//
//	KOKORO_WORKER_URL  internal URL of the Kokoro worker (required)
//	KOKORO_WORKER_TOKEN shared secret for the Kokoro worker
//	DATABASE_URL       Postgres connection string (required)
//	RESEND_API_KEY     Resend key used to email login codes (required)
//	MAIL_FROM          sender of login emails (default "Readu <onboarding@resend.dev>")
//	CACHE_DIR          where synthesized chunks are kept (default ./cache)
//	DEBUG_TOKEN        enables /v1/debug/cache when set; requests need it as a bearer token
//	CORS_ORIGINS       comma-separated browser origins allowed to call the API (optional)
//	TRANSLATE_BASE_URL OpenAI-compatible API used to translate YouTube captions; dubbing is off without it
//	TRANSLATE_API_KEY  key for TRANSLATE_BASE_URL
//	TRANSLATE_MODEL    translation model (default gpt-6.1-sol)
//	DUB_FREE_DAILY_VIDEOS how many videos a free account may dub per day (default 10)
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
	// chunkMaxChars matches the worker's text limit and lets each chunk be cached and retried alone.
	chunkMaxChars = 300
	minSpeed      = 0.1
	maxSpeed      = 1.9
)

var voicePattern = regexp.MustCompile(`^[a-z0-9_-]{1,80}$`)

type speechRequest struct {
	Text  string  `json:"text"`
	Voice string  `json:"voice"`
	Speed float64 `json:"speed"`
}

type server struct {
	kokoro     *kokoroClient
	cacheDir   string
	debugToken string
	auth       *authService
	dubs       *dubService
}

func main() {
	kokoro := newKokoroClient()
	if kokoro.url == "" {
		log.Fatal("set KOKORO_WORKER_URL")
	}
	resendKey := os.Getenv("RESEND_API_KEY")
	if resendKey == "" {
		log.Fatal("set RESEND_API_KEY")
	}
	cacheDir := envOr("CACHE_DIR", "cache")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		log.Fatal(err)
	}

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("set DATABASE_URL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	db, err := openDB(ctx, dbURL)
	cancel()
	if err != nil {
		log.Fatal(err)
	}
	s := &server{
		kokoro:     kokoro,
		cacheDir:   cacheDir,
		debugToken: os.Getenv("DEBUG_TOKEN"),
		auth: newAuthService(&resendSender{
			apiKey: resendKey,
			from:   envOr("MAIL_FROM", "Readu <onboarding@resend.dev>"),
			client: &http.Client{Timeout: 20 * time.Second},
		}, db),
	}
	var tr translator
	if t := newChatTranslator(); t != nil {
		tr = t
	} else {
		log.Print("TRANSLATE_BASE_URL or TRANSLATE_API_KEY is not set; dubbing is off")
	}
	s.dubs = newDubService(db, tr, s.speak)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", handleRoot)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("GET /docs", handleDocs)
	mux.HandleFunc("GET /openapi.json", handleOpenAPI)
	mux.HandleFunc("GET /v1/voices", s.handleVoices)
	mux.HandleFunc("POST /v1/auth/code", s.handleRequestCode)
	mux.HandleFunc("POST /v1/auth/session", s.handleVerify)
	mux.HandleFunc("DELETE /v1/auth/session", s.handleLogout)
	mux.HandleFunc("GET /v1/me", s.handleMe)
	mux.HandleFunc("POST /v1/speech", s.handleSpeech)
	mux.HandleFunc("POST /v1/dubs", s.handleCreateDub)
	mux.HandleFunc("GET /v1/dubs/quota", s.handleDubQuota)
	mux.HandleFunc("GET /v1/dubs/{id}", s.handleDubStatus)
	mux.HandleFunc("GET /v1/dubs/{id}/audio/{idx}", s.handleDubAudio)
	mux.HandleFunc("GET /v1/debug/cache", s.handleDebugList)
	mux.HandleFunc("DELETE /v1/debug/cache", s.handleDebugClear)
	mux.HandleFunc("DELETE /v1/debug/cache/{key}", s.handleDebugDeleteOne)

	addr := ":" + envOr("PORT", "8080")
	log.Printf("listening on %s, cache %s", addr, cacheDir)
	log.Fatal(http.ListenAndServe(addr, withCORS(os.Getenv("CORS_ORIGINS"), mux)))
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
	voice := kokoroVoiceOr(req.Voice)

	var out bytes.Buffer
	for _, chunk := range splitText(text, chunkMaxChars) {
		audio, err := s.chunkAudio(r.Context(), chunk, voice, req.Speed)
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

// speak turns text of any length into MP3, through the same chunk cache as /v1/speech.
func (s *server) speak(ctx context.Context, text, voice string) ([]byte, error) {
	var out bytes.Buffer
	for _, chunk := range splitText(text, chunkMaxChars) {
		audio, err := s.chunkAudio(ctx, chunk, voice, dubSpeed)
		if err != nil {
			return nil, err
		}
		out.Write(audio)
	}
	return out.Bytes(), nil
}

func (s *server) handleVoices(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string][]voice{"voices": kokoroVoices})
}

// chunkAudio returns cached audio for a chunk, or synthesizes and caches it.
func (s *server) chunkAudio(ctx context.Context, chunk, voice string, speed float64) ([]byte, error) {
	speedKey := strconv.FormatFloat(speed, 'f', 2, 64)
	sum := sha256.Sum256([]byte(kokoroModelVersion + "\x00" + voice + "\x00" + speedKey + "\x00" + chunk))
	key := hex.EncodeToString(sum[:])
	path := filepath.Join(s.cacheDir, key[:2], key+".mp3")

	if data, err := os.ReadFile(path); err == nil {
		return data, nil
	}

	audio, err := s.kokoro.synthesize(ctx, chunk, voice, speed)
	if err != nil {
		return nil, err
	}
	if len(audio) == 0 {
		return nil, errors.New("empty audio from kokoro")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, audio, 0o644); err != nil {
		return nil, err
	}
	// The sidecar lets the debug page show what each file says. A failure here only loses that label.
	if err := writeCacheMeta(path, voice, speed, chunk); err != nil {
		log.Printf("cache label failed: %v", err)
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
