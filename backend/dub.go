package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	maxDubSegments     = 4000
	maxDubSegmentChars = 600
	// dubSpeed is a little faster than normal: Vietnamese usually runs longer than the English it replaces.
	dubSpeed = 1.1
	// defaultFreeDailyDubs is how many different videos a free account can dub per day.
	defaultFreeDailyDubs = 10
)

var (
	videoIDPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
	errQuotaExceeded = errors.New("daily dub quota exceeded")
)

type dubSegmentInput struct {
	Start int    `json:"start"` // ms
	End   int    `json:"end"`   // ms
	Text  string `json:"text"`
}

type dubRequest struct {
	VideoID  string            `json:"videoId"`
	Voice    string            `json:"voice"`
	Position int               `json:"position"` // ms, where the viewer is
	Segments []dubSegmentInput `json:"segments"`
}

// validate cleans the request in place and reports what is wrong with it.
func (r *dubRequest) validate() error {
	if !videoIDPattern.MatchString(r.VideoID) {
		return errors.New("videoId is malformed")
	}
	if len(r.Segments) == 0 {
		return errors.New("segments are empty")
	}
	if len(r.Segments) > maxDubSegments {
		return errors.New("too many segments")
	}
	prev := -1
	for i := range r.Segments {
		s := &r.Segments[i]
		s.Text = strings.Join(strings.Fields(s.Text), " ")
		switch {
		case s.Text == "":
			return errors.New("segment " + strconv.Itoa(i) + " is empty")
		case utf8.RuneCountInString(s.Text) > maxDubSegmentChars:
			return errors.New("segment " + strconv.Itoa(i) + " is too long")
		case s.Start < 0 || s.End <= s.Start || s.Start < prev:
			return errors.New("segment " + strconv.Itoa(i) + " has bad times")
		}
		prev = s.Start
	}
	r.Voice = kokoroVoiceOr(r.Voice)
	return nil
}

// sourceHash identifies a caption track by its exact sentences and times.
func sourceHash(segs []dubSegmentInput) []byte {
	h := sha256.New()
	json.NewEncoder(h).Encode(segs)
	return h.Sum(nil)
}

// dubStatus is what the extension polls: which sentences are ready to play.
type dubStatus struct {
	ID         int64  `json:"id"`
	Voice      string `json:"voice"`
	Total      int    `json:"total"`
	Translated int    `json:"translated"`
	Ready      []int  `json:"ready"`
	Failed     []int  `json:"failed"`
	// Stage is "translating", "speaking", "done" or "error".
	Stage string `json:"stage"`
	Error string `json:"error,omitempty"`
}

// dubStore keeps dubs, their sentences and audio in Postgres.
type dubStore struct{ db *pgxpool.Pool }

// upsert returns the dub for this caption track, creating it and its sentences on first sight.
func (st *dubStore) upsert(ctx context.Context, req *dubRequest) (int64, error) {
	hash := sourceHash(req.Segments)
	var id int64
	err := st.db.QueryRow(ctx, `SELECT id FROM dubs WHERE video_id = $1 AND source_hash = $2`, req.VideoID, hash).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	tx, err := st.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	// Two viewers can open the same video at once; the loser of the race reads the winner's row.
	err = tx.QueryRow(ctx, `
		INSERT INTO dubs (video_id, source_hash, segment_count, created_at) VALUES ($1, $2, $3, now())
		ON CONFLICT (video_id, source_hash) DO NOTHING RETURNING id`,
		req.VideoID, hash, len(req.Segments)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return st.upsert(ctx, req)
	}
	if err != nil {
		return 0, err
	}
	rows := make([][]any, len(req.Segments))
	for i, s := range req.Segments {
		rows[i] = []any{id, i, s.Start, s.End, s.Text}
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"dub_segments"},
		[]string{"dub_id", "idx", "start_ms", "end_ms", "source_text"}, pgx.CopyFromRows(rows)); err != nil {
		return 0, err
	}
	return id, tx.Commit(ctx)
}

