package dub

import (
	"context"
	"log"
	"sort"
	"sync"
	"time"
)

// jobIdle: a job stops when nobody has polled it for this long; the next poll starts it again.
const jobIdle = 90 * time.Second

// SpeakFunc turns Vietnamese text into MP3 in a voice.
type SpeakFunc func(ctx context.Context, text, voice string) ([]byte, error)

type jobKey struct {
	dubID int64
	voice string
}

// dubJob is the work on one dub in one voice. It follows the viewer's position.
type dubJob struct {
	position int     // ms of video time
	rate     float64 // the viewer's playback rate
	seen     time.Time
	running  bool
	// filling is set from when less than refillBelow is ready until the whole window is.
	filling     bool
	translating bool
	speaking    map[int]bool
	failures    map[int]int
	err         string
	// wake is signalled when a translation or sentence finishes or the viewer polls, so the loop plans again.
	wake chan struct{}
}

// jobs runs at most one worker per dub and voice. Work is held in memory only:
// everything finished is in Postgres, so a restart just starts again from there on the next poll.
type jobs struct {
	store     Store
	translate Translator
	speak     SpeakFunc
	idle      time.Duration
	retry     time.Duration
	now       func() time.Time

	mu   sync.Mutex
	jobs map[jobKey]*dubJob

	glossaryMu sync.Mutex
}

func newJobs(store Store, tr Translator, speak SpeakFunc) *jobs {
	return &jobs{store: store, translate: tr, speak: speak, idle: jobIdle, retry: 3 * time.Second, now: time.Now, jobs: map[jobKey]*dubJob{}}
}

// touch records where the viewer is and starts the job if it is not running.
func (j *jobs) touch(dubID int64, voice string, position int, rate float64) {
	key := jobKey{dubID, voice}
	j.mu.Lock()
	defer j.mu.Unlock()
	job := j.jobs[key]
	if job == nil {
		job = &dubJob{speaking: map[int]bool{}, failures: map[int]int{}, wake: make(chan struct{}, 1), filling: true}
		j.jobs[key] = job
	}
	job.position = position
	job.rate = rate
	job.seen = j.now()
	if !job.running {
		job.running = true
		go j.run(key)
	}
	signal(job)
}

func signal(job *dubJob) {
	select {
	case job.wake <- struct{}{}:
	default:
	}
}

func (j *jobs) failed(dubID int64, voice string) []int {
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

func (j *jobs) lastError(dubID int64, voice string) string {
	j.mu.Lock()
	defer j.mu.Unlock()
	if job := j.jobs[jobKey{dubID, voice}]; job != nil {
		return job.err
	}
	return ""
}

func (j *jobs) run(key jobKey) {
	ctx := context.Background()
	for {
		j.mu.Lock()
		job := j.jobs[key]
		if j.now().Sub(job.seen) > j.idle && len(job.speaking) == 0 && !job.translating {
			job.running = false
			j.mu.Unlock()
			return
		}
		position, rate := job.position, job.rate
		skip := map[int]bool{}
		for idx, n := range job.failures {
			if n >= maxSegmentFailures {
				skip[idx] = true
			}
		}
		j.mu.Unlock()

		segs, err := j.store.Segments(ctx, key.dubID, key.voice)
		if err != nil {
			log.Printf("dub %d: load segments: %v", key.dubID, err)
			time.Sleep(j.retry)
			continue
		}

		j.mu.Lock()
		p := planWork(segs, position, rate, job, skip)
		if p.translate >= 0 {
			job.translating = true
			go j.translateFrom(ctx, key, segs, p.translate, p.batch)
		}
		for _, i := range p.speak {
			job.speaking[segs[i].Idx] = true
			go j.speakSegment(ctx, key, segs[i])
		}
		j.mu.Unlock()

		// Wait for a piece of work to finish or the viewer to poll. A resting job still wakes now and then to
		// notice that nobody polls any more.
		select {
		case <-job.wake:
		case <-time.After(5 * time.Second):
		}
	}
}

// finish records how a piece of work on sentence idx went and wakes the loop.
func (j *jobs) finish(key jobKey, idx int, err error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	job := j.jobs[key]
	if err == nil {
		job.err = ""
	} else {
		job.failures[idx]++
		job.err = err.Error()
		log.Printf("dub %d/%s segment %d: %v", key.dubID, key.voice, idx, err)
	}
	signal(job)
}

// translateFrom translates the untranslated run of up to n sentences starting at first.
func (j *jobs) translateFrom(ctx context.Context, key jobKey, segs []Segment, first, n int) {
	err := j.translateBatch(ctx, key.dubID, segs, first, n)
	if err != nil {
		time.Sleep(j.retry)
	}
	j.mu.Lock()
	j.jobs[key].translating = false
	j.mu.Unlock()
	j.finish(key, segs[first].Idx, err)
}

func (j *jobs) translateBatch(ctx context.Context, dubID int64, segs []Segment, first, n int) error {
	end := first
	for end < len(segs) && end-first < n && !segs[end].Translated {
		end++
	}
	title, description, glossary, err := j.store.VideoContext(ctx, dubID)
	if err != nil {
		return err
	}
	req := TranslateRequest{Title: title, Description: description, Glossary: glossary}
	for i := max(0, first-translateContext); i < first; i++ {
		line := segs[i].Source
		if segs[i].Translated {
			line += " => " + segs[i].VI
		}
		req.Prior = append(req.Prior, line)
	}
	for i := first; i < end; i++ {
		req.Lines = append(req.Lines, Line{Text: segs[i].Source, Seconds: float64(slotEnd(segs, i)-segs[i].Start) / 1000})
	}
	ctx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	res, err := j.translate.Translate(ctx, req)
	if err != nil {
		return err
	}
	if len(res.Terms) > 0 {
		// Dubs of one video in two voices can translate at once; the glossary is read and written under the lock.
		j.glossaryMu.Lock()
		_, _, current, err := j.store.VideoContext(ctx, dubID)
		if err == nil {
			err = j.store.SaveGlossary(ctx, dubID, mergeGlossary(current, res.Terms))
		}
		j.glossaryMu.Unlock()
		if err != nil {
			log.Printf("dub %d: save glossary: %v", dubID, err)
		}
	}
	return j.store.SaveTranslations(ctx, dubID, segs[first].Idx, res.Lines)
}

func (j *jobs) speakSegment(ctx context.Context, key jobKey, seg Segment) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	audio, err := j.speak(ctx, seg.VI, key.voice)
	if err == nil {
		err = j.store.SaveAudio(ctx, key.dubID, seg.Idx, key.voice, audio)
	}
	if err != nil {
		time.Sleep(j.retry)
	}
	j.mu.Lock()
	delete(j.jobs[key].speaking, seg.Idx)
	j.mu.Unlock()
	j.finish(key, seg.Idx, err)
}
