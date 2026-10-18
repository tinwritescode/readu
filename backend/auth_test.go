package main

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

type fakeSender struct {
	code  string
	calls int
	err   error
}

func (f *fakeSender) sendCode(_ context.Context, _, code string) error {
	f.calls++
	f.code = code
	return f.err
}

// fakeClock lets a test move time forward past cooldowns and expiry.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time { return c.t }

func newTestAuth(t *testing.T) (*authService, *fakeSender, *fakeClock) {
	t.Helper()
	sender := &fakeSender{}
	clock := &fakeClock{t: time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC)}
	a := newAuthService(sender)
	a.now = clock.now
	return a, sender, clock
}

func TestLoginWithEmailCode(t *testing.T) {
	a, sender, _ := newTestAuth(t)
	if err := a.requestCode(context.Background(), " Me@Example.com "); err != nil {
		t.Fatalf("requestCode: %v", err)
	}
	token, err := a.verify("me@example.com", sender.code)
	if err != nil {
		t.Fatalf("verify with right code: %v", err)
	}

	req, _ := http.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	if !a.authorized(req) {
		t.Fatal("session token should be accepted")
	}

	a.logout(req)
	if a.authorized(req) {
		t.Fatal("token should stop working after logout")
	}
}

func TestCodeIsOneTime(t *testing.T) {
	a, sender, _ := newTestAuth(t)
	_ = a.requestCode(context.Background(), "me@example.com")
	if _, err := a.verify("me@example.com", sender.code); err != nil {
		t.Fatalf("first use: %v", err)
	}
	if _, err := a.verify("me@example.com", sender.code); !errors.Is(err, errBadCode) {
		t.Fatalf("second use should fail, got %v", err)
	}
}

func TestCodeLocksAfterMaxAttempts(t *testing.T) {
	a, sender, _ := newTestAuth(t)
	_ = a.requestCode(context.Background(), "me@example.com")
	wrong := "000000"
	if wrong == sender.code {
		wrong = "111111"
	}
	for i := 0; i < maxAttempts; i++ {
		_, _ = a.verify("me@example.com", wrong)
	}
	if _, err := a.verify("me@example.com", sender.code); !errors.Is(err, errBadCode) {
		t.Fatalf("right code after %d misses should fail, got %v", maxAttempts, err)
	}
}

func TestCodeExpires(t *testing.T) {
	a, sender, clock := newTestAuth(t)
	_ = a.requestCode(context.Background(), "me@example.com")
	clock.t = clock.t.Add(codeTTL + time.Second)
	if _, err := a.verify("me@example.com", sender.code); !errors.Is(err, errBadCode) {
		t.Fatalf("expired code should fail, got %v", err)
	}
}

func TestOneCodePerMinute(t *testing.T) {
	a, sender, clock := newTestAuth(t)
	_ = a.requestCode(context.Background(), "me@example.com")
	if err := a.requestCode(context.Background(), "me@example.com"); !errors.Is(err, errCooldown) {
		t.Fatalf("second request within a minute should wait, got %v", err)
	}
	clock.t = clock.t.Add(codeCooldown)
	if err := a.requestCode(context.Background(), "me@example.com"); err != nil {
		t.Fatalf("request after cooldown: %v", err)
	}
	if sender.calls != 2 {
		t.Errorf("sender called %d times, want 2", sender.calls)
	}
}

func TestRejectsBadEmail(t *testing.T) {
	a, sender, _ := newTestAuth(t)
	if err := a.requestCode(context.Background(), "not-an-email"); !errors.Is(err, errBadEmail) {
		t.Fatalf("want errBadEmail, got %v", err)
	}
	if sender.calls != 0 {
		t.Error("no email should be sent for a bad address")
	}
}

func TestFailedSendDoesNotStartCooldown(t *testing.T) {
	a, sender, _ := newTestAuth(t)
	sender.err = errors.New("resend down")
	if err := a.requestCode(context.Background(), "me@example.com"); err == nil {
		t.Fatal("send error should surface")
	}
	sender.err = nil
	if err := a.requestCode(context.Background(), "me@example.com"); err != nil {
		t.Fatalf("retry right after a failed send: %v", err)
	}
}
