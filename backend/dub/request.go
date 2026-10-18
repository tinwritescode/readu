// Package dub turns a YouTube caption track into a Vietnamese voice-over: it translates the sentences a little
// ahead of the viewer, speaks them, and counts the minutes a free account listens to.
//
// The rules (request checks, what to work on next, how translations must fit their time) are plain functions.
// Service runs them over three ports: a Store for dubs and audio, a Translator and a SpeakFunc.
package dub

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	maxSegments     = 4000
	maxSegmentChars = 600
)

var (
	videoIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
	// ErrQuotaExceeded is returned once a free account has listened to today's minutes.
	ErrQuotaExceeded = errors.New("daily dub quota exceeded")
	// ErrNotFound is returned for a dub id that does not exist.
	ErrNotFound = errors.New("no such dub")
	// ErrNotReady is returned for a sentence whose audio is not made yet.
	ErrNotReady = errors.New("audio is not ready")
)

// SegmentInput is one caption sentence as the extension sends it.
type SegmentInput struct {
	Start int    `json:"start"` // ms
	End   int    `json:"end"`   // ms
	Text  string `json:"text"`
}

// Request asks for a dub of a caption track.
type Request struct {
	VideoID string `json:"videoId"`
	// Title and Description help the translator with names and register; both are optional.
	Title       string         `json:"title"`
	Description string         `json:"description"`
	Voice       string         `json:"voice"`
	Position    int            `json:"position"` // ms, where the viewer is
	Rate        float64        `json:"rate"`     // the viewer's playback rate
	Segments    []SegmentInput `json:"segments"`
}

// Validate cleans the request in place and reports what is wrong with it. The voice is left to the caller,
// which knows the speech worker's voices.
func (r *Request) Validate() error {
	if !videoIDPattern.MatchString(r.VideoID) {
		return errors.New("videoId is malformed")
	}
	if len(r.Segments) == 0 {
		return errors.New("segments are empty")
	}
	if len(r.Segments) > maxSegments {
		return errors.New("too many segments")
	}
	prev := -1
	for i := range r.Segments {
		s := &r.Segments[i]
		s.Text = strings.Join(strings.Fields(s.Text), " ")
		switch {
		case s.Text == "":
			return errors.New("segment " + strconv.Itoa(i) + " is empty")
		case utf8.RuneCountInString(s.Text) > maxSegmentChars:
			return errors.New("segment " + strconv.Itoa(i) + " is too long")
		case s.Start < 0 || s.End <= s.Start || s.Start < prev:
			return errors.New("segment " + strconv.Itoa(i) + " has bad times")
		}
		prev = s.Start
	}
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

// SourceHash identifies a caption track by its exact sentences and times, and the way it is translated.
func SourceHash(segs []SegmentInput) []byte {
	h := sha256.New()
	h.Write([]byte(translationVersion + "\x00"))
	json.NewEncoder(h).Encode(segs)
	return h.Sum(nil)
}

// Account is who is listening and on which plan.
type Account struct {
	UserID int64
	Plan   string
}

// limited reports whether the plan has a daily limit; paid plans do not.
func (a Account) limited() bool { return a.Plan == "free" }

// Segment is one stored sentence and whether it has audio in the job's voice.
type Segment struct {
	Idx        int
	Start, End int
	Source, VI string
	Translated bool
	HasAudio   bool
}

// Status is what the extension polls: which sentences are ready to play.
type Status struct {
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

// status sums up a dub's sentences, the ones that failed and the last error.
func status(id int64, voice string, segs []Segment, failed []int, lastErr string) Status {
	st := Status{ID: id, Voice: voice, Total: len(segs), Ready: []int{}, Failed: failed, Error: lastErr}
	for _, s := range segs {
		if s.Translated {
			st.Translated++
		}
		if s.HasAudio {
			st.Ready = append(st.Ready, s.Idx)
		}
	}
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
	return st
}
