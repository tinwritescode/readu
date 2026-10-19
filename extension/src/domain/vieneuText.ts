// Vietnamese text to VieNeu v3 Turbo model input, the same steps the vieneu package (3.8.3) takes before it
// runs the model: the text is cut into sentences on the raw text, each sentence is normalised by sea-g2p, the
// sentences are packed into chunks of about 256 characters, and each chunk is phonemised and tokenised.
// Inline emotion cues ([cười], [thở dài]) are left out: dub captions never carry them.
import type { SeaG2pStages } from './kokoroText';

export const MAX_CHUNK_CHARS = 256;
const MIN_CHUNK_CHARS = 20;
export type Gap = 'para' | 'sentence' | 'minor';
/** The pause, in seconds, a chunk boundary needs (V3_GAP_SILENCE). */
export const GAP_SILENCE: Record<Gap, number> = { para: 0.7, sentence: 0.5, minor: 0.3 };

// ── Sentences (core_utils._scan_sentences), on the raw text so a quoted "?" does not end one ──
const OPEN_TO_CLOSE: Record<string, string> = {
  '(': ')', '[': ']', '{': '}', '“': '”', '‘': '’', '«': '»', '‹': '›', '「': '」', '『': '』',
};
const OPENERS = new Set(Object.keys(OPEN_TO_CLOSE));
const CLOSERS = new Set(Object.values(OPEN_TO_CLOSE));
const SENT_END = new Set('.!?…');
const TRAILING_CLOSE = new Set([...CLOSERS, '"', "'", '’', '”']);
const isSpace = (c: string) => /\s/u.test(c);

