// Decides whether a video is music, where dubbing makes no sense: pure rules over what the page tells us.
import type { Json3Event } from './captions';
import type { Segment } from './types';

/** Lines like "♪ never gonna give you up ♪" or "[Music]". */
const MUSIC_MARK = /[♪♫🎵🎶]|\[(music|âm nhạc|nhạc|instrumental)[^\]]*\]/i;
/** More than this share of caption lines marked as music means a song. */
const MUSIC_LINE_SHARE = 0.4;
/** Fewer spoken words a minute than this means mostly music or silence. Talk runs at 120 or more. */
const MIN_WORDS_PER_MINUTE = 35;

export interface MusicSignals {
  /** YouTube's category for the video, e.g. "Music" or "Education". */
  category: string;
  durationSec: number;
  events: Json3Event[];
  segments: Segment[];
}

export function isMusicVideo({ category, durationSec, events, segments }: MusicSignals): boolean {
  if (category === 'Music') return true;
  const lines = events.map(e => (e.segs ?? []).map(s => s.utf8 ?? '').join('').trim()).filter(Boolean);
  if (lines.length > 0 && lines.filter(l => MUSIC_MARK.test(l)).length / lines.length > MUSIC_LINE_SHARE) return true;
  if (durationSec >= 60) {
    const words = segments.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
    if (words / (durationSec / 60) < MIN_WORDS_PER_MINUTE) return true;
  }
  return false;
}
