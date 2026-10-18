import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ByteLevelBpe, type TokenizerJson } from '../src/domain/byteLevelBpe';
import { maxExpectedFrames, packSentencesIntoChunks, phonemizeChunk, puncNorm, splitIntoSentences, syllableCount, toChunks } from '../src/domain/vieneuText';

// What the vieneu package (3.8.3) feeds VieNeu v3 Turbo for these texts, computed in Python.
const golden = JSON.parse(readFileSync(new URL('./fixtures/vieneu-inputs.json', import.meta.url), 'utf8')) as {
  text: string; chunks: string[]; gaps: string[]; phonemes: string[]; ids: number[][]; maxFrames: number[]; syllables: number[];
}[];
const tokenizer = new ByteLevelBpe(JSON.parse(readFileSync(new URL('./fixtures/vieneu-tokenizer.json', import.meta.url), 'utf8')) as TokenizerJson);

describe('splitIntoSentences', () => {
  it('cuts at sentence ends outside quotes and brackets', () => {
    // The "." inside the quote ends nothing, so the quote runs on to "Rồi đi…".
    expect(splitIntoSentences('Một. Hai! Anh nói: "Thật à? Ừ." Rồi đi… 3.5 triệu')).toEqual(['Một.', 'Hai!', 'Anh nói: "Thật à? Ừ." Rồi đi…', '3.5 triệu']);
  });
  it('ignores quotes that never close', () => {
    expect(splitIntoSentences('Anh "nói. Rồi đi.')).toEqual(['Anh "nói.', 'Rồi đi.']);
  });
});

describe('packSentencesIntoChunks', () => {
  it('packs sentences up to the limit, with a little slack for a short tail', () => {
    expect(packSentencesIntoChunks(['aaaa.', 'bbbb.', 'cc.'], 16)).toEqual(['aaaa. bbbb. cc.']);
    expect(packSentencesIntoChunks(['aaaaaaaa.', 'bbbbbbbb.'], 16)).toEqual(['aaaaaaaa.', 'bbbbbbbb.']);
    // A 2-character tail fits the slack of 16 / 8 = 2 only up to 18 characters in all; this makes 19.
    expect(packSentencesIntoChunks(['aaaaaaaaaaaaaaa.', 'x.'], 16)).toEqual(['aaaaaaaaaaaaaaa.', 'x.']);
    expect(packSentencesIntoChunks(['aaaaaaaaaaaaaa.', 'x.'], 16)).toEqual(['aaaaaaaaaaaaaa. x.']);
  });
});

describe('puncNorm', () => {
  it('forces one "." on a short sentence and adds one to a long sentence that has no ending', () => {
    expect(puncNorm('thế à?')).toBe('thế à.');
    expect(puncNorm('một hai ba bốn năm,')).toBe('một hai ba bốn năm,');
    expect(puncNorm('một hai ba bốn năm')).toBe('một hai ba bốn năm.');
    expect(puncNorm('ba. một hai ba bốn năm.')).toBe('ba, một hai ba bốn năm.');
  });
});

describe('golden phonemes, ids and frame caps', () => {
  for (const g of golden) {
    it(`tokenises and caps: ${g.text.slice(0, 40)}`, () => {
      expect(g.phonemes.map(p => tokenizer.encode(p))).toEqual(g.ids);
      expect(g.phonemes.map(syllableCount)).toEqual(g.syllables);
      expect(g.phonemes.map(maxExpectedFrames)).toEqual(g.maxFrames);
    });
  }
});

const dict = process.env.SEA_G2P_DICT;
describe.skipIf(!dict)('chunks and phonemes against the vieneu package (set SEA_G2P_DICT to sea_g2p.bin)', async () => {
  // skipIf still runs this body, so it stops here without the dictionary.
  if (!dict) return;
  const { initSync, SeaG2p } = await import('../vendor/sea-g2p/sea_g2p_rs.js');
  initSync({ module: readFileSync(new URL('../vendor/sea-g2p/sea_g2p_rs_bg.wasm', import.meta.url)) });
  const g2p = new SeaG2p(readFileSync(dict!));
  for (const g of golden) {
    it(g.text.slice(0, 60), () => {
      const { chunks, gaps } = toChunks(g.text, g2p);
      expect(chunks).toEqual(g.chunks);
      expect(gaps).toEqual(g.gaps);
      expect(chunks.map(c => phonemizeChunk(c, g2p))).toEqual(g.phonemes);
    });
  }
});
