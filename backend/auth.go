package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	codeTTL      = 10 * time.Minute
	codeCooldown = time.Minute
	maxAttempts  = 5
	sessionTTL   = 30 * 24 * time.Hour
)

var (
	errBadEmail  = errors.New("email is not valid")
	errCooldown  = errors.New("wait a minute before asking for another code")
	errBadCode   = errors.New("code is wrong or expired")
	emailPattern = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
)

// codeSender delivers a login code. Resend in production, a fake in tests.
type codeSender interface {
	sendCode(ctx context.Context, to, code string) error
}

// sessionRenewWindow: a session with less than this left is extended to a full term when used.
const sessionRenewWindow = 7 * 24 * time.Hour

// authService runs the email-code login. Codes, users, sessions and plans live in Postgres.
// Every query takes the time from now, so tests can move the clock.
type authService struct {
	db     *pgxpool.Pool
	sender codeSender
	now    func() time.Time
}

func newAuthService(sender codeSender, db *pgxpool.Pool) *authService {
	return &authService{db: db, sender: sender, now: time.Now}
}

func normalizeEmail(raw string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(raw))
	if !emailPattern.MatchString(email) {
		return "", errBadEmail
	}
	return email, nil
}

func codeHash(email, code string) []byte {
	sum := sha256.Sum256([]byte(email + ":" + code))
	return sum[:]
}

func tokenHash(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

func randomCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// requestCode emails a new 6-digit code. One code per email per minute.
func (a *authService) requestCode(ctx context.Context, raw string) error {
	email, err := normalizeEmail(raw)
	if err != nil {
		return err
	}
	code, err := randomCode()
	if err != nil {
		return err
	}
	now := a.now()
	// The upsert only replaces a code older than the cooldown, so no row back means wait.
	tag, err := a.db.Exec(ctx, `
		INSERT INTO login_codes (email, code_hash, sent_at, expires_at, attempts)
		VALUES ($1, $2, $3, $4, 0)
		ON CONFLICT (email) DO UPDATE
		SET code_hash = EXCLUDED.code_hash, sent_at = EXCLUDED.sent_at, expires_at = EXCLUDED.expires_at, attempts = 0
		WHERE login_codes.sent_at <= $5`,
		email, codeHash(email, code), now, now.Add(codeTTL), now.Add(-codeCooldown))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errCooldown
	}
	if err := a.sender.sendCode(ctx, email, code); err != nil {
		if _, delErr := a.db.Exec(ctx, `DELETE FROM login_codes WHERE email = $1`, email); delErr != nil {
			log.Printf("drop unsent code: %v", delErr)
		}
		return err
	}
	return nil
}

