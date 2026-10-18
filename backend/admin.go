package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

var errNoSuchPlan = errors.New("no such plan")

// setPlan puts the account with this email on a plan, until endsAt or for good when it is nil. An email that
// has never signed in gets an account now, already on the plan.
func (a *authService) setPlan(ctx context.Context, email, plan string, endsAt *time.Time) error {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM plans WHERE id = $1)`, plan).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errNoSuchPlan
	}
	now := a.now()
	id, err := findOrCreateEmailUser(ctx, tx, email, now)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE subscriptions SET status = 'canceled', ends_at = $2 WHERE user_id = $1 AND status = 'active'`, id, now); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO subscriptions (user_id, plan_id, status, started_at, ends_at, provider) VALUES ($1, $2, 'active', $3, $4, 'admin')`,
		id, plan, now, endsAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type setPlanRequest struct {
	Email string `json:"email"`
	Plan  string `json:"plan"`
	// EndsAt is when the plan ends (RFC 3339); empty for good.
	EndsAt string `json:"endsAt"`
}

// handleSetPlan changes an account's plan by hand, until payments exist. It takes the DEBUG_TOKEN.
func (s *server) handleSetPlan(w http.ResponseWriter, r *http.Request) {
	if !s.requireDebug(w, r) {
		return
	}
	var req setPlanRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	email, err := normalizeEmail(req.Email)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var endsAt *time.Time
	if req.EndsAt != "" {
		t, err := time.Parse(time.RFC3339, req.EndsAt)
		if err != nil {
			writeError(w, http.StatusBadRequest, "endsAt must be RFC 3339")
			return
		}
		endsAt = &t
	}
	switch err := s.auth.setPlan(r.Context(), email, req.Plan, endsAt); {
	case errors.Is(err, errNoSuchPlan), errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusBadRequest, "no such plan")
		return
	case err != nil:
		log.Printf("set plan: %v", err)
		writeError(w, http.StatusInternalServerError, "could not set plan")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"email": email, "plan": req.Plan, "endsAt": endsAt})
}
