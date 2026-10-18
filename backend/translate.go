package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

const defaultTranslateModel = "gpt-6.1-sol"

// translationVersion names the prompt and batching below. It is part of a dub's cache key, so changing how
// captions are translated makes new dubs instead of reusing translations made the old way.
const translationVersion = "t2"

// translator turns a batch of English sentences into Vietnamese, one line per sentence.
type translator interface {
	translate(ctx context.Context, req translateRequest) (translateResult, error)
}

// translateRequest is one batch of a video's sentences and what helps translate them consistently.
type translateRequest struct {
	Title, Description string
	// Glossary holds names and terms already translated earlier in the video.
	Glossary []term
	// Prior holds the sentences just before the batch with their translations, for flow and pronouns.
	Prior []string
	Lines []translateLine
}

// translateLine is one sentence and how long the speaker takes to say it in the video.
type translateLine struct {
	Text    string
	Seconds float64
}

// term is a name or piece of jargon and how this video's dub says it.
type term struct {
	EN string `json:"en"`
	VI string `json:"vi"`
}

type translateResult struct {
	Lines []string
	// Terms are new glossary entries the model chose in this batch.
	Terms []term
}

// syllablesPerSecond is about how fast the Kokoro voice reads Vietnamese at dubSpeed. Each translation is
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

// chatTranslator translates through an OpenAI-compatible chat completions endpoint.
type chatTranslator struct {
	baseURL, apiKey, model string
	client                 *http.Client
}

// newChatTranslator returns nil unless TRANSLATE_BASE_URL and TRANSLATE_API_KEY are set; dubbing is then turned off.
func newChatTranslator() *chatTranslator {
	base, key := os.Getenv("TRANSLATE_BASE_URL"), os.Getenv("TRANSLATE_API_KEY")
	if base == "" || key == "" {
		return nil
	}
	return &chatTranslator{
		baseURL: strings.TrimRight(base, "/"),
		apiKey:  key,
		model:   envOr("TRANSLATE_MODEL", defaultTranslateModel),
		client:  &http.Client{Timeout: 3 * time.Minute},
	}
}

const translateSystem = `You write the Vietnamese voice-over for an English YouTube video. A Vietnamese narrator will read your lines aloud over the video, one line per numbered sentence, timed to the original speaker.

Write the way a skilled Vietnamese dubbing translator would:
- Translate meaning, not words. Rebuild each sentence in natural Vietnamese word order; never keep English sentence structure or calques. If a line is a fragment of a longer thought, translate it so it flows from the line before and into the next.
- Match the speaker. Pick pronouns and register from the video's tone: a casual vlogger talks to viewers as "mọi người"/"các bạn" and says "mình"/"tôi"; a lecture or documentary stays neutral and polished. Keep the same choice for the whole video.
- Sound spoken, not written: short clauses, everyday words, natural particles where a Vietnamese speaker would use them. Drop English filler ("you know", "like", "basically", "um").
- Fit the time. Each line shows its length and a syllable budget, like "[2.4s, ≤10 âm tiết]". Stay within the budget by choosing tighter phrasing, never by dropping meaning.
- Numbers, dates, units and money as a Vietnamese speaker would say them; convert only when the speaker clearly gives a rough figure. Keep brand, product, person and code names as they are when Vietnamese speakers say them in English; otherwise use the common Vietnamese term.
- Follow the glossary for names and terms already chosen. Add any new name or technical term you translate to "terms".
- Lines under "Earlier lines" are already done; use them only for context.
- Never merge, split, skip or reorder lines: exactly one translation per numbered line, with the same number.

Answer with JSON only: {"lines":[{"n":1,"vi":"..."}],"terms":[{"en":"...","vi":"..."}]}`

func translatePrompt(req translateRequest) string {
	var b strings.Builder
	if req.Title != "" {
		fmt.Fprintf(&b, "Video title: %s\n", req.Title)
	}
	if req.Description != "" {
		fmt.Fprintf(&b, "Video description (start): %s\n", req.Description)
	}
	if len(req.Glossary) > 0 {
		b.WriteString("Glossary:\n")
		for _, t := range req.Glossary {
			fmt.Fprintf(&b, "- %s => %s\n", t.EN, t.VI)
		}
	}
	if len(req.Prior) > 0 {
		b.WriteString("\nEarlier lines:\n")
		for _, l := range req.Prior {
			b.WriteString(l)
			b.WriteByte('\n')
		}
	}
	b.WriteString("\nTranslate these lines:\n")
	for i, l := range req.Lines {
		fmt.Fprintf(&b, "%d. [%.1fs, ≤%d âm tiết] %s\n", i+1, l.Seconds, syllableBudget(l.Seconds), l.Text)
	}
	return b.String()
}

