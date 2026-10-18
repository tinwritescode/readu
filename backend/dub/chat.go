package dub

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// ChatTranslator translates through an OpenAI-compatible chat completions endpoint.
type ChatTranslator struct {
	baseURL, apiKey, model string
	client                 *http.Client
}

// NewChatTranslator talks to the chat completions API at baseURL with key and model.
func NewChatTranslator(baseURL, key, model string) *ChatTranslator {
	return &ChatTranslator{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  key,
		model:   model,
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

func translatePrompt(req TranslateRequest) string {
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

func (c *ChatTranslator) Translate(ctx context.Context, req TranslateRequest) (TranslateResult, error) {
	var res TranslateResult
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
		return TranslateResult{}, err
	}
	c.shorten(ctx, req.Lines, res.Lines)
	return res, nil
}

// shorten rewrites, in place, the lines too long to fit their slot even sped up. It is best effort: a failure
// keeps the longer lines, which the player still fits by speeding up.
func (c *ChatTranslator) shorten(ctx context.Context, lines []Line, vi []string) {
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
		var short TranslateResult
		if short, err = parseTranslation(raw, len(idx)); err == nil {
			for k, i := range idx {
				vi[i] = short.Lines[k]
			}
			return
		}
	}
	log.Printf("shorten %d lines: %v", len(idx), err)
}

func (c *ChatTranslator) complete(ctx context.Context, system, user string) (string, error) {
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
func parseTranslation(raw string, want int) (TranslateResult, error) {
	if i, j := strings.Index(raw, "{"), strings.LastIndex(raw, "}"); i >= 0 && j > i {
		raw = raw[i : j+1]
	}
	var out struct {
		Lines []struct {
			N  int    `json:"n"`
			VI string `json:"vi"`
		} `json:"lines"`
		Terms []Term `json:"terms"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return TranslateResult{}, fmt.Errorf("translation is not JSON: %w", err)
	}
	result := make([]string, want)
	for _, l := range out.Lines {
		if l.N >= 1 && l.N <= want {
			result[l.N-1] = strings.TrimSpace(l.VI)
		}
	}
	for i, l := range result {
		if l == "" {
			return TranslateResult{}, fmt.Errorf("translation is missing line %d of %d", i+1, want)
		}
	}
	var terms []Term
	for _, t := range out.Terms {
		if t.EN = strings.TrimSpace(t.EN); t.EN != "" && strings.TrimSpace(t.VI) != "" {
			terms = append(terms, Term{EN: t.EN, VI: strings.TrimSpace(t.VI)})
		}
	}
	return TranslateResult{Lines: result, Terms: terms}, nil
}
