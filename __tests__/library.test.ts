import type { LibraryEntry, Voice } from '../src/domain/types';
import { DEFAULT_SETTINGS, libraryReducer, recentEntries } from '../src/features/library/library';
import { formatClock, formatMinutesLeft } from '../src/features/reader/estimate';
import { groupByLanguage, resolveVoice } from '../src/features/voices/voices';

const entry = (id: string, openedAt: number): LibraryEntry => ({
  id,
  title: id,
  format: 'paste',
  text: 'Some text.',
  position: 0,
  language: 'en',
  openedAt,
});

test('library keeps positions per document and lists the latest opened first', () => {
  let state = { entries: [entry('a', 1), entry('b', 2)], settings: DEFAULT_SETTINGS };
  state = libraryReducer(state, { type: 'position', id: 'a', position: 5 });
  state = libraryReducer(state, { type: 'open', id: 'a', at: 3 });
  expect(recentEntries(state.entries).map(e => [e.id, e.position])).toEqual([
    ['a', 5],
    ['b', 0],
  ]);
  state = libraryReducer(state, { type: 'remove', id: 'a' });
  expect(state.entries.map(e => e.id)).toEqual(['b']);
});

const voice = (id: string, language: string, quality: Voice['quality'], languageName = language): Voice => ({
  id,
  name: id,
  language,
  languageName,
  regionName: language,
  quality,
});

const voices = [
  voice('Samantha', 'en-US', 'default', 'English'),
  voice('Ava', 'en-US', 'premium', 'English'),
  voice('Linh', 'vi-VN', 'default', 'Tiếng Việt'),
  voice('Amélie', 'fr-CA', 'enhanced', 'Français'),
];

test('picks the saved voice for the language, else its best one', () => {
  expect(resolveVoice(voices, 'en', {})?.id).toBe('Ava');
  expect(resolveVoice(voices, 'en', { en: 'Samantha' })?.id).toBe('Samantha');
  expect(resolveVoice(voices, 'vi', { en: 'Samantha' })?.id).toBe('Linh');
  expect(resolveVoice(voices, 'de', {})?.id).toBe('Ava');
  expect(resolveVoice(voices, 'en', { en: 'uninstalled' })?.id).toBe('Ava');
});

test('groups voices by language, best quality first', () => {
  expect(groupByLanguage(voices).map(g => [g.label, g.voices.map(v => v.id)])).toEqual([
    ['English', ['Ava', 'Samantha']],
    ['Français', ['Amélie']],
    ['Tiếng Việt', ['Linh']],
  ]);
});

test('formats time estimates', () => {
  expect(formatClock(1.5)).toBe('1:30');
  expect(formatClock(75)).toBe('1:15:00');
  expect(formatMinutesLeft(0.4)).toBe('under a minute left');
  expect(formatMinutesLeft(24.2)).toBe('24 min left');
});
