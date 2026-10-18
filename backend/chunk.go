package main

import (
	"regexp"
	"strings"
)

var sentencePattern = regexp.MustCompile(`[^.!?;\n]+[.!?;\n]*`)

// splitText cuts s into pieces of at most max runes, breaking at sentence
// ends first, then at words, and only hard-cutting a single word that is
// longer than max.
func splitText(s string, max int) []string {
	var chunks []string
	var current []rune

	flush := func() {
		if len(current) > 0 {
			chunks = append(chunks, strings.TrimSpace(string(current)))
			current = nil
		}
	}

	for _, sentence := range sentencePattern.FindAllString(s, -1) {
		sentence = strings.TrimSpace(sentence)
		if sentence == "" {
			continue
		}
		for _, piece := range pieces(sentence, max) {
			pr := []rune(piece)
			if len(current)+len(pr)+1 > max {
				flush()
			}
			if len(current) > 0 {
				current = append(current, ' ')
			}
			current = append(current, pr...)
		}
	}
	flush()
	return chunks
}

// pieces returns sentence unchanged when it fits, else its words packed
// into runs of at most max runes.
func pieces(sentence string, max int) []string {
	if len([]rune(sentence)) <= max {
		return []string{sentence}
	}
	var out []string
	var line []rune
	for _, word := range strings.Fields(sentence) {
		for _, part := range hardCut(word, max) {
			pr := []rune(part)
			if len(line)+len(pr)+1 > max && len(line) > 0 {
				out = append(out, string(line))
				line = nil
			}
			if len(line) > 0 {
				line = append(line, ' ')
			}
			line = append(line, pr...)
		}
	}
	if len(line) > 0 {
		out = append(out, string(line))
	}
	return out
}

// hardCut splits a single word longer than max runes.
func hardCut(word string, max int) []string {
	r := []rune(word)
	if len(r) <= max {
		return []string{word}
	}
	var out []string
	for len(r) > max {
		out = append(out, string(r[:max]))
		r = r[max:]
	}
	return append(out, string(r))
}
