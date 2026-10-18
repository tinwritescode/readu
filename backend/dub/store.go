package dub

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store keeps dubs, their sentences, audio and the minutes users listen to.
type Store interface {
	// Upsert returns the dub for this caption track, creating it and its sentences on first sight.
	Upsert(ctx context.Context, req *Request) (int64, error)
	Exists(ctx context.Context, dubID int64) (bool, error)
	// Segments loads every sentence of a dub, marking which have audio in voice.
	Segments(ctx context.Context, dubID int64, voice string) ([]Segment, error)
	// VideoContext returns what the translator is told about a dub's video.
	VideoContext(ctx context.Context, dubID int64) (title, description string, glossary []Term, err error)
	SaveGlossary(ctx context.Context, dubID int64, glossary []Term) error
	SaveTranslations(ctx context.Context, dubID int64, first int, lines []string) error
	SaveAudio(ctx context.Context, dubID int64, idx int, voice string, audio []byte) error
	// Audio returns a sentence's audio in voice, or ErrNotReady.
	Audio(ctx context.Context, dubID int64, idx int, voice string) ([]byte, error)
	// UsedTodayMs is how many ms of dub the user listened to today.
	UsedTodayMs(ctx context.Context, userID int64) (int, error)
	// ChargeListen counts a sentence the user is about to hear against today's quota, once per sentence and
	// day. It returns ErrQuotaExceeded once the user has used limitMs.
	ChargeListen(ctx context.Context, userID, dubID int64, idx, limitMs int) error
}

// PGStore is the Store in Postgres.
type PGStore struct{ db *pgxpool.Pool }

func NewPGStore(db *pgxpool.Pool) *PGStore { return &PGStore{db: db} }

func (st *PGStore) Upsert(ctx context.Context, req *Request) (int64, error) {
	hash := SourceHash(req.Segments)
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
		return st.Upsert(ctx, req)
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

func (st *PGStore) UsedTodayMs(ctx context.Context, userID int64) (int, error) {
	var ms int
	err := st.db.QueryRow(ctx, `SELECT coalesce(sum(ms), 0) FROM dub_listens WHERE user_id = $1 AND day = current_date`, userID).Scan(&ms)
	return ms, err
}

func (st *PGStore) ChargeListen(ctx context.Context, userID, dubID int64, idx, limitMs int) error {
	tx, err := st.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Lock the user's row so two tabs cannot both spend the last minute.
	if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, userID); err != nil {
		return err
	}
	var counted bool
	var used int
	if err := tx.QueryRow(ctx, `
		SELECT coalesce(bool_or(dub_id = $2 AND idx = $3), false), coalesce(sum(ms), 0) FROM dub_listens
		WHERE user_id = $1 AND day = current_date`, userID, dubID, idx).Scan(&counted, &used); err != nil {
		return err
	}
	if counted {
		return nil
	}
	if used >= limitMs {
		return ErrQuotaExceeded
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO dub_listens (user_id, dub_id, idx, day, ms)
		SELECT $1, dub_id, idx, current_date, end_ms - start_ms FROM dub_segments WHERE dub_id = $2 AND idx = $3`,
		userID, dubID, idx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (st *PGStore) Segments(ctx context.Context, dubID int64, voice string) ([]Segment, error) {
	rows, err := st.db.Query(ctx, `
		SELECT s.idx, s.start_ms, s.end_ms, s.source_text, coalesce(s.vi_text, ''), s.vi_text IS NOT NULL, a.idx IS NOT NULL
		FROM dub_segments s
		LEFT JOIN dub_audio a ON a.dub_id = s.dub_id AND a.idx = s.idx AND a.voice = $2
		WHERE s.dub_id = $1 ORDER BY s.idx`, dubID, voice)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Segment, error) {
		var s Segment
		err := row.Scan(&s.Idx, &s.Start, &s.End, &s.Source, &s.VI, &s.Translated, &s.HasAudio)
		return s, err
	})
}

func (st *PGStore) VideoContext(ctx context.Context, dubID int64) (title, description string, glossary []Term, err error) {
	err = st.db.QueryRow(ctx, `SELECT title, description, glossary FROM dubs WHERE id = $1`, dubID).Scan(&title, &description, &glossary)
	return
}

func (st *PGStore) SaveGlossary(ctx context.Context, dubID int64, glossary []Term) error {
	_, err := st.db.Exec(ctx, `UPDATE dubs SET glossary = $2 WHERE id = $1`, dubID, glossary)
	return err
}

func (st *PGStore) SaveTranslations(ctx context.Context, dubID int64, first int, lines []string) error {
	batch := &pgx.Batch{}
	for i, l := range lines {
		batch.Queue(`UPDATE dub_segments SET vi_text = $3 WHERE dub_id = $1 AND idx = $2`, dubID, first+i, l)
	}
	return st.db.SendBatch(ctx, batch).Close()
}

func (st *PGStore) SaveAudio(ctx context.Context, dubID int64, idx int, voice string, audio []byte) error {
	_, err := st.db.Exec(ctx, `
		INSERT INTO dub_audio (dub_id, idx, voice, audio, created_at) VALUES ($1, $2, $3, $4, now())
		ON CONFLICT DO NOTHING`, dubID, idx, voice, audio)
	return err
}

func (st *PGStore) Audio(ctx context.Context, dubID int64, idx int, voice string) ([]byte, error) {
	var audio []byte
	err := st.db.QueryRow(ctx, `SELECT audio FROM dub_audio WHERE dub_id = $1 AND idx = $2 AND voice = $3`, dubID, idx, voice).Scan(&audio)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotReady
	}
	return audio, err
}

func (st *PGStore) Exists(ctx context.Context, dubID int64) (bool, error) {
	var ok bool
	err := st.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM dubs WHERE id = $1)`, dubID).Scan(&ok)
	return ok, err
}
