package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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

// testDB gives each test its own fresh database on TEST_DATABASE_URL, migrated to the latest schema.
func testDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	base := os.Getenv("TEST_DATABASE_URL")
	if base == "" {
		t.Skip("set TEST_DATABASE_URL to run database tests")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	db, err := openDB(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Close()
		admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)")
		admin.Close(ctx)
	})
	return db
}

func newTestAuth(t *testing.T) (*authService, *fakeSender, *fakeClock) {
	t.Helper()
	sender := &fakeSender{}
	clock := &fakeClock{t: time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC)}
	a := newAuthService(sender, testDB(t))
	a.now = clock.now
	return a, sender, clock
}

// loginAs runs the code flow and returns a bearer request for the new session.
func loginAs(t *testing.T, a *authService, sender *fakeSender, email string) (*http.Request, string) {
	t.Helper()
	if err := a.requestCode(context.Background(), email); err != nil {
		t.Fatalf("requestCode: %v", err)
	}
	token, err := a.verify(context.Background(), email, sender.code)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	req, _ := http.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	return req, token
}

func TestLoginWithEmailCode(t *testing.T) {
	a, sender, _ := newTestAuth(t)
	if err := a.requestCode(context.Background(), " Me@Example.com "); err != nil {
		t.Fatalf("requestCode: %v", err)
	}
	token, err := a.verify(context.Background(), "me@example.com", sender.code)
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
	if _, err := a.verify(context.Background(), "me@example.com", sender.code); err != nil {
		t.Fatalf("first use: %v", err)
	}
	if _, err := a.verify(context.Background(), "me@example.com", sender.code); !errors.Is(err, errBadCode) {
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
		_, _ = a.verify(context.Background(), "me@example.com", wrong)
	}
	if _, err := a.verify(context.Background(), "me@example.com", sender.code); !errors.Is(err, errBadCode) {
		t.Fatalf("right code after %d misses should fail, got %v", maxAttempts, err)
	}
}

func TestCodeExpires(t *testing.T) {
	a, sender, clock := newTestAuth(t)
	_ = a.requestCode(context.Background(), "me@example.com")
	clock.t = clock.t.Add(codeTTL + time.Second)
	if _, err := a.verify(context.Background(), "me@example.com", sender.code); !errors.Is(err, errBadCode) {
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

func TestSessionSurvivesRestart(t *testing.T) {
	a, sender, _ := newTestAuth(t)
	req, _ := loginAs(t, a, sender, "me@example.com")
	restarted := newAuthService(sender, a.db)
	if !restarted.authorized(req) {
		t.Fatal("session should survive a restart")
	}
}

func TestFirstLoginCreatesFreeUserOnce(t *testing.T) {
	a, sender, clock := newTestAuth(t)
	req, _ := loginAs(t, a, sender, "me@example.com")
	acc, ok := a.sessionAccount(req)
	if !ok || acc.Email != "me@example.com" || acc.Plan != "free" {
		t.Fatalf("account %+v, ok %v", acc, ok)
	}
	clock.t = clock.t.Add(codeCooldown)
	req2, _ := loginAs(t, a, sender, "ME@example.com")
	acc2, _ := a.sessionAccount(req2)
	if acc2.UserID != acc.UserID {
		t.Fatalf("second login made a new user: %d vs %d", acc2.UserID, acc.UserID)
	}
	var subs int
	if err := a.db.QueryRow(context.Background(), `SELECT count(*) FROM subscriptions WHERE user_id = $1`, acc.UserID).Scan(&subs); err != nil || subs != 1 {
		t.Fatalf("subscriptions %d, err %v", subs, err)
	}
}

func TestSessionRenewsNearExpiry(t *testing.T) {
	a, sender, clock := newTestAuth(t)
	req, _ := loginAs(t, a, sender, "me@example.com")

	clock.t = clock.t.Add(sessionTTL - sessionRenewWindow/2)
	if !a.authorized(req) {
		t.Fatal("session should still be valid near the end of its term")
	}
	// The earlier use renewed the term, so the session outlives the original expiry.
	clock.t = clock.t.Add(sessionRenewWindow)
	if !a.authorized(req) {
		t.Fatal("renewed session should outlive its original expiry")
	}
}

func TestSessionExpiresAfterIdleTerm(t *testing.T) {
	a, sender, clock := newTestAuth(t)
	req, _ := loginAs(t, a, sender, "me@example.com")

	clock.t = clock.t.Add(sessionTTL + time.Second)
	if a.authorized(req) {
		t.Fatal("session idle past its term should expire")
	}
}
