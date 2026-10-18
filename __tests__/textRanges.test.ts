import { sentenceIndexAt, splitSentences, textBlocks } from '../src/features/reader/textRanges';
import { speedToNativeRate } from '../src/adapters/speech/SystemSpeechEngine';

const sentencesOf = (t: string) => splitSentences(t).map(r => t.slice(r.start, r.end));

test('splits text into trimmed sentences and lines', () => {
  expect(sentencesOf('First one. Second "quoted" here? Third\nNew line')).toEqual([
    'First one.',
    'Second "quoted" here?',
    'Third',
    'New line',
  ]);
});

test('keeps closing quotes with the sentence they end', () => {
  expect(sentencesOf('He said "go!" Then left.')).toEqual(['He said "go!"', 'Then left.']);
});

test('does not split on decimals', () => {
  expect(sentencesOf('Pi is 3.14 roughly. Next.')).toEqual(['Pi is 3.14 roughly.', 'Next.']);
});

test('skips blank lines', () => {
  expect(sentencesOf('One.\n\n\nTwo.')).toEqual(['One.', 'Two.']);
});

test('finds the sentence an offset falls in, including the gap after it', () => {
  const t = 'Hello there. General Kenobi.';
  const s = splitSentences(t);
  expect(sentenceIndexAt(s, 0)).toBe(0);
  expect(sentenceIndexAt(s, t.indexOf(' General'))).toBe(0);
  expect(sentenceIndexAt(s, t.indexOf('Kenobi'))).toBe(1);
  expect(sentenceIndexAt(s, t.length)).toBe(1);
});

test('groups sentences into one block per paragraph, cutting long ones', () => {
  const t = 'A one. A two.\nB one.\n\n' + 'Long sentence here. '.repeat(10).trim();
  const blocks = textBlocks(t, splitSentences(t), 60).map(r => t.slice(r.start, r.end));
  expect(blocks[0]).toBe('A one. A two.');
  expect(blocks[1]).toBe('B one.');
  expect(blocks.length).toBeGreaterThan(3);
  expect(blocks.slice(2).every(b => b.length <= 60)).toBe(true);
  expect(blocks.slice(2).join(' ')).toBe('Long sentence here. '.repeat(10).trim());
});

test('maps speed multipliers onto AVSpeechUtterance rates', () => {
  expect(speedToNativeRate(1)).toBe(0.5);
  expect(speedToNativeRate(0.5)).toBe(0.25);
  expect(speedToNativeRate(2)).toBe(0.75);
  expect(speedToNativeRate(10)).toBe(1);
});