function scanSentences(text: string, quoteAware: boolean): [string[], boolean] {
  const out: string[] = [];
  const n = text.length;
  let start = 0;
  let i = 0;
  let depth = 0;
  let inQuote = false;
  while (i < n) {
    const ch = text[i];
    if (quoteAware && ch === '"') inQuote = !inQuote;
    else if (quoteAware && OPENERS.has(ch)) depth++;
    else if (quoteAware && CLOSERS.has(ch)) {
      if (depth) depth--;
    } else if (SENT_END.has(ch) && depth === 0 && !inQuote) {
      let j = i + 1;
      while (j < n && SENT_END.has(text[j])) j++;
      while (j < n && TRAILING_CLOSE.has(text[j])) j++;
      // Only a boundary before a space or the end, so "3.5 triệu" stays whole.
      if (j >= n || isSpace(text[j])) {
        out.push(text.slice(start, j));
        start = i = j;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }
  if (start < n) out.push(text.slice(start));
  return [out.map(s => s.trim()).filter(Boolean), depth === 0 && !inQuote];
}

export function splitIntoSentences(text: string): string[] {
  if (!text) return [];
  const [sentences, balanced] = scanSentences(text, true);
  return balanced ? sentences : scanSentences(text, false)[0];
}

// ── Packing sentences into chunks (core_utils.pack_sentences_into_chunks) ──
const CONN_WORDS = new Set('và nhưng hoặc song rồi nên vì nếu khi để do bởi'.split(' '));
const CONN_PAIRS = new Set(
  [
    'sau khi', 'trước khi', 'trong khi', 'mỗi khi', 'đến khi', 'tới khi', 'cho nên', 'cho đến',
    'bởi vì', 'nếu như', 'tuy nhiên', 'thế nhưng', 'vì vậy', 'vì thế', 'do đó', 'sau đó',
  ],
);
const CONN_STRIP = new Set('"\'“”‘’()[]«»…');
const NUMBER_WORDS = new Set(
  'không một mốt hai ba bốn tư năm lăm sáu bảy tám chín mười mươi trăm nghìn ngàn triệu tỷ tỉ linh lẻ phẩy chấm'.split(' '),
);
const TOKEN_KEEP_EN = /<en>[\s\S]*?<\/en>|\S+/giu;
const MINOR_PUNCT = /(?<=[,;:\-–—])\s+/u;

function connKey(token: string): string {
  let a = 0;
  let b = token.length;
  while (a < b && CONN_STRIP.has(token[a])) a++;
  while (b > a && CONN_STRIP.has(token[b - 1])) b--;
  return token.slice(a, b).toLowerCase();
}
const isPair = (a: string, b: string) => CONN_PAIRS.has(`${a} ${b}`);
const isNumberWord = (t: string) => {
  const k = connKey(t);
  return NUMBER_WORDS.has(k) || /^\d+$/u.test(k);
};
const tailSlack = (maxChars: number) => Math.min(15, Math.floor(maxChars / 8));

function fits(curLen: number, addLen: number, maxChars: number): boolean {
  const total = curLen ? curLen + 1 + addLen : addLen;
  const slack = tailSlack(maxChars);
  return total <= maxChars || (addLen <= slack && total <= maxChars + slack);
}

function spanLen(words: string[], start: number, end: number): number {
  if (end <= start) return 0;
  let n = end - start - 1;
  for (let k = start; k < end; k++) n += words[k].length;
  return n;
}

function balancedCut(words: string[], start: number, target: number, maxChars: number, minLeft: number): number {
  let bestNat: [number, number] | null = null;
  let bestPlain: [number, number] | null = null;
  let endCap = start + 1;
  for (let j = start + 1; j < words.length; j++) {
    const left = spanLen(words, start, j);
    if (left > maxChars) break;
    endCap = j;
    const key = connKey(words[j]);
    const prev = connKey(words[j - 1]);
    const nxt = j + 1 < words.length ? connKey(words[j + 1]) : '';
    const d = Math.abs(left - target);
    const insidePair = isPair(prev, key);
    const natural = (CONN_WORDS.has(key) || isPair(key, nxt)) && !CONN_WORDS.has(prev);
    if (natural && !insidePair && left >= minLeft && (!bestNat || d < bestNat[0])) bestNat = [d, j];
    const plainOk = !insidePair && !(isNumberWord(words[j - 1]) && isNumberWord(words[j]));
    if (plainOk && (!bestPlain || d < bestPlain[0])) bestPlain = [d, j];
  }
  if (bestNat) return bestNat[1];
  if (bestPlain) return bestPlain[1];
  let end = endCap;
  while (end > start + 1 && isPair(connKey(words[end - 1]), connKey(words[end]))) end--;
  return end;
}

function splitLongPart(part: string, maxChars: number): string[] {
  const words = part.match(TOKEN_KEEP_EN) ?? [];
  const minLeft = Math.floor(maxChars / 3);
  const pieces: string[] = [];
  let start = 0;
  while (start < words.length) {
    const rest = spanLen(words, start, words.length);
    if (rest <= maxChars) {
      pieces.push(words.slice(start).join(' '));
      break;
    }
    let full = start + 1;
    while (full < words.length && spanLen(words, start, full + 1) <= maxChars) full++;
    if (fits(spanLen(words, start, full), spanLen(words, full, words.length), maxChars)) {
      pieces.push(words.slice(start).join(' '));
      break;
    }
    const nPieces = Math.ceil(rest / maxChars);
    const end = balancedCut(words, start, rest / nPieces, maxChars, minLeft);
    pieces.push(words.slice(start, end).join(' '));
    start = end;
  }
  return pieces;
}

export function packSentencesIntoChunks(sentences: string[], maxChars = MAX_CHUNK_CHARS): string[] {
  const out: string[] = [];
  let buffer = '';
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length > maxChars) {
      if (buffer) {
        out.push(buffer);
        buffer = '';
      }
      for (const p of sentence.split(MINOR_PUNCT)) {
        const part = p.trim();
        if (!part) continue;
        if (fits(buffer.length, part.length, maxChars)) {
          buffer = buffer ? `${buffer} ${part}` : part;
        } else {
          if (buffer) out.push(buffer);
          buffer = part;
          if (buffer.length > maxChars) {
            const pieces = splitLongPart(buffer, maxChars);
            out.push(...pieces.slice(0, -1));
            buffer = pieces.at(-1) ?? '';
          }
        }
      }
    } else if (buffer && !fits(buffer.length, sentence.length, maxChars)) {
      out.push(buffer);
      buffer = sentence;
    } else {
      buffer = buffer ? `${buffer} ${sentence}` : sentence;
    }
  }
  if (buffer) out.push(buffer);
  return out.map(c => c.trim()).filter(Boolean);
}

// ── punc_norm (sea-g2p 0.10 src/punc.rs apply_punc_norm): settles a chunk's closing punctuation ──
const isAlnum = (c: string) => /[\p{Alphabetic}\p{N}]/u.test(c);
const wordCount = (t: string) => t.split(/\s+/u).filter(w => [...w].some(isAlnum)).length;
const TRAILING_PUNCT = new Set(',.!?;:\u2026\u2025\u2024');

/** A fragment of one or two words that ends in "." mid-string gets "," so a list marker does not stop the reading. */
function softenShortSegments(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(/\.(\s+|$)/gu)) {
    const segment = text.slice(last, m.index);
    const hasMore = [...text.slice(m.index! + m[0].length)].some(isAlnum);
    const wc = wordCount(segment);
    out += segment + (hasMore && wc >= 1 && wc <= 2 ? ',' : '.') + m[1];
    last = m.index! + m[0].length;
  }
  return out + text.slice(last);
}

export function puncNorm(text: string): string {
  let t = text.trimEnd();
  if (!t) return t;
  t = softenShortSegments(t).trimEnd();
  if (wordCount(t) <= 4) {
    // A short sentence ends in exactly one ".".
    let end = t.length;
    while (end > 0 && (TRAILING_PUNCT.has(t[end - 1]) || /\s/u.test(t[end - 1]))) end--;
    return end ? `${t.slice(0, end)}.` : '.';
  }
  return ',.!?'.includes(t.at(-1)!) ? t : `${t}.`;
}

