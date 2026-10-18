// Vietnamese text to Kokoro-Vietnamese model input, the same steps the speech worker takes
// (backend/kokoro-worker/app.py): sea-g2p normalises, the text is cut into sentences, each sentence's words
// are phonemised together so context picks their reading, and vig2p's fix-ups map sea-g2p's symbols onto
// the model's.

/** The two sea-g2p stages; both take the text and the trailing-punctuation flag. */
export interface SeaG2pStages {
  normalize(text: string, puncNorm: boolean): string;
  phonemize(text: string, puncNorm: boolean): string;
}

/** One model run: token ids with the boundary zeros, and the voicepack row that styles them. */
export interface ModelInput {
  ids: number[];
  styleIndex: number;
}

/** Kokoro's context window: 512 ids, two of them the boundary zeros. */
export const CONTEXT_LENGTH = 512;
/** Rows in a voicepack; longer sentences use the last one. */
export const VOICEPACK_ROWS = 510;
export const SAMPLE_RATE = 24000;
const CROSSFADE_MS = 50;

/** vig2p's symbol fix-ups, in order: a later pair can rewrite an earlier pair's output. U+E100 holds a dental
 *  t aside so the next pair can give it back as a plain t. */
const VI_FIXUPS: Array<[string, string]> = [
  ['tʃ', 'ʧ'],
  ['t̪', ''],
  ['', 't'],
  ['e-', 'æ'],
  ['1', '→'],
  ['7', '→'],
  ['2', '↘'],
  ['ɜ', '↗'],
  ['3', '↗'],
  ['4', '↓'],
  ['5', 'ʔ↗'],
  ['6', 'ʔ↓'],
  ['ɗ', 'd'],
  ['ʐ', 'ʒ'],
  ['̪', ''],
  ['-', ''],
  ['–', '—'],
  ['*', ''],
  ['/', ' '],
  ['&', ' '],
  ["'", ''],
  ['’', ''],
  ['‘', ''],
  ['đ', 'd'],
  ['̩', ''],
];

const WORD = "[A-Za-zÀ-ỹĐđ]+(?:[-'][A-Za-zÀ-ỹĐđ]+)*";
const TOKEN_RE = new RegExp(`${WORD}|\\s+|.`, 'gu');
const WORD_RE = new RegExp(`^${WORD}$`, 'u');
const NON_VI_S_CLUSTERS = ['sc', 'sh', 'sk', 'sl', 'sm', 'sn', 'sp', 'st', 'sw'];

function tokenize(text: string): string[] {
  return text.replace(/[’‘]/g, "'").match(TOKEN_RE) ?? [];
}

/** vig2p's fix_phonemes, keeping Vietnamese onsets on unmarked words too (its default). */
export function fixPhonemes(phonemes: string, source?: string): string {
  let out = phonemes;
  for (const [from, to] of VI_FIXUPS) out = out.split(from).join(to);
  if (!source) return out;
  const s = source.toLowerCase();
  if (s.startsWith('th')) return out.replace('t', 'θ');
  if (s.startsWith('tr')) return out.replace('ʧ', 'ʈʂ');
  if (s.startsWith('s') && !NON_VI_S_CLUSTERS.some(c => s.startsWith(c))) return out.replace('s', 'ʂ');
  if (/^g[iìíỉĩị]/u.test(s)) return out.replace('z', 'ʝ');
  return out;
}

/** kokoro_vietnamese.split_text: sentences end at . ! ? … followed by a space or the end. */
export function splitSentences(text: string): string[] {
  const t = text.trim().replace(/\s+/gu, ' ');
  if (!t) return [];
  const out: string[] = [];
  let start = 0;
  for (const m of t.matchAll(/[.!?…]+(?:["”’)]*)/gu)) {
    const end = m.index! + m[0].length;
    if (end < t.length && !/\s/u.test(t[end])) continue;
    const chunk = t.slice(start, end).trim();
    if (chunk) out.push(chunk);
    start = end;
  }
  const rest = t.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/** The worker's phonemize: the words go through sea-g2p together, and each result is fixed up against its word.
 *  If the word counts do not line up, each word goes through on its own. */
export function phonemizeSentence(text: string, g2p: SeaG2pStages): string {
  const tokens = tokenize(text);
  const words = tokens.filter(t => WORD_RE.test(t));
  const raw = words.length ? g2p.phonemize(words.join(' '), false).split(/\s+/u).filter(Boolean) : [];
  const together = raw.length === words.length;
  let w = 0;
  return tokens
    .map(t => {
      if (/^\s+$/u.test(t)) return ' ';
      if (WORD_RE.test(t)) return fixPhonemes(together ? raw[w++] : g2p.phonemize(t, false), t);
      return fixPhonemes(t);
    })
    .join('')
    .trim();
}

/** Text to one model input per sentence. sea-g2p's <en> marks around English words are dropped. */
export function toModelInputs(text: string, g2p: SeaG2pStages, vocab: Record<string, number>): ModelInput[] {
  const normalized = g2p.normalize(text, false).replace(/<\/?en>/g, '');
  const out: ModelInput[] = [];
  for (const sentence of splitSentences(normalized)) {
    const phonemes = phonemizeSentence(sentence, g2p);
    if (!phonemes) continue;
    const ids: number[] = [];
    for (const c of phonemes) if (vocab[c] !== undefined) ids.push(vocab[c]);
    // The worker refuses these too; a caption sentence never gets this long.
    if (ids.length + 2 > CONTEXT_LENGTH) throw new Error(`sentence too long for the model: ${ids.length + 2} ids`);
    out.push({ ids: [0, ...ids, 0], styleIndex: Math.min([...phonemes].length, VOICEPACK_ROWS) - 1 });
  }
  return out;
}

/** Joins sentence audio with a short crossfade, as kokoro_vietnamese.merge_audio_chunks does. */
export function mergeAudio(chunks: Float32Array[]): Float32Array {
  const valid = chunks.filter(c => c.length > 0);
  if (!valid.length) return new Float32Array();
  const fade = Math.round((SAMPLE_RATE * CROSSFADE_MS) / 1000);
  let merged = valid[0];
  for (const chunk of valid.slice(1)) {
    const overlap = Math.min(fade, merged.length, chunk.length);
    const out = new Float32Array(merged.length + chunk.length - overlap);
    out.set(merged.subarray(0, merged.length - overlap));
    for (let i = 0; i < overlap; i++) {
      // np.linspace(1, 0, overlap + 2)[1:-1]
      const fadeOut = 1 - (i + 1) / (overlap + 1);
      out[merged.length - overlap + i] = merged[merged.length - overlap + i] * fadeOut + chunk[i] * (1 - fadeOut);
    }
    out.set(chunk.subarray(overlap), merged.length);
    merged = out;
  }
  return merged;
}
