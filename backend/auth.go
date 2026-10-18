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
	"sync"
	"time"
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

type pendingCode struct {
	hash     [32]byte
	expires  time.Time
	attempts int
	sentAt   time.Time
}

type session struct {
	email   string
	expires time.Time
}

// authService keeps login codes and sessions in memory. A restart signs
// everyone out, which is acceptable for a single-user backend.
type authService struct {
	mu       sync.Mutex
	sender   codeSender
	codes    map[string]*pendingCode
	sessions map[[32]byte]session
	now      func() time.Time
}

func newAuthService(sender codeSender) *authService {
	return &authService{
		sender:   sender,
		codes:    map[string]*pendingCode{},
		sessions: map[[32]byte]session{},
		now:      time.Now,
	}
}

func normalizeEmail(raw string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(raw))
	if !emailPattern.MatchString(email) {
		return "", errBadEmail
	}
	return email, nil
}

func codeHash(email, code string) [32]byte {
	return sha256.Sum256([]byte(email + ":" + code))
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

	a.mu.Lock()
	now := a.now()
	if p, ok := a.codes[email]; ok && now.Sub(p.sentAt) < codeCooldown {
		a.mu.Unlock()
		return errCooldown
	}
	a.codes[email] = &pendingCode{hash: codeHash(email, code), expires: now.Add(codeTTL), sentAt: now}
	a.mu.Unlock()

	if err := a.sender.sendCode(ctx, email, code); err != nil {
		a.mu.Lock()
		delete(a.codes, email)
		a.mu.Unlock()
		return err
	}
	return nil
}

// verify exchanges a correct code for a session token. Each code allows
// maxAttempts guesses before it is dead.
func (a *authService) verify(raw, code string) (string, error) {
	email, err := normalizeEmail(raw)
	if err != nil {
		return "", errBadCode
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	p, ok := a.codes[email]
	if !ok || now.After(p.expires) || p.attempts >= maxAttempts {
		delete(a.codes, email)
		return "", errBadCode
	}
	p.attempts++
	want := codeHash(email, code)
	if subtle.ConstantTimeCompare(p.hash[:], want[:]) != 1 {
		return "", errBadCode
	}
	delete(a.codes, email)

	token, err := randomToken()
	if err != nil {
		return "", err
	}
	a.sessions[sha256.Sum256([]byte(token))] = session{email: email, expires: now.Add(sessionTTL)}
	return token, nil
}

func bearerToken(r *http.Request) (string, bool) {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return token, ok && token != ""
}

func (a *authService) authorized(r *http.Request) bool {
	token, ok := bearerToken(r)
	if !ok {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	s, ok := a.sessions[sha256.Sum256([]byte(token))]
	return ok && a.now().Before(s.expires)
}

func (a *authService) logout(r *http.Request) {
	token, ok := bearerToken(r)
	if !ok {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.sessions, sha256.Sum256([]byte(token)))
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
		"subject": "Mã đăng nhập vTTS Reader",
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
	token, err := s.auth.verify(body.Email, body.Code)
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
