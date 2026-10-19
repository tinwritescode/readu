// A byte-level BPE tokenizer for the tokenizer.json VieNeu ships (Hugging Face `tokenizers`, GPT-2 style):
// NFC, split with the GPT-2 pattern, bytes mapped to printable characters, then merges by rank.
// Only what that file uses is supported: no added-token matching in the input, no dropout.

export interface TokenizerJson {
  normalizer?: { type: string } | null;
  model: { type: string; vocab: Record<string, number>; merges: Array<[string, string] | string>; unk_token?: string | null };
}

// GPT-2's split pattern. JavaScript has no inline (?i:...), so the contractions spell out both cases.
const SPLIT =
  /'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD]|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

/** GPT-2's byte to character table: printable bytes stand for themselves, the rest move to U+0100 onwards. */
function byteToChar(): string[] {
  const keep: number[] = [];
  for (let b = 0x21; b <= 0x7e; b++) keep.push(b);
  for (let b = 0xa1; b <= 0xac; b++) keep.push(b);
  for (let b = 0xae; b <= 0xff; b++) keep.push(b);
  const table: string[] = new Array(256);
  let extra = 0;
  for (let b = 0; b < 256; b++) table[b] = String.fromCodePoint(keep.includes(b) ? b : 256 + extra++);
  return table;
}

export class ByteLevelBpe {
  private vocab: Map<string, number>;
  private ranks = new Map<string, number>();
  private bytes = byteToChar();
  private encoder = new TextEncoder();
  private cache = new Map<string, number[]>();
  private unk: number | undefined;

  constructor(json: TokenizerJson) {
    if (json.model.type !== 'BPE') throw new Error(`tokenizer model ${json.model.type} is not BPE`);
    this.vocab = new Map(Object.entries(json.model.vocab));
    json.model.merges.forEach((m, rank) => {
      const [a, b] = typeof m === 'string' ? m.split(' ') : m;
      this.ranks.set(`${a} ${b}`, rank);
    });
    this.unk = json.model.unk_token ? this.vocab.get(json.model.unk_token) : undefined;
  }

  encode(text: string): number[] {
    const ids: number[] = [];
    for (const piece of text.normalize('NFC').match(SPLIT) ?? []) {
      let cached = this.cache.get(piece);
      if (!cached) {
        cached = this.bpe([...this.encoder.encode(piece)].map(b => this.bytes[b]));
        this.cache.set(piece, cached);
      }
      ids.push(...cached);
    }
    return ids;
  }

  private bpe(symbols: string[]): number[] {
    while (symbols.length > 1) {
      let best = -1;
      let bestRank = Infinity;
      for (let i = 0; i < symbols.length - 1; i++) {
        const r = this.ranks.get(`${symbols[i]} ${symbols[i + 1]}`);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          best = i;
        }
      }
      if (best < 0) break;
      // Merge every occurrence of the best pair, left to right, as tokenizers does.
      const [a, b] = [symbols[best], symbols[best + 1]];
      const next: string[] = [];
      for (let i = 0; i < symbols.length; i++) {
        if (i < symbols.length - 1 && symbols[i] === a && symbols[i + 1] === b) {
          next.push(a + b);
          i++;
        } else next.push(symbols[i]);
      }
      symbols = next;
    }
    const ids: number[] = [];
    for (const s of symbols) {
      const id = this.vocab.get(s) ?? this.unk;
      if (id !== undefined) ids.push(id);
    }
    return ids;
  }
}
