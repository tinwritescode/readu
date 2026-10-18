package dub

import (
	"context"
	"strings"
)

// translationVersion names the prompt and batching. It is part of a dub's cache key, so changing how
// captions are translated makes new dubs instead of reusing translations made the old way.
const translationVersion = "t2"

// Translator turns a batch of English sentences into Vietnamese, one line per sentence.
type Translator interface {
	Translate(ctx context.Context, req TranslateRequest) (TranslateResult, error)
}

// TranslateRequest is one batch of a video's sentences and what helps translate them consistently.
type TranslateRequest struct {
	Title, Description string
	// Glossary holds names and terms already translated earlier in the video.
	Glossary []Term
	// Prior holds the sentences just before the batch with their translations, for flow and pronouns.
	Prior []string
	Lines []Line
}

// Line is one sentence and how long the speaker takes to say it in the video.
type Line struct {
	Text    string
	Seconds float64
}

// Term is a name or piece of jargon and how this video's dub says it.
type Term struct {
	EN string `json:"en"`
	VI string `json:"vi"`
}

type TranslateResult struct {
	Lines []string
	// Terms are new glossary entries the model chose in this batch.
	Terms []Term
}

// syllablesPerSecond is about how fast the Kokoro voice reads Vietnamese at the dub's speed. Each translation is
// asked to fit its slot at this pace, so the dub rarely has to be sped up or runs into the next sentence.
const syllablesPerSecond = 4.5

// syllableBudget is how many Vietnamese syllables fit a slot, never fewer than 3.
func syllableBudget(seconds float64) int {
	return max(3, int(seconds*syllablesPerSecond))
}

// syllables counts Vietnamese syllables, which are written as separate words.
func syllables(s string) int {
	return len(strings.Fields(s))
}

// tooLong reports whether a translation needs more than the dub may speed up to fit its slot.
func tooLong(vi string, seconds float64) bool {
	return float64(syllables(vi)) > float64(syllableBudget(seconds))*1.3
}

// maxGlossary keeps the prompt small on long videos; the earliest terms are usually the most important.
const maxGlossary = 80

// mergeGlossary adds new terms whose English is not in the glossary yet.
func mergeGlossary(glossary, add []Term) []Term {
	seen := map[string]bool{}
	for _, t := range glossary {
		seen[strings.ToLower(t.EN)] = true
	}
	for _, t := range add {
		if k := strings.ToLower(t.EN); !seen[k] && len(glossary) < maxGlossary {
			seen[k] = true
			glossary = append(glossary, t)
		}
	}
	return glossary
}