const shortenSystem = `You tighten Vietnamese voice-over lines that are too long for their time slot.
Each numbered line shows the English original, the current Vietnamese, and a syllable budget.
Rewrite the Vietnamese so it fits the budget and still says everything the English says, in natural spoken Vietnamese with the same pronouns and terms.
Answer with JSON only: {"lines":[{"n":1,"vi":"..."}]}`

func (c *chatTranslator) translate(ctx context.Context, req translateRequest) (translateResult, error) {
	var res translateResult
	var err error
	// A reply that skips or garbles a line is retried once; models get it right on a second try.
	for attempt := 0; attempt < 2; attempt++ {
		var raw string
		if raw, err = c.complete(ctx, translateSystem, translatePrompt(req)); err != nil {
			continue
		}
		if res, err = parseTranslation(raw, len(req.Lines)); err == nil {
			break
		}
	}
	if err != nil {
		return translateResult{}, err
	}
	c.shorten(ctx, req.Lines, res.Lines)
	return res, nil
}

// shorten rewrites, in place, the lines too long to fit their slot even sped up. It is best effort: a failure
// keeps the longer lines, which the player still fits by speeding up.
func (c *chatTranslator) shorten(ctx context.Context, lines []translateLine, vi []string) {
	var idx []int
	var b strings.Builder
	for i, l := range lines {
		if tooLong(vi[i], l.Seconds) {
			idx = append(idx, i)
			fmt.Fprintf(&b, "%d. [%.1fs, ≤%d âm tiết]\nEN: %s\nVI: %s\n", len(idx), l.Seconds, syllableBudget(l.Seconds), l.Text, vi[i])
		}
	}
	if len(idx) == 0 {
		return
	}
	raw, err := c.complete(ctx, shortenSystem, b.String())
	if err == nil {
		var short translateResult
		if short, err = parseTranslation(raw, len(idx)); err == nil {
			for k, i := range idx {
				vi[i] = short.Lines[k]
			}
			return
		}
	}
	log.Printf("shorten %d lines: %v", len(idx), err)
}

func (c *chatTranslator) complete(ctx context.Context, system, user string) (string, error) {
	body, err := json.Marshal(map[string]any{
		"model": c.model,
		"messages": []chatMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	resp, err := c.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return "", fmt.Errorf("translate: HTTP %d: %s", resp.StatusCode, msg)
	}
	var out struct {
		Choices []struct {
			Message chatMessage `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("translate: bad response: %w", err)
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("translate: no choices in response")
	}
	return out.Choices[0].Message.Content, nil
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// parseTranslation reads the model's JSON and returns one line per input line, in order, plus any new terms.
// Models sometimes wrap the JSON in a code fence or a sentence, so it reads from the first { to the last }.
func parseTranslation(raw string, want int) (translateResult, error) {
	if i, j := strings.Index(raw, "{"), strings.LastIndex(raw, "}"); i >= 0 && j > i {
		raw = raw[i : j+1]
	}
	var out struct {
		Lines []struct {
			N  int    `json:"n"`
			VI string `json:"vi"`
		} `json:"lines"`
		Terms []term `json:"terms"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return translateResult{}, fmt.Errorf("translation is not JSON: %w", err)
	}
	result := make([]string, want)
	for _, l := range out.Lines {
		if l.N >= 1 && l.N <= want {
			result[l.N-1] = strings.TrimSpace(l.VI)
		}
	}
	for i, l := range result {
		if l == "" {
			return translateResult{}, fmt.Errorf("translation is missing line %d of %d", i+1, want)
		}
	}
	var terms []term
	for _, t := range out.Terms {
		if t.EN = strings.TrimSpace(t.EN); t.EN != "" && strings.TrimSpace(t.VI) != "" {
			terms = append(terms, term{EN: t.EN, VI: strings.TrimSpace(t.VI)})
		}
	}
	return translateResult{Lines: result, Terms: terms}, nil
}

// maxGlossary keeps the prompt small on long videos; the earliest terms are usually the most important.
const maxGlossary = 80

// mergeGlossary adds new terms whose English is not in the glossary yet.
func mergeGlossary(glossary, add []term) []term {
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
