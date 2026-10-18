import { describe, expect, it } from 'vitest';
import { isMusicVideo } from '../src/domain/music';

const talk = Array.from({ length: 60 }, (_, i) => ({ start: i * 3000, end: i * 3000 + 2900, text: 'so today we are going to look at how this works' }));

describe('isMusicVideo', () => {
  it('trusts the Music category', () => {
    expect(isMusicVideo({ category: 'Music', durationSec: 180, events: [], segments: talk })).toBe(true);
  });
  it('spots captions that are mostly music marks', () => {
    const events = [
      { segs: [{ utf8: '♪ never gonna give you up ♪' }] },
      { segs: [{ utf8: '[Music]' }] },
      { segs: [{ utf8: 'thanks for watching' }] },
    ];
    expect(isMusicVideo({ category: 'Entertainment', durationSec: 180, events, segments: talk })).toBe(true);
  });
  it('spots videos with hardly any speech', () => {
    expect(isMusicVideo({ category: 'Entertainment', durationSec: 600, events: [], segments: talk.slice(0, 3) })).toBe(true);
  });
  it('keeps talks with an intro jingle', () => {
    const events = [{ segs: [{ utf8: '[Music]' }] }, ...talk.map(t => ({ segs: [{ utf8: t.text }] }))];
    expect(isMusicVideo({ category: 'Education', durationSec: 180, events, segments: talk })).toBe(false);
  });
});
