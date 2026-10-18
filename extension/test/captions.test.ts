import { describe, expect, it } from 'vitest';
import { pickTrack, toSegments } from '../src/captions';
import { playbackRate, segmentAt } from '../src/timing';

describe('toSegments', () => {
  it('splits manual cues at sentence ends, joining cues that run on', () => {
    const segs = toSegments([
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello everyone.' }] },
      { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'Today we will\nlearn' }] },
      { tStartMs: 4000, dDurationMs: 1500, segs: [{ utf8: 'about Go.' }] },
    ]);
    expect(segs).toEqual([
      { start: 0, end: 2000, text: 'Hello everyone.' },
      { start: 2000, end: 5500, text: 'Today we will learn about Go.' },
    ]);
  });

  it('splits unpunctuated auto captions at pauses and drops sound tags', () => {
    const segs = toSegments([
      { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: '[Music]' }] },
      { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: 'so' }, { utf8: ' this', tOffsetMs: 300 }, { utf8: ' works', tOffsetMs: 600 }] },
      { tStartMs: 4000, dDurationMs: 10, segs: [{ utf8: '\n' }] },
      { tStartMs: 7000, dDurationMs: 800, segs: [{ utf8: 'next' }, { utf8: ' part', tOffsetMs: 400 }] },
    ]);
    expect(segs.map(s => s.text)).toEqual(['so this works', 'next part']);
    expect(segs[0]).toMatchObject({ start: 3000, end: 4000 });
  });

  it('joins a short fragment to the sentence after it', () => {
    const segs = toSegments([
      { tStartMs: 0, dDurationMs: 600, segs: [{ utf8: 'and' }, { utf8: ' then', tOffsetMs: 300 }] },
      { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'we' }, { utf8: ' ship', tOffsetMs: 400 }, { utf8: ' the', tOffsetMs: 800 }, { utf8: ' build', tOffsetMs: 1200 }] },
    ]);
    expect(segs.map(s => s.text)).toEqual(['and then we ship the build']);
  });

  it('cuts run-on text at 30 words', () => {
    const text = Array.from({ length: 45 }, (_, i) => `w${i}`).join(' ');
    const segs = toSegments([{ tStartMs: 0, dDurationMs: 9000, segs: [{ utf8: text }] }]);
    expect(segs.map(s => s.text.split(' ').length)).toEqual([30, 15]);
  });
});

describe('pickTrack', () => {
  const asr = { baseUrl: 'a', languageCode: 'en', kind: 'asr' };
  const manual = { baseUrl: 'm', languageCode: 'en-US' };
  const fr = { baseUrl: 'f', languageCode: 'fr', isTranslatable: true };
  it('prefers manual English, then auto English, then a translatable track', () => {
    expect(pickTrack([asr, manual])?.track).toBe(manual);
    expect(pickTrack([fr, asr])?.track).toBe(asr);
    expect(pickTrack([fr])).toEqual({ track: fr, translate: true });
    expect(pickTrack([])).toBeNull();
  });
});

describe('timing', () => {
  const segs = [
    { start: 1000, end: 2000, text: 'a' },
    { start: 3000, end: 4000, text: 'b' },
  ];
  it('finds the slot holding a time', () => {
    expect(segmentAt(segs, 500)).toBe(-1);
    expect(segmentAt(segs, 2500)).toBe(0);
    expect(segmentAt(segs, 3000)).toBe(1);
    expect(segmentAt(segs, 6500)).toBe(-1);
  });
  it('speeds up long audio, within limits', () => {
    expect(playbackRate(1, 2000, 1)).toBe(1);
    expect(playbackRate(2.4, 2000, 1)).toBeCloseTo(1.2);
    expect(playbackRate(10, 2000, 1.5)).toBeCloseTo(1.5 * 1.35);
  });
});
