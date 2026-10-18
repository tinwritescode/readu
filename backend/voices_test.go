package main

import "testing"

func TestKokoroVoiceOr(t *testing.T) {
	if got := kokoroVoiceOr("duc_an"); got != "duc_an" {
		t.Fatalf("known voice became %q", got)
	}
	if got := kokoroVoiceOr("s_hochiminh_female_hanhanvani_children_vc"); got != defaultKokoroVoice {
		t.Fatalf("old Vbee voice became %q, want %q", got, defaultKokoroVoice)
	}
}
