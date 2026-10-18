package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const defaultTranslateModel = "gpt-6.1-sol"

// translator turns a batch of English sentences into Vietnamese, one line per sentence.
// prior holds the sentences just before the batch, so pronouns and terms stay consistent.
type translator interface {
	translate(ctx context.Context, prior, lines []string) ([]string, error)
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
		client:  &http.Client{Timeout: 2 * time.Minute},
	}
}

const translateSystem = `You translate English YouTube captions into Vietnamese for a voice-over.
Each numbered line is one sentence a speaker says. Translate every numbered line into natural spoken Vietnamese:
- Keep the meaning, tone and register of the speaker; use everyday words a Vietnamese narrator would say aloud.
- Keep it about as short as the English, because the Vietnamese voice must fit the same time slot.
- Write numbers, names, brands and code identifiers the way a Vietnamese speaker would read them; keep well-known English names as they are.
- Caption lines may break mid-thought or lack punctuation; translate each line on its own but keep the flow across lines.
- Never merge, split, skip or reorder lines. Return exactly one translation per numbered line, with the same number.
Lines under "Earlier context" are already translated and only help you keep terms consistent; do not translate them.
Answer with JSON only, in this shape: {"lines":[{"n":1,"vi":"..."},{"n":2,"vi":"..."}]}`

func translatePrompt(prior, lines []string) string {
	var b strings.Builder
	if len(prior) > 0 {
		b.WriteString("Earlier context:\n")
		for _, l := range prior {
			b.WriteString(l)
			b.WriteByte('\n')
		}
		b.WriteByte('\n')
	}
	b.WriteString("Translate these lines:\n")
	for i, l := range lines {
		fmt.Fprintf(&b, "%d. %s\n", i+1, l)
	}
	return b.String()
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func (c *chatTranslator) translate(ctx context.Context, prior, lines []string) ([]string, error) {
	body, err := json.Marshal(map[string]any{
		"model": c.model,
		"messages": []chatMessage{
			{Role: "system", Content: translateSystem},
			{Role: "user", Content: translatePrompt(prior, lines)},
		},
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("translate: HTTP %d: %s", resp.StatusCode, msg)
	}
	var out struct {
		Choices []struct {
			Message chatMessage `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("translate: bad response: %w", err)
	}
	if len(out.Choices) == 0 {
		return nil, fmt.Errorf("translate: no choices in response")
	}
	return parseTranslation(out.Choices[0].Message.Content, len(lines))
}

// parseTranslation reads the model's JSON and returns one line per input line, in order.
// Models sometimes wrap the JSON in a code fence or a sentence, so it reads from the first { to the last }.
func parseTranslation(raw string, want int) ([]string, error) {
	if i, j := strings.Index(raw, "{"), strings.LastIndex(raw, "}"); i >= 0 && j > i {
		raw = raw[i : j+1]
	}
	var out struct {
		Lines []struct {
			N  int    `json:"n"`
			VI string `json:"vi"`
		} `json:"lines"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, fmt.Errorf("translation is not JSON: %w", err)
	}
	result := make([]string, want)
	for _, l := range out.Lines {
		if l.N >= 1 && l.N <= want {
			result[l.N-1] = strings.TrimSpace(l.VI)
		}
	}
	for i, l := range result {
		if l == "" {
			return nil, fmt.Errorf("translation is missing line %d of %d", i+1, want)
		}
	}
	return result, nil
}