// chargeQuota records that the user dubbed this video today. Paid plans are not limited;
// a free account may start limit new videos a day, and reopening one already counted is free.
func (st *dubStore) chargeQuota(ctx context.Context, acc account, dubID int64, limit int) error {
	if acc.Plan != "free" {
		return nil
	}
	tx, err := st.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Lock the user's row so two tabs cannot both take the last slot.
	if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, acc.UserID); err != nil {
		return err
	}
	var counted bool
	var used int
	if err := tx.QueryRow(ctx, `
		SELECT coalesce(bool_or(dub_id = $2), false), count(*) FROM dub_usage
		WHERE user_id = $1 AND day = current_date`, acc.UserID, dubID).Scan(&counted, &used); err != nil {
		return err
	}
	if counted {
		return nil
	}
	if used >= limit {
		return errQuotaExceeded
	}
	if _, err := tx.Exec(ctx, `INSERT INTO dub_usage (user_id, dub_id, day) VALUES ($1, $2, current_date)`, acc.UserID, dubID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (st *dubStore) usedToday(ctx context.Context, userID int64) (int, error) {
	var n int
	err := st.db.QueryRow(ctx, `SELECT count(*) FROM dub_usage WHERE user_id = $1 AND day = current_date`, userID).Scan(&n)
	return n, err
}

// dubSegment is one stored sentence and whether it has audio in the job's voice.
type dubSegment struct {
	idx        int
	start      int
	source, vi string
	translated bool
	hasAudio   bool
}

// segments loads every sentence of a dub, marking which have audio in voice.
func (st *dubStore) segments(ctx context.Context, dubID int64, voice string) ([]dubSegment, error) {
	rows, err := st.db.Query(ctx, `
		SELECT s.idx, s.start_ms, s.source_text, coalesce(s.vi_text, ''), s.vi_text IS NOT NULL, a.idx IS NOT NULL
		FROM dub_segments s
		LEFT JOIN dub_audio a ON a.dub_id = s.dub_id AND a.idx = s.idx AND a.voice = $2
		WHERE s.dub_id = $1 ORDER BY s.idx`, dubID, voice)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (dubSegment, error) {
		var s dubSegment
		err := row.Scan(&s.idx, &s.start, &s.source, &s.vi, &s.translated, &s.hasAudio)
		return s, err
	})
}

func (st *dubStore) saveTranslations(ctx context.Context, dubID int64, first int, lines []string) error {
	batch := &pgx.Batch{}
	for i, l := range lines {
		batch.Queue(`UPDATE dub_segments SET vi_text = $3 WHERE dub_id = $1 AND idx = $2`, dubID, first+i, l)
	}
	return st.db.SendBatch(ctx, batch).Close()
}

func (st *dubStore) saveAudio(ctx context.Context, dubID int64, idx int, voice string, audio []byte) error {
	_, err := st.db.Exec(ctx, `
		INSERT INTO dub_audio (dub_id, idx, voice, audio, created_at) VALUES ($1, $2, $3, $4, now())
		ON CONFLICT DO NOTHING`, dubID, idx, voice, audio)
	return err
}

func (st *dubStore) audio(ctx context.Context, dubID int64, idx int, voice string) ([]byte, error) {
	var audio []byte
	err := st.db.QueryRow(ctx, `SELECT audio FROM dub_audio WHERE dub_id = $1 AND idx = $2 AND voice = $3`, dubID, idx, voice).Scan(&audio)
	return audio, err
}

