package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"

	"vtts-backend/dub"
)

const (
	// dubSpeed is a little faster than normal: Vietnamese usually runs longer than the English it replaces.
	dubSpeed = 1.1
	// defaultFreeDailyMinutes is how many minutes of dub a free account can listen to per day.
	defaultFreeDailyMinutes = 30
	defaultTranslateModel   = "gpt-6.1-sol"
)

// newDubService builds the dub service from the environment. Without TRANSLATE_BASE_URL and TRANSLATE_API_KEY
// dubbing is off.
func newDubService(db *pgxpool.Pool, speak dub.SpeakFunc, wake func(ctx context.Context) error) *dub.Service {
	var tr dub.Translator
	if base, key := os.Getenv("TRANSLATE_BASE_URL"), os.Getenv("TRANSLATE_API_KEY"); base != "" && key != "" {
		tr = dub.NewChatTranslator(base, key, envOr("TRANSLATE_MODEL", defaultTranslateModel))
	} else {
		log.Print("TRANSLATE_BASE_URL or TRANSLATE_API_KEY is not set; dubbing is off")
	}
	minutes := defaultFreeDailyMinutes
	if n, err := strconv.Atoi(os.Getenv("DUB_FREE_DAILY_MINUTES")); err == nil && n >= 0 {
		minutes = n
	}
	return dub.New(dub.NewPGStore(db), tr, speak, wake, minutes)
}

func dubAccount(acc account) dub.Account { return dub.Account{UserID: acc.UserID, Plan: acc.Plan} }

func (s *server) handleCreateDub(w http.ResponseWriter, r *http.Request) {
	acc, ok := s.auth.sessionAccount(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if !s.dubs.Configured() {
		writeError(w, http.StatusServiceUnavailable, "dubbing is not configured")
		return
	}
	var req dub.Request
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if err := req.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	req.Voice = kokoroVoiceOr(req.Voice)
	id, err := s.dubs.Create(r.Context(), dubAccount(acc), &req)
	if errors.Is(err, dub.ErrQuotaExceeded) {
		writeError(w, http.StatusPaymentRequired, err.Error())
		return
	}
	if err != nil {
		log.Printf("create dub: %v", err)
		writeError(w, http.StatusInternalServerError, "could not create dub")
		return
	}
	s.writeDubStatus(w, r, id, req.Voice)
}

func (s *server) handleDubStatus(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusNotFound, "no such dub")
		return
	}
	voice := kokoroVoiceOr(r.URL.Query().Get("voice"))
	pos, _ := strconv.Atoi(r.URL.Query().Get("position"))
	rate, _ := strconv.ParseFloat(r.URL.Query().Get("rate"), 64)
	if err := s.dubs.Poll(r.Context(), id, voice, pos, rate); err != nil {
		writeError(w, http.StatusNotFound, "no such dub")
		return
	}
	s.writeDubStatus(w, r, id, voice)
}

func (s *server) writeDubStatus(w http.ResponseWriter, r *http.Request, id int64, voice string) {
	st, err := s.dubs.Status(r.Context(), id, voice)
	if err != nil {
		log.Printf("dub status: %v", err)
		writeError(w, http.StatusInternalServerError, "could not read dub")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(st)
}

func (s *server) handleDubAudio(w http.ResponseWriter, r *http.Request) {
	acc, ok := s.auth.sessionAccount(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	id, err1 := strconv.ParseInt(r.PathValue("id"), 10, 64)
	idx, err2 := strconv.Atoi(r.PathValue("idx"))
	if err1 != nil || err2 != nil {
		writeError(w, http.StatusNotFound, "no such audio")
		return
	}
	audio, err := s.dubs.Listen(r.Context(), dubAccount(acc), id, idx, kokoroVoiceOr(r.URL.Query().Get("voice")))
	switch {
	case errors.Is(err, dub.ErrNotReady):
		writeError(w, http.StatusNotFound, err.Error())
		return
	case errors.Is(err, dub.ErrQuotaExceeded):
		writeError(w, http.StatusPaymentRequired, err.Error())
		return
	case err != nil:
		log.Printf("dub audio: %v", err)
		writeError(w, http.StatusInternalServerError, "could not read audio")
		return
	}
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Content-Length", strconv.Itoa(len(audio)))
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Write(audio)
}

func (s *server) handleDubQuota(w http.ResponseWriter, r *http.Request) {
	acc, ok := s.auth.sessionAccount(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	used, limit, err := s.dubs.Quota(r.Context(), dubAccount(acc))
	if err != nil {
		log.Printf("dub quota: %v", err)
		writeError(w, http.StatusInternalServerError, "could not read quota")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"plan": acc.Plan, "usedSeconds": used, "limitSeconds": limit})
}
