// When the video waits for the dub, like YouTube waits for its own buffer.
import { slotMs } from './timing';
import type { Segment } from './types';

/** Dub ready ahead (ms of video time) before a video starts playing with the dub. */
export const START_BUFFER_MS = 30_000;
/** Dub ready ahead before a video paused mid-way for the dub plays again. */
export const RESUME_BUFFER_MS = 15_000;

/**
 * How much video time from t (ms) has dub ready without a gap: the sentence playing at t, or the next one, and
 * every following sentence for which done(i) holds. Infinity when the dub is ready to the end of the video.
 */
export function readyAheadMs(segs: Segment[], t: number, done: (i: number) => boolean): number {
  let i = segs.findIndex((s, k) => s.start + slotMs(segs, k) > t);
  if (i < 0) return Infinity;
  let end = t;
  for (; i < segs.length; i++) {
    if (!done(i)) return Math.max(0, end - t);
    end = segs[i].start + slotMs(segs, i);
  }
  return Infinity;
}
