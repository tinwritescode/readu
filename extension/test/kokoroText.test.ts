import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixPhonemes, mergeAudio, phonemizeSentence, splitSentences, toModelInputs } from '../src/domain/kokoroText';

describe('splitSentences', () => {
  it('cuts after . ! ? … followed by a space, and keeps the rest', () => {
    expect(splitSentences(' Một.  Hai!  3.5 triệu… Bốn ')).toEqual(['Một.', 'Hai!', '3.5 triệu…', 'Bốn']);
  });
});

describe('fixPhonemes', () => {
  it('maps tones and restores Vietnamese onsets', () => {
    expect(fixPhonemes('ta1')).toBe('ta→');
    expect(fixPhonemes('tʃa2', 'trà')).toBe('ʈʂa↘');
    expect(fixPhonemes('sa1', 'sa')).toBe('ʂa→');
    expect(fixPhonemes('sta1', 'star')).toBe('sta→');
    expect(fixPhonemes('t̪a1')).toBe('ta→');
  });
});

describe('phonemizeSentence', () => {
  it('phonemises the words together, or one by one when the counts differ', () => {
    const together = { normalize: (t: string) => t, phonemize: (t: string) => (t.includes(' ') ? 'a1 b2' : 'x') };
    expect(phonemizeSentence('A, B.', together)).toBe('a→, b↘.');
    const split = { normalize: (t: string) => t, phonemize: (t: string) => (t.includes(' ') ? 'ab1' : t.toLowerCase() + '1') };
    expect(phonemizeSentence('A B', split)).toBe('a→ b→');
  });
});

describe('mergeAudio', () => {
  it('crossfades 50 ms between chunks', () => {
    const a = new Float32Array(2000).fill(1), b = new Float32Array(2000).fill(0);
    const m = mergeAudio([a, b]);
    expect(m.length).toBe(2800);
    expect(m[799]).toBe(1);
    expect(m[2000]).toBe(0);
    expect(m[1400]).toBeCloseTo(0.5, 2);
  });
});

// The speech worker's own model input for these sentences, computed in Python.
const golden = JSON.parse(readFileSync(new URL('./fixtures/kokoro-inputs.json', import.meta.url), 'utf8')) as { text: string; ids: number[]; styleIndex: number }[];
const dict = process.env.SEA_G2P_DICT;

describe.skipIf(!dict)('toModelInputs against the speech worker (set SEA_G2P_DICT to sea_g2p.bin)', async () => {
  // skipIf still runs this body, so it stops here without the dictionary.
  if (!dict) return;
  const { initSync, SeaG2p } = await import('../vendor/sea-g2p/sea_g2p_rs.js');
  initSync({ module: readFileSync(new URL('../vendor/sea-g2p/sea_g2p_rs_bg.wasm', import.meta.url)) });
  const g2p = new SeaG2p(readFileSync(dict!));
  const vocab = JSON.parse(readFileSync(new URL('./fixtures/kokoro-vocab.json', import.meta.url), 'utf8')) as Record<string, number>;
  for (const g of golden) {
    it(g.text, () => {
      expect(toModelInputs(g.text, g2p, vocab)).toEqual([{ ids: g.ids, styleIndex: g.styleIndex }]);
    });
  }
});
