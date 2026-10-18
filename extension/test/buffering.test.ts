import { describe, expect, it } from 'vitest';
import { readyAheadMs } from '../src/domain/buffering';

// Ten sentences of 3 s each.
const segs = Array.from({ length: 10 }, (_, i) => ({ start: i * 3000, end: i * 3000 + 2500, text: 's' }));

describe('readyAheadMs', () => {
  it('counts ready sentences from the one playing until the first gap', () => {
    expect(readyAheadMs(segs, 0, i => i < 4)).toBe(12000);
    expect(readyAheadMs(segs, 1000, i => i < 4)).toBe(11000);
  });
  it('is zero when the sentence playing is not ready', () => {
    expect(readyAheadMs(segs, 4000, i => i !== 1)).toBe(0);
  });
  it('is unlimited when the dub is ready to the end', () => {
    expect(readyAheadMs(segs, 20000, i => i >= 6)).toBe(Infinity);
  });
  it('starts from the next sentence in a gap', () => {
    const gappy = [{ start: 0, end: 1000, text: 'a' }, { start: 10000, end: 12000, text: 'b' }, { start: 13000, end: 14000, text: 'c' }];
    // The first slot runs to the next start, so 5 s is still in it; sentence 0 is not ready.
    expect(readyAheadMs(gappy, 5000, i => i > 0)).toBe(0);
    expect(readyAheadMs(gappy, 5000, () => true)).toBe(Infinity);
  });
});
