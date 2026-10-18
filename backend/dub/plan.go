package dub

import "time"

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
	// SpeakConcurrency is how many sentences of one dub are sent to the speech worker at once.
	SpeakConcurrency = 2
	// maxSegmentFailures: after this many failed tries a sentence is skipped and stays silent.
	maxSegmentFailures = 3
)

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
func planWork(segs []Segment, position int, rate float64, job *dubJob, skip map[int]bool) plan {
	p := plan{translate: -1}
	if len(segs) == 0 {
		p.rest = true
		return p
	}
	cur := 0
	for i, s := range segs {
		if s.Start > position {
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
	free := SpeakConcurrency - len(job.speaking)
	for i := cur; i < len(segs) && segs[i].Start < translateEnd; i++ {
		s := segs[i]
		if skip[s.Idx] || s.HasAudio || job.speaking[s.Idx] {
			continue
		}
		if !s.Translated {
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
		if s.Start < speakEnd && free > 0 {
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
func readyAhead(segs []Segment, cur, position int, skip map[int]bool) int {
	end := position
	for i := cur; i < len(segs); i++ {
		if !segs[i].HasAudio && !skip[segs[i].Idx] {
			break
		}
		end = slotEnd(segs, i)
	}
	return max(0, end-position)
}

// slotEnd is when sentence i's time ends: where the next one starts, or its own end for the last one.
func slotEnd(segs []Segment, i int) int {
	if i+1 < len(segs) {
		return segs[i+1].Start
	}
	return segs[i].End
}
