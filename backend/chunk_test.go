package main

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSplitTextKeepsEveryWordAndRespectsLimit(t *testing.T) {
	text := "Xin chào các bạn. Hôm nay trời đẹp quá! " + strings.Repeat("từ ", 200) + "hết."
	const max = 300

	chunks := splitText(text, max)
	if len(chunks) < 2 {
		t.Fatalf("expected several chunks, got %d", len(chunks))
	}
	for i, c := range chunks {
		if n := utf8.RuneCountInString(c); n > max {
			t.Errorf("chunk %d has %d runes, limit %d", i, n, max)
		}
	}
	if got, want := strings.Join(strings.Fields(strings.Join(chunks, " ")), " "),
		strings.Join(strings.Fields(text), " "); got != want {
		t.Errorf("words changed or lost")
	}
}

func TestSplitTextHardCutsLongWord(t *testing.T) {
	word := strings.Repeat("a", 650)
	chunks := splitText(word, 300)
	if len(chunks) != 3 {
		t.Fatalf("want 3 chunks, got %d", len(chunks))
	}
}

func TestSplitTextEmpty(t *testing.T) {
	if chunks := splitText("   \n  ", 300); len(chunks) != 0 {
		t.Fatalf("want no chunks, got %v", chunks)
	}
}
