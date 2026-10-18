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
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	maxDubSegments     = 4000
	maxDubSegmentChars = 600
	// dubSpeed is a little faster than normal: Vietnamese usually runs longer than the English it replaces.
	dubSpeed = 1.1
	// defaultFreeDailyMinutes is how many minutes of dub a free account can listen to per day.
	defaultFreeDailyMinutes = 30
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
	VideoID string `json:"videoId"`
	// Title and Description help the translator with names and register; both are optional.
	Title       string            `json:"title"`
	Description string            `json:"description"`
	Voice       string            `json:"voice"`
	Position    int               `json:"position"` // ms, where the viewer is
	Rate        float64           `json:"rate"`     // the viewer's playback rate
	Segments    []dubSegmentInput `json:"segments"`
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
	r.Title = truncateRunes(strings.TrimSpace(r.Title), 200)
	r.Description = truncateRunes(strings.TrimSpace(r.Description), 1000)
	return nil
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// sourceHash identifies a caption track by its exact sentences and times, and the way it is translated.
func sourceHash(segs []dubSegmentInput) []byte {
	h := sha256.New()
	h.Write([]byte(translationVersion + "\x00"))
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
		INSERT INTO dubs (video_id, source_hash, segment_count, title, description, created_at) VALUES ($1, $2, $3, $4, $5, now())
		ON CONFLICT (video_id, source_hash) DO NOTHING RETURNING id`,
		req.VideoID, hash, len(req.Segments), req.Title, req.Description).Scan(&id)
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

// usedTodayMs is how many ms of dub the user listened to today.
func (st *dubStore) usedTodayMs(ctx context.Context, userID int64) (int, error) {
	var ms int
	err := st.db.QueryRow(ctx, `SELECT coalesce(sum(ms), 0) FROM dub_listens WHERE user_id = $1 AND day = current_date`, userID).Scan(&ms)
	return ms, err
}

// chargeListen counts a sentence the user is about to hear against today's quota, once per sentence and day.
// Paid plans are not limited; a free account is refused once it has used limitMs.
func (st *dubStore) chargeListen(ctx context.Context, acc account, dubID int64, idx, limitMs int) error {
	if acc.Plan != "free" {
		return nil
	}
	tx, err := st.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Lock the user's row so two tabs cannot both spend the last minute.
	if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, acc.UserID); err != nil {
		return err
	}
	var counted bool
	var used int
	if err := tx.QueryRow(ctx, `
		SELECT coalesce(bool_or(dub_id = $2 AND idx = $3), false), coalesce(sum(ms), 0) FROM dub_listens
		WHERE user_id = $1 AND day = current_date`, acc.UserID, dubID, idx).Scan(&counted, &used); err != nil {
		return err
	}
	if counted {
		return nil
	}
	if used >= limitMs {
		return errQuotaExceeded
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO dub_listens (user_id, dub_id, idx, day, ms)
		SELECT $1, dub_id, idx, current_date, end_ms - start_ms FROM dub_segments WHERE dub_id = $2 AND idx = $3`,
		acc.UserID, dubID, idx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// dubSegment is one stored sentence and whether it has audio in the job's voice.
type dubSegment struct {
	idx        int
	start, end int
	source, vi string
	translated bool
	hasAudio   bool
}

// segments loads every sentence of a dub, marking which have audio in voice.
func (st *dubStore) segments(ctx context.Context, dubID int64, voice string) ([]dubSegment, error) {
	rows, err := st.db.Query(ctx, `
		SELECT s.idx, s.start_ms, s.end_ms, s.source_text, coalesce(s.vi_text, ''), s.vi_text IS NOT NULL, a.idx IS NOT NULL
		FROM dub_segments s
		LEFT JOIN dub_audio a ON a.dub_id = s.dub_id AND a.idx = s.idx AND a.voice = $2
		WHERE s.dub_id = $1 ORDER BY s.idx`, dubID, voice)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (dubSegment, error) {
		var s dubSegment
		err := row.Scan(&s.idx, &s.start, &s.end, &s.source, &s.vi, &s.translated, &s.hasAudio)
		return s, err
	})
}

// context returns what the translator is told about a dub's video.
func (st *dubStore) context(ctx context.Context, dubID int64) (title, description string, glossary []term, err error) {
	err = st.db.QueryRow(ctx, `SELECT title, description, glossary FROM dubs WHERE id = $1`, dubID).Scan(&title, &description, &glossary)
	return
}

func (st *dubStore) saveGlossary(ctx context.Context, dubID int64, glossary []term) error {
	_, err := st.db.Exec(ctx, `UPDATE dubs SET glossary = $2 WHERE id = $1`, dubID, glossary)
	return err
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
	store       *dubStore
	jobs        *dubJobs
	freeDailyMs int
	configured  bool
	// wake starts the sleeping speech worker without making it speak.
	wake func(ctx context.Context) error
}

func newDubService(db *pgxpool.Pool, tr translator, speak speakFunc, wake func(ctx context.Context) error) *dubService {
	store := &dubStore{db: db}
	minutes := defaultFreeDailyMinutes
	if n, err := strconv.Atoi(os.Getenv("DUB_FREE_DAILY_MINUTES")); err == nil && n >= 0 {
		minutes = n
	}
	return &dubService{store: store, jobs: newDubJobs(store, tr, speak), freeDailyMs: minutes * 60_000, configured: tr != nil, wake: wake}
}

// overQuota reports whether a free account has used up today's minutes.
func (d *dubService) overQuota(ctx context.Context, acc account) (bool, error) {
	if acc.Plan != "free" {
		return false, nil
	}
	used, err := d.store.usedTodayMs(ctx, acc.UserID)
	return used >= d.freeDailyMs, err
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
	if over, err := s.dubs.overQuota(ctx, acc); err != nil || over {
		if err != nil {
			log.Printf("dub quota: %v", err)
			writeError(w, http.StatusInternalServerError, "could not check quota")
			return
		}
		writeError(w, http.StatusPaymentRequired, errQuotaExceeded.Error())
		return
	}
	// The speech worker sleeps when idle and takes about half a minute to start; waking it now lets that
	// overlap the first translation.
	if s.dubs.wake != nil {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			if err := s.dubs.wake(ctx); err != nil {
				log.Printf("wake speech worker: %v", err)
			}
		}()
	}
	s.dubs.jobs.touch(id, req.Voice, req.Position, req.Rate)
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
	rate, _ := strconv.ParseFloat(r.URL.Query().Get("rate"), 64)
	s.dubs.jobs.touch(id, voice, pos, rate)
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
	audio, err := s.dubs.store.audio(r.Context(), id, idx, kokoroVoiceOr(r.URL.Query().Get("voice")))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "audio is not ready")
		return
	}
	if err == nil {
		// Fetching a sentence's audio is what counts as listening to it.
		err = s.dubs.store.chargeListen(r.Context(), acc, id, idx, s.dubs.freeDailyMs)
		if errors.Is(err, errQuotaExceeded) {
			writeError(w, http.StatusPaymentRequired, err.Error())
			return
		}
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
	used, err := s.dubs.store.usedTodayMs(r.Context(), acc.UserID)
	if err != nil {
		log.Printf("dub quota: %v", err)
		writeError(w, http.StatusInternalServerError, "could not read quota")
		return
	}
	limit := s.dubs.freeDailyMs / 1000
	if acc.Plan != "free" {
		limit = -1 // unlimited
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"plan": acc.Plan, "usedSeconds": used / 1000, "limitSeconds": limit})
}
