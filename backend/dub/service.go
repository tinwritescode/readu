package dub

import (
	"context"
	"log"
	"time"
)

// Service wires the store, the translator, the speech worker and the running jobs.
type Service struct {
	store      Store
	jobs       *jobs
	limits     Limits
	configured bool
	// wake starts the sleeping speech worker without making it speak.
	wake func(ctx context.Context) error
}

// New returns the dub service. A nil translator turns dubbing off; wake may be nil.
func New(store Store, tr Translator, speak SpeakFunc, wake func(ctx context.Context) error, limits Limits) *Service {
	return &Service{store: store, jobs: newJobs(store, tr, speak), limits: limits, configured: tr != nil, wake: wake}
}

// Configured reports whether a translator is set up.
func (d *Service) Configured() bool { return d.configured }

// overQuota reports whether an account on a limited plan has used up today's minutes.
func (d *Service) overQuota(ctx context.Context, acc Account) (bool, error) {
	limit := d.limits.dailyMs(acc.Plan)
	if limit == Unlimited {
		return false, nil
	}
	used, err := d.store.UsedTodayMs(ctx, acc.UserID)
	return used >= limit, err
}

// Create finds or makes the dub for a validated request and starts work at the viewer's position. It returns
// ErrQuotaExceeded when the account has no minutes left today.
func (d *Service) Create(ctx context.Context, acc Account, req *Request) (int64, error) {
	id, err := d.store.Upsert(ctx, req)
	if err != nil {
		return 0, err
	}
	over, err := d.overQuota(ctx, acc)
	if err != nil {
		return 0, err
	}
	if over {
		return 0, ErrQuotaExceeded
	}
	// The speech worker sleeps when idle and takes about half a minute to start; waking it now lets that
	// overlap the first translation.
	if d.wake != nil {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			if err := d.wake(ctx); err != nil {
				log.Printf("wake speech worker: %v", err)
			}
		}()
	}
	d.jobs.touch(id, req.Voice, req.Position, req.Rate)
	return id, nil
}

// Poll keeps a dub's job alive and tells it where the viewer is, so nearby sentences come first. It returns
// ErrNotFound for an unknown dub.
func (d *Service) Poll(ctx context.Context, dubID int64, voice string, position int, rate float64) error {
	if ok, err := d.store.Exists(ctx, dubID); err != nil || !ok {
		return ErrNotFound
	}
	d.jobs.touch(dubID, voice, position, rate)
	return nil
}

// Status reports which sentences of a dub are ready in voice.
func (d *Service) Status(ctx context.Context, dubID int64, voice string) (Status, error) {
	segs, err := d.store.Segments(ctx, dubID, voice)
	if err != nil {
		return Status{}, err
	}
	return status(dubID, voice, segs, d.jobs.failed(dubID, voice), d.jobs.lastError(dubID, voice)), nil
}

// Listen returns a sentence's audio and counts it as listened to. It returns ErrNotReady before the audio is
// made and ErrQuotaExceeded when the account has no minutes left today.
func (d *Service) Listen(ctx context.Context, acc Account, dubID int64, idx int, voice string) ([]byte, error) {
	audio, err := d.store.Audio(ctx, dubID, idx, voice)
	if err != nil {
		return nil, err
	}
	// Fetching a sentence's audio is what counts as listening to it. Unlimited plans are not counted.
	if limit := d.limits.dailyMs(acc.Plan); limit != Unlimited {
		if err := d.store.ChargeListen(ctx, acc.UserID, dubID, idx, limit); err != nil {
			return nil, err
		}
	}
	return audio, nil
}

// Quota returns how many seconds the account listened to today and its daily limit, -1 when unlimited.
func (d *Service) Quota(ctx context.Context, acc Account) (usedSeconds, limitSeconds int, err error) {
	used, err := d.store.UsedTodayMs(ctx, acc.UserID)
	if err != nil {
		return 0, 0, err
	}
	limit := d.limits.dailyMs(acc.Plan)
	if limit != Unlimited {
		limit /= 1000
	}
	return used / 1000, limit, nil
}
