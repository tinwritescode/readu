import type { TextRange } from '../../domain/types';

const SENTENCE_END = /[.!?…。！？]["'”’)\]]*(?=\s|$)|\n/g;

function trim(text: string, range: TextRange): TextRange {
  let { start, end } = range;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { start, end };
}

/** Every sentence (or line) of `text`, in order, trimmed of surrounding whitespace. */
export function splitSentences(text: string): TextRange[] {
  const sentences: TextRange[] = [];
  let start = 0;
  SENTENCE_END.lastIndex = 0;
  for (let match = SENTENCE_END.exec(text); match; match = SENTENCE_END.exec(text)) {
    const end = match.index + match[0].length;
    pushTrimmed(text, sentences, { start, end });
    start = end;
  }
  pushTrimmed(text, sentences, { start, end: text.length });
  return sentences;
}

function pushTrimmed(text: string, out: TextRange[], range: TextRange) {
  const trimmed = trim(text, range);
  if (trimmed.end > trimmed.start) out.push(trimmed);
}

/** Index of the sentence containing `offset`, or the last one starting before it. */
export function sentenceIndexAt(sentences: TextRange[], offset: number): number {
  let lo = 0;
  let hi = sentences.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (sentences[mid].start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Groups sentences into render blocks: one per paragraph, with long
 * paragraphs cut at sentence boundaries so the reader can scroll to any block
 * and still see the sentence being spoken.
 */
export function textBlocks(text: string, sentences: TextRange[], maxLength = 600): TextRange[] {
  const blocks: TextRange[] = [];
  let block: TextRange | null = null;
  for (const sentence of sentences) {
    const newParagraph = block !== null && text.slice(block.end, sentence.start).includes('\n');
    if (block && !newParagraph && sentence.end - block.start <= maxLength) {
      block.end = sentence.end;
    } else {
      if (block) blocks.push(block);
      block = { ...sentence };
    }
  }
  if (block) blocks.push(block);
  return blocks;
}