// verify exchanges a correct code for a session token, creating the user on first login.
// Each code allows maxAttempts guesses before it is dead.
func (a *authService) verify(ctx context.Context, raw, code string) (string, error) {
	email, err := normalizeEmail(raw)
	if err != nil {
		return "", errBadCode
	}
	now := a.now()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	var hash []byte
	var expires time.Time
	var attempts int
	err = tx.QueryRow(ctx, `SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = $1 FOR UPDATE`, email).
		Scan(&hash, &expires, &attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errBadCode
	}
	if err != nil {
		return "", err
	}
	if now.After(expires) || attempts >= maxAttempts {
		if _, err := tx.Exec(ctx, `DELETE FROM login_codes WHERE email = $1`, email); err != nil {
			return "", err
		}
		return "", errors.Join(errBadCode, tx.Commit(ctx))
	}
	if subtle.ConstantTimeCompare(hash, codeHash(email, code)) != 1 {
		if _, err := tx.Exec(ctx, `UPDATE login_codes SET attempts = attempts + 1 WHERE email = $1`, email); err != nil {
			return "", err
		}
		return "", errors.Join(errBadCode, tx.Commit(ctx))
	}
	if _, err := tx.Exec(ctx, `DELETE FROM login_codes WHERE email = $1`, email); err != nil {
		return "", err
	}
	userID, err := findOrCreateEmailUser(ctx, tx, email, now)
	if err != nil {
		return "", err
	}
	token, err := randomToken()
	if err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE expires_at <= $1`, now); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
		tokenHash(token), userID, now, now.Add(sessionTTL)); err != nil {
		return "", err
	}
	return token, tx.Commit(ctx)
}

// findOrCreateEmailUser returns the user behind an email identity. A new user starts on the free plan.
func findOrCreateEmailUser(ctx context.Context, tx pgx.Tx, email string, now time.Time) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `SELECT user_id FROM user_identities WHERE provider = 'email' AND subject = $1`, email).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	if err := tx.QueryRow(ctx, `INSERT INTO users (email, created_at) VALUES ($1, $2) RETURNING id`, email, now).Scan(&id); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO user_identities (user_id, provider, subject, created_at) VALUES ($1, 'email', $2, $3)`, id, email, now); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO subscriptions (user_id, plan_id, status, started_at) VALUES ($1, 'free', 'active', $2)`, id, now); err != nil {
		return 0, err
	}
	return id, nil
}

func bearerToken(r *http.Request) (string, bool) {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return token, ok && token != ""
}

// account is who a live session belongs to.
type account struct {
	UserID int64  `json:"-"`
	Email  string `json:"email"`
	Plan   string `json:"plan"`
}

// sessionAccount returns the account behind the request's token. A session close to expiry gets a full term again.
func (a *authService) sessionAccount(r *http.Request) (account, bool) {
	token, ok := bearerToken(r)
	if !ok {
		return account{}, false
	}
	ctx, now := r.Context(), a.now()
	var acc account
	var expires time.Time
	err := a.db.QueryRow(ctx, `
		SELECT u.id, u.email, coalesce(sub.plan_id, 'free'), s.expires_at
		FROM sessions s
		JOIN users u ON u.id = s.user_id
		LEFT JOIN subscriptions sub ON sub.user_id = u.id AND sub.status = 'active'
		WHERE s.token_hash = $1 AND s.expires_at > $2`, tokenHash(token), now).
		Scan(&acc.UserID, &acc.Email, &acc.Plan, &expires)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			log.Printf("check session: %v", err)
		}
		return account{}, false
	}
	if expires.Sub(now) < sessionRenewWindow {
		if _, err := a.db.Exec(ctx, `UPDATE sessions SET expires_at = $2 WHERE token_hash = $1`, tokenHash(token), now.Add(sessionTTL)); err != nil {
			log.Printf("renew session: %v", err)
		}
	}
	return acc, true
}

func (a *authService) authorized(r *http.Request) bool {
	_, ok := a.sessionAccount(r)
	return ok
}

func (a *authService) logout(r *http.Request) {
	token, ok := bearerToken(r)
	if !ok {
		return
	}
	if _, err := a.db.Exec(r.Context(), `DELETE FROM sessions WHERE token_hash = $1`, tokenHash(token)); err != nil {
		log.Printf("logout: %v", err)
	}
}

const resendURL = "https://api.resend.com/emails"

// resendSender sends login codes through the Resend API.
type resendSender struct {
	apiKey string
	from   string
	client *http.Client
}

func (r *resendSender) sendCode(ctx context.Context, to, code string) error {
	body, err := json.Marshal(map[string]any{
		"from":    r.from,
		"to":      []string{to},
		"subject": "Mã đăng nhập Readu",
		"text":    fmt.Sprintf("Mã đăng nhập của bạn: %s\n\nMã hết hạn sau 10 phút. Nếu bạn không yêu cầu, hãy bỏ qua email này.", code),
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, resendURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+r.apiKey)

	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("resend: HTTP %d: %s", resp.StatusCode, msg)
	}
	return nil
}

func (s *server) handleRequestCode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	err := s.auth.requestCode(r.Context(), body.Email)
	switch {
	case errors.Is(err, errBadEmail):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, errCooldown):
		writeError(w, http.StatusTooManyRequests, err.Error())
	case err != nil:
		log.Printf("send code failed: %v", err)
		writeError(w, http.StatusBadGateway, "could not send code")
	default:
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"sent"}`))
	}
}

func (s *server) handleVerify(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	token, err := s.auth.verify(r.Context(), body.Email, body.Code)
	if err != nil {
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": token})
}

func (s *server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.auth.logout(r)
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleMe(w http.ResponseWriter, r *http.Request) {
	acc, ok := s.auth.sessionAccount(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(acc)
}
