package main

import (
	"context"
	"log"
	"sort"
	"sync"
	"time"
)

const (
	// speakWindow is how far ahead of the viewer, in video time, sentences are spoken in advance.
	speakWindow = 3 * time.Minute
	// refillBelow: once the window is full the job rests until less than this much is ready ahead.
	refillBelow = 90 * time.Second
	// translateWindow runs ahead of speakWindow so speaking never waits on the translator.
	translateWindow = 5 * time.Minute
	// firstBatch is the size of a batch the viewer is waiting on: small, so the first words come fast.
	firstBatch = 8
	// translateBatch is the size of later batches: enough for the model to follow the talk, back in seconds.
	translateBatch = 40
	// translateContext is how many earlier sentences, with their translations, ride along into the next batch.
	translateContext = 6
	// speakConcurrency is how many sentences of one dub are sent to the speech worker at once.
	speakConcurrency = 2
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

	glossaryMu sync.Mutex
}

func newDubJobs(store *dubStore, tr translator, speak speakFunc) *dubJobs {
	return &dubJobs{store: store, translate: tr, speak: speak, idle: dubJobIdle, retry: 3 * time.Second, now: time.Now, jobs: map[jobKey]*dubJob{}}
}

// touch records where the viewer is and starts the job if it is not running.
func (j *dubJobs) touch(dubID int64, voice string, position int, rate float64) {
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

// windowMs scales a window given in video time by the playback rate: at 2x the viewer gets through twice as
// much video in the time the work takes, so the window is twice as long.
func windowMs(d time.Duration, rate float64) int {
	return int(float64(d.Milliseconds()) * max(1, rate))
}

// plan is what the job starts next.
type plan struct {
	speak     []int // sentences to start speaking
	translate int   // first sentence of a batch to translate, or -1
	batch     int   // size of that batch
	rest      bool  // nothing to do until the viewer moves on
}

// planWork decides the next work from the dub's sentences and the viewer's position. It speaks the sentences
// missing audio from the one playing through speakWindow, translating ahead up to translateWindow, and rests
// once the window is full until less than refillBelow is ready ahead. It updates job.filling.
func planWork(segs []dubSegment, position int, rate float64, job *dubJob, skip map[int]bool) plan {
	p := plan{translate: -1}
	if len(segs) == 0 {
		p.rest = true
		return p
	}
	cur := 0
	for i, s := range segs {
		if s.start > position {
			break
		}
		cur = i
	}
	ahead := readyAhead(segs, cur, position, skip)
	switch {
	case ahead >= windowMs(speakWindow, rate):
		job.filling = false
	case ahead < windowMs(refillBelow, rate):
		job.filling = true
	}
	if !job.filling {
		p.rest = true
		return p
	}

	speakEnd := position + windowMs(speakWindow, rate)
	translateEnd := position + windowMs(translateWindow, rate)
	free := speakConcurrency - len(job.speaking)
	for i := cur; i < len(segs) && segs[i].start < translateEnd; i++ {
		s := segs[i]
		if skip[s.idx] || s.hasAudio || job.speaking[s.idx] {
			continue
		}
		if !s.translated {
			if !job.translating {
				p.translate = i
				// The viewer is waiting on the sentence playing now: a small batch gets them sound sooner.
				p.batch = translateBatch
				if i == cur {
					p.batch = firstBatch
				}
			}
			// Later sentences wait for this one's batch.
			break
		}
		if s.start < speakEnd && free > 0 {
			p.speak = append(p.speak, i)
			free--
		}
	}
	if len(p.speak) == 0 && p.translate < 0 && len(job.speaking) == 0 && !job.translating {
		// Nothing in the window can be done: the rest failed, or the video ends inside the window.
		job.filling = false
		p.rest = true
	}
	return p
}

// readyAhead is how much video time, from position, has audio ready without a gap.
func readyAhead(segs []dubSegment, cur, position int, skip map[int]bool) int {
	end := position
	for i := cur; i < len(segs); i++ {
		if !segs[i].hasAudio && !skip[segs[i].idx] {
			break
		}
		end = slotEnd(segs, i)
	}
	return max(0, end-position)
}

// slotEnd is when sentence i's time ends: where the next one starts, or its own end for the last one.
func slotEnd(segs []dubSegment, i int) int {
	if i+1 < len(segs) {
		return segs[i+1].start
	}
	return segs[i].end
}

func (j *dubJobs) run(key jobKey) {
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

		segs, err := j.store.segments(ctx, key.dubID, key.voice)
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
			job.speaking[segs[i].idx] = true
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
func (j *dubJobs) finish(key jobKey, idx int, err error) {
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
func (j *dubJobs) translateFrom(ctx context.Context, key jobKey, segs []dubSegment, first, n int) {
	err := j.translateBatch(ctx, key.dubID, segs, first, n)
	if err != nil {
		time.Sleep(j.retry)
	}
	j.mu.Lock()
	j.jobs[key].translating = false
	j.mu.Unlock()
	j.finish(key, segs[first].idx, err)
}

func (j *dubJobs) translateBatch(ctx context.Context, dubID int64, segs []dubSegment, first, n int) error {
	end := first
	for end < len(segs) && end-first < n && !segs[end].translated {
		end++
	}
	title, description, glossary, err := j.store.context(ctx, dubID)
	if err != nil {
		return err
	}
	req := translateRequest{Title: title, Description: description, Glossary: glossary}
	for i := max(0, first-translateContext); i < first; i++ {
		line := segs[i].source
		if segs[i].translated {
			line += " => " + segs[i].vi
		}
		req.Prior = append(req.Prior, line)
	}
	for i := first; i < end; i++ {
		req.Lines = append(req.Lines, translateLine{Text: segs[i].source, Seconds: float64(slotEnd(segs, i)-segs[i].start) / 1000})
	}
	ctx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	res, err := j.translate.translate(ctx, req)
	if err != nil {
		return err
	}
	if len(res.Terms) > 0 {
		// Dubs of one video in two voices can translate at once; the glossary is read and written under the lock.
		j.glossaryMu.Lock()
		_, _, current, err := j.store.context(ctx, dubID)
		if err == nil {
			err = j.store.saveGlossary(ctx, dubID, mergeGlossary(current, res.Terms))
		}
		j.glossaryMu.Unlock()
		if err != nil {
			log.Printf("dub %d: save glossary: %v", dubID, err)
		}
	}
	return j.store.saveTranslations(ctx, dubID, segs[first].idx, res.Lines)
}

func (j *dubJobs) speakSegment(ctx context.Context, key jobKey, seg dubSegment) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	audio, err := j.speak(ctx, seg.vi, key.voice)
	if err == nil {
		err = j.store.saveAudio(ctx, key.dubID, seg.idx, key.voice, audio)
	}
	if err != nil {
		time.Sleep(j.retry)
	}
	j.mu.Lock()
	delete(j.jobs[key].speaking, seg.idx)
	j.mu.Unlock()
	j.finish(key, seg.idx, err)
}
