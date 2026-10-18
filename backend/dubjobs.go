package main

import (
	"context"
	"log"
	"sort"
	"sync"
	"time"
)

const (
	// translateBatch is how many sentences go to the translator at once; enough context, short enough to come back fast.
	translateBatch = 25
	// translateContext is how many earlier sentences ride along so terms stay consistent across batches.
	translateContext = 4
	// maxSegmentFailures: after this many failed tries a sentence is skipped and stays silent.
	maxSegmentFailures = 3
	// dubJobIdle: a job stops when nobody has polled it for this long; the next poll starts it again.
	dubJobIdle = 90 * time.Second
)

// speakFunc turns Vietnamese text into MP3 in a voice.
type speakFunc func(ctx context.Context, text, voice string) ([]byte, error)

type jobKey struct {
	dubID int64
	voice string
}

// dubJob is the work on one dub in one voice. It follows the viewer's position.
type dubJob struct {
	position int // ms
	seen     time.Time
	running  bool
	failures map[int]int
	err      string
}

// dubJobs runs at most one worker per dub and voice. Work is held in memory only:
// everything finished is in Postgres, so a restart just starts again from there on the next poll.
type dubJobs struct {
	store     *dubStore
	translate translator
	speak     speakFunc
	idle      time.Duration
	retry     time.Duration
	now       func() time.Time

	mu   sync.Mutex
	jobs map[jobKey]*dubJob
}

func newDubJobs(store *dubStore, tr translator, speak speakFunc) *dubJobs {
	return &dubJobs{store: store, translate: tr, speak: speak, idle: dubJobIdle, retry: 3 * time.Second, now: time.Now, jobs: map[jobKey]*dubJob{}}
}

// touch records that a viewer is at position and starts the job if it is not running.
func (j *dubJobs) touch(dubID int64, voice string, position int) {
	key := jobKey{dubID, voice}
	j.mu.Lock()
	defer j.mu.Unlock()
	job := j.jobs[key]
	if job == nil {
		job = &dubJob{failures: map[int]int{}}
		j.jobs[key] = job
	}
	job.position = position
	job.seen = j.now()
	if !job.running {
		job.running = true
		go j.run(key)
	}
}

func (j *dubJobs) failed(dubID int64, voice string) []int {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := []int{}
	if job := j.jobs[jobKey{dubID, voice}]; job != nil {
		for idx, n := range job.failures {
			if n >= maxSegmentFailures {
				out = append(out, idx)
			}
		}
	}
	sort.Ints(out)
	return out
}

func (j *dubJobs) lastError(dubID int64, voice string) string {
	j.mu.Lock()
	defer j.mu.Unlock()
	if job := j.jobs[jobKey{dubID, voice}]; job != nil {
		return job.err
	}
	return ""
}

// next reports where the viewer is and which sentences to skip, or ok=false when the job should stop.
func (j *dubJobs) next(key jobKey) (position int, skip map[int]bool, ok bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	job := j.jobs[key]
	if j.now().Sub(job.seen) > j.idle {
		job.running = false
		return 0, nil, false
	}
	skip = map[int]bool{}
	for idx, n := range job.failures {
		if n >= maxSegmentFailures {
			skip[idx] = true
		}
	}
	return job.position, skip, true
}

func (j *dubJobs) finish(key jobKey, idx int, err error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	job := j.jobs[key]
	if err == nil {
		job.err = ""
		return
	}
	job.failures[idx]++
	job.err = err.Error()
}

func (j *dubJobs) stop(key jobKey) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.jobs[key].running = false
}

func (j *dubJobs) run(key jobKey) {
	ctx := context.Background()
	for {
		position, skip, ok := j.next(key)
		if !ok {
			return
		}
		segs, err := j.store.segments(ctx, key.dubID, key.voice)
		if err != nil {
			log.Printf("dub %d: load segments: %v", key.dubID, err)
			time.Sleep(j.retry)
			continue
		}
		target := pickNextSegment(segs, position, skip)
		if target < 0 {
			j.stop(key)
			return
		}
		if !segs[target].translated {
			err = j.translateFrom(ctx, key.dubID, segs, target)
		} else {
			err = j.speakSegment(ctx, key, segs[target])
		}
		j.finish(key, target, err)
		if err != nil {
			log.Printf("dub %d/%s segment %d: %v", key.dubID, key.voice, target, err)
			time.Sleep(j.retry)
		}
	}
}

// translateFrom translates the untranslated run of sentences starting at first.
func (j *dubJobs) translateFrom(ctx context.Context, dubID int64, segs []dubSegment, first int) error {
	end := first
	for end < len(segs) && end-first < translateBatch && !segs[end].translated {
		end++
	}
	var prior []string
	for i := max(0, first-translateContext); i < first; i++ {
		line := segs[i].source
		if segs[i].translated {
			line += " => " + segs[i].vi
		}
		prior = append(prior, line)
	}
	lines := make([]string, 0, end-first)
	for _, s := range segs[first:end] {
		lines = append(lines, s.source)
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	vi, err := j.translate.translate(ctx, prior, lines)
	if err != nil {
		return err
	}
	return j.store.saveTranslations(ctx, dubID, first, vi)
}

func (j *dubJobs) speakSegment(ctx context.Context, key jobKey, seg dubSegment) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	audio, err := j.speak(ctx, seg.vi, key.voice)
	if err != nil {
		return err
	}
	return j.store.saveAudio(ctx, key.dubID, seg.idx, key.voice, audio)
}

// pickNextSegment returns the sentence to work on next: the one playing at position, then the ones after it,
// then wrapping to the start. It returns -1 when every sentence has audio or was given up on.
func pickNextSegment(segs []dubSegment, position int, skip map[int]bool) int {
	current := 0
	for i, s := range segs {
		if s.start > position {
			break
		}
		current = i
	}
	for n := range len(segs) {
		i := (current + n) % len(segs)
		if !segs[i].hasAudio && !skip[segs[i].idx] {
			return i
		}
	}
	return -1
}