func (st *dubStore) exists(ctx context.Context, dubID int64) (bool, error) {
	var ok bool
	err := st.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM dubs WHERE id = $1)`, dubID).Scan(&ok)
	return ok, err
}

// dubService wires the store, the translator, the speech worker and the running jobs.
type dubService struct {
	store      *dubStore
	jobs       *dubJobs
	freeDaily  int
	configured bool
}

func newDubService(db *pgxpool.Pool, tr translator, speak speakFunc) *dubService {
	store := &dubStore{db: db}
	limit := defaultFreeDailyDubs
	if n, err := strconv.Atoi(os.Getenv("DUB_FREE_DAILY_VIDEOS")); err == nil && n >= 0 {
		limit = n
	}
	return &dubService{store: store, jobs: newDubJobs(store, tr, speak), freeDaily: limit, configured: tr != nil}
}

func (d *dubService) status(ctx context.Context, dubID int64, voice string) (dubStatus, error) {
	segs, err := d.store.segments(ctx, dubID, voice)
	if err != nil {
		return dubStatus{}, err
	}
	st := dubStatus{ID: dubID, Voice: voice, Total: len(segs), Ready: []int{}, Failed: d.jobs.failed(dubID, voice)}
	for _, s := range segs {
		if s.translated {
			st.Translated++
		}
		if s.hasAudio {
			st.Ready = append(st.Ready, s.idx)
		}
	}
	st.Error = d.jobs.lastError(dubID, voice)
	switch {
	case len(st.Ready)+len(st.Failed) >= st.Total:
		st.Stage = "done"
	case st.Error != "" && len(st.Ready) == 0:
		st.Stage = "error"
	case st.Translated == 0:
		st.Stage = "translating"
	default:
		st.Stage = "speaking"
	}
	return st, nil
}

func (s *server) handleCreateDub(w http.ResponseWriter, r *http.Request) {
	acc, ok := s.auth.sessionAccount(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if !s.dubs.configured {
		writeError(w, http.StatusServiceUnavailable, "dubbing is not configured")
		return
	}
	var req dubRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if err := req.validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx := r.Context()
	id, err := s.dubs.store.upsert(ctx, &req)
	if err != nil {
		log.Printf("create dub: %v", err)
		writeError(w, http.StatusInternalServerError, "could not create dub")
		return
	}
	if err := s.dubs.store.chargeQuota(ctx, acc, id, s.dubs.freeDaily); err != nil {
		if errors.Is(err, errQuotaExceeded) {
			writeError(w, http.StatusPaymentRequired, err.Error())
			return
		}
		log.Printf("dub quota: %v", err)
		writeError(w, http.StatusInternalServerError, "could not check quota")
		return
	}
	s.dubs.jobs.touch(id, req.Voice, req.Position)
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
	if ok, err := s.dubs.store.exists(r.Context(), id); err != nil || !ok {
		writeError(w, http.StatusNotFound, "no such dub")
		return
	}
	// Polling keeps the job alive and tells it where the viewer is, so nearby sentences come first.
	pos, _ := strconv.Atoi(r.URL.Query().Get("position"))
	s.dubs.jobs.touch(id, voice, pos)
	s.writeDubStatus(w, r, id, voice)
}

func (s *server) writeDubStatus(w http.ResponseWriter, r *http.Request, id int64, voice string) {
	st, err := s.dubs.status(r.Context(), id, voice)
	if err != nil {
		log.Printf("dub status: %v", err)
		writeError(w, http.StatusInternalServerError, "could not read dub")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(st)
}

func (s *server) handleDubAudio(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	id, err1 := strconv.ParseInt(r.PathValue("id"), 10, 64)
	idx, err2 := strconv.Atoi(r.PathValue("idx"))
	if err1 != nil || err2 != nil {
		writeError(w, http.StatusNotFound, "no such audio")
		return
	}
	audio, err := s.dubs.store.audio(r.Context(), id, idx, kokoroVoiceOr(r.URL.Query().Get("voice")))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "audio is not ready")
		return
	}
	if err != nil {
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
	used, err := s.dubs.store.usedToday(r.Context(), acc.UserID)
	if err != nil {
		log.Printf("dub quota: %v", err)
		writeError(w, http.StatusInternalServerError, "could not read quota")
		return
	}
	limit := s.dubs.freeDaily
	if acc.Plan != "free" {
		limit = -1 // unlimited
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"plan": acc.Plan, "used": used, "limit": limit})
}
