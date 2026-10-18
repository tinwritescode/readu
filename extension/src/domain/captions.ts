// Turns a YouTube caption track (json3 format) into sentences with times.
import type { Segment } from './types';

/** The parts of a json3 caption event this code reads. */
export interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string; tOffsetMs?: number }>;
}

interface Word {
  start: number;
  end: number;
  text: string;
}

/** A sentence ends on . ! ? or … with optional closing quotes or brackets. */
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
/** Sound tags like [Music] or (applause) are not speech. */
const SOUND_TAG = /^[[(][^\])]*[\])]$/;
/** A pause this long ends a sentence in captions without punctuation. */
const PAUSE_MS = 1200;
/** Long run-on caption text is cut so each line fits a voice-over slot. */
const MAX_WORDS = 30;
const MAX_MS = 15000;
/** A piece shorter than this many words is joined to the next one; a dub of two words at a time sounds choppy. */
const MIN_WORDS = 4;
/** ...unless the speaker pauses this long between them. */
const JOIN_GAP_MS = 1500;

/** Flattens caption events into timed words. Auto captions carry a time per word; manual ones per cue. */
function words(events: Json3Event[]): Word[] {
  const out: Word[] = [];
  for (const ev of events) {
    if (!ev.segs || ev.tStartMs === undefined) continue;
    const evEnd = ev.tStartMs + (ev.dDurationMs ?? 0);
    const parts = ev.segs
      .map(s => ({ start: ev.tStartMs! + (s.tOffsetMs ?? 0), text: (s.utf8 ?? '').replace(/\s+/g, ' ').trim() }))
      .filter(p => p.text !== '');
    parts.forEach((p, i) => {
      const next = parts[i + 1];
      for (const text of p.text.replace(/>>/g, ' ').split(' ')) {
        if (text) out.push({ start: p.start, end: next ? next.start : evEnd, text });
      }
    });
  }
  // Drop sound tags, which may be split over words like "[Music" "playing]".
  const kept: Word[] = [];
  let tag: Word[] | null = null;
  for (const w of out) {
    if (tag) {
      tag.push(w);
      if (/[\])]$/.test(w.text)) tag = null;
      continue;
    }
    if (/^[[(]/.test(w.text) && !SOUND_TAG.test(w.text)) {
      tag = [w];
      continue;
    }
    if (!SOUND_TAG.test(w.text)) kept.push(w);
  }
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

/** Groups caption words into sentences. Each sentence ends where the next one starts, at the latest. */
export function toSegments(events: Json3Event[]): Segment[] {
  const ws = words(events);
  const groups: Word[][] = [];
  let cur: Word[] = [];
  ws.forEach((w, i) => {
    cur.push(w);
    const next = ws[i + 1];
    const end =
      !next ||
      SENTENCE_END.test(w.text) ||
      (next.start - w.end > PAUSE_MS && cur.length >= 3) ||
      cur.length >= MAX_WORDS ||
      w.end - cur[0].start >= MAX_MS;
    if (end) {
      groups.push(cur);
      cur = [];
    }
  });
  const merged: Word[][] = [];
  for (const g of groups) {
    const prev = merged[merged.length - 1];
    const joinable =
      prev &&
      prev.length < MIN_WORDS &&
      !SENTENCE_END.test(prev[prev.length - 1].text) &&
      g[0].start - prev[prev.length - 1].end <= JOIN_GAP_MS &&
      prev.length + g.length <= MAX_WORDS &&
      g[g.length - 1].end - prev[0].start <= MAX_MS;
    if (joinable) prev.push(...g);
    else merged.push(g);
  }
  return merged.map((g, i) => {
    const nextStart = merged[i + 1]?.[0].start ?? Infinity;
    const start = g[0].start;
    const end = Math.max(start + 1, Math.min(g[g.length - 1].end, nextStart));
    return { start, end, text: g.map(w => w.text).join(' ') };
  });
}

/** A caption track as listed in the player response. */
export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  isTranslatable?: boolean;
}

/**
 * Picks the track to dub: hand-made English first, then auto-generated English, then any track YouTube can
 * translate to English (tlang=en). Returns null when the video has no usable captions.
 */
export function pickTrack(tracks: CaptionTrack[]): { track: CaptionTrack; translate: boolean } | null {
  const en = tracks.filter(t => t.languageCode === 'en' || t.languageCode.startsWith('en-'));
  const manual = en.find(t => t.kind !== 'asr');
  if (manual) return { track: manual, translate: false };
  if (en[0]) return { track: en[0], translate: false };
  const other = tracks.find(t => t.kind !== 'asr' && t.isTranslatable) ?? tracks.find(t => t.isTranslatable);
  return other ? { track: other, translate: true } : null;
}
