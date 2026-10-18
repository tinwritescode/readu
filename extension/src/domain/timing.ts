// Decides which dubbed sentence should be playing at a point in the video, and how fast.
import type { Segment } from './types';

/** The dub may speed up by at most this much to fit a sentence into its slot. */
export const MAX_FIT = 1.35;
/** A sentence is not started more than this late (ms of video time); a late start sounds worse than a skip. */
export const LATE_START_MS = 2500;

/**
 * The index of the sentence whose slot holds time t (ms), or -1 before the first sentence and in gaps after a
 * sentence has ended. A slot runs from a sentence's start to the next sentence's start.
 */
export function segmentAt(segs: Segment[], t: number): number {
  let lo = 0;
  let hi = segs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return -1;
  const next = segs[found + 1];
  const slotEnd = next ? next.start : segs[found].end + 2000;
  return t < slotEnd ? found : -1;
}

/** Slot length in ms of video time: until the next sentence, or the sentence's own end for the last one. */
export function slotMs(segs: Segment[], i: number): number {
  const next = segs[i + 1];
  return Math.max(1, (next ? next.start : segs[i].end + 1000) - segs[i].start);
}

/**
 * Playback rate for a sentence: the video's rate, sped up when the Vietnamese audio is longer than its slot,
 * up to MAX_FIT.
 */
export function playbackRate(audioSec: number, slot: number, videoRate: number): number {
  const fit = Math.min(MAX_FIT, Math.max(1, audioSec / (slot / 1000)));
  return videoRate * fit;
}