const classifyGap = (chunk: string): Gap => (/[.!?]$/u.test(chunk.trimEnd()) ? 'sentence' : 'minor');

/** phonemize_text._merge_short_chunks: a chunk of a word or two on its own makes the model run on. */
function mergeShortChunks(chunks: string[], gaps: Gap[], minChars: number) {
  while (chunks.length > 1) {
    const short = chunks.map((c, i) => [c.trim().length, i] as const).filter(([n]) => n < minChars);
    if (!short.length) break;
    // The shortest; the first of equals, as Python's min does.
    const i = short.reduce((a, b) => (b[0] < a[0] ? b : a))[1];
    // (prefer, side) pairs; the larger wins and a tie goes to the right, as Python's max does over [R, L].
    const sides: Array<[[boolean, number], 'R' | 'L']> = [];
    if (i < chunks.length - 1) sides.push([[gaps[i] !== 'para', -chunks[i + 1].length], 'R']);
    if (i > 0) sides.push([[gaps[i - 1] !== 'para', -chunks[i - 1].length], 'L']);
    const better = (a: [boolean, number], b: [boolean, number]) => Number(a[0]) - Number(b[0]) || a[1] - b[1];
    const side = sides.reduce((a, b) => (better(b[0], a[0]) > 0 ? b : a))[1];
    if (side === 'R') {
      chunks[i] = `${chunks[i]} ${chunks.splice(i + 1, 1)[0]}`;
      gaps.splice(i, 1);
    } else {
      chunks[i - 1] = `${chunks[i - 1]} ${chunks.splice(i, 1)[0]}`;
      gaps.splice(i - 1, 1);
    }
  }
  return { chunks, gaps };
}

/** normalize_to_chunks_v3_with_gaps: normalised chunks and the kind of boundary between each pair. */
export function toChunks(text: string, g2p: SeaG2pStages, maxChars = MAX_CHUNK_CHARS): { chunks: string[]; gaps: Gap[] } {
  const chunks: string[] = [];
  const gaps: Gap[] = [];
  for (const para of text.normalize('NFC').split(/[\r\n]+/u).filter(p => p.trim())) {
    const sentences = splitIntoSentences(para).map(s => g2p.normalize(s, false));
    const packed = packSentencesIntoChunks(sentences, maxChars);
    if (!packed.length) continue;
    if (chunks.length) gaps.push('para');
    packed.forEach((c, j) => {
      if (j > 0) gaps.push('sentence');
      chunks.push(c);
    });
  }
  const normed = chunks.map(puncNorm);
  const classified = gaps.map((g, i) => (g === 'para' ? g : classifyGap(normed[i])));
  return mergeShortChunks(normed, classified, MIN_CHUNK_CHARS);
}

/** A chunk's phonemes: sea-g2p normalises and phonemises again, closing punctuation included. */
export const phonemizeChunk = (chunk: string, g2p: SeaG2pStages) => g2p.phonemize(chunk, true);

// ── Frame cap (core_utils.max_expected_frames): a short chunk often misses its stop token and runs on ──
const IPA_VOWELS = new Set('aeiouyæɐɑɒɔəɘɛɜɤɯɵøœʉʊʌɪɨɚɝᵻᵿ');
const MARKUP = /<\|emotion_\d+\|>|<\/?en>/gu;

export function syllableCount(phonemes: string): number {
  let total = 0;
  for (const tok of phonemes.replace(MARKUP, '').split(/\s+/u).filter(Boolean)) {
    let groups = 0;
    let inV = false;
    let consonantSeen = true;
    for (const ch of tok) {
      if (IPA_VOWELS.has(ch)) {
        if (!inV && consonantSeen) groups++;
        inV = true;
        consonantSeen = false;
      } else if ('ːˈˌ'.includes(ch) || /\p{Nd}/u.test(ch)) {
        // A stress mark after the token already has a vowel group starts a new syllable.
        if ('ˈˌ'.includes(ch) && groups > 0) {
          inV = false;
          consonantSeen = true;
        } else inV = false;
      } else {
        inV = false;
        consonantSeen = true;
      }
    }
    if (/\p{L}/u.test(tok)) total += Math.max(1, groups);
  }
  return total;
}

export function maxExpectedFrames(phonemes: string): number {
  const effLen = [...phonemes.replace(MARKUP, '')].length;
  let cap = 24 + Math.ceil(2 * effLen);
  const syl = Math.max(1, syllableCount(phonemes));
  if (syl <= 4 && effLen <= 24 * syl) cap = Math.min(cap, 13 + 5 * (syl - 1));
  return cap;
}
