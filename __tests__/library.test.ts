import type { LibraryEntry } from '../src/domain/types';
import {
  DEFAULT_SETTINGS,
  DEFAULT_VOICE_ID,
  libraryReducer,
  recentEntries,
} from '../src/features/library/library';
import { formatClock, formatMinutesLeft } from '../src/features/reader/estimate';

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

test('new installs read in the default Vbee voice', () => {
  expect(DEFAULT_SETTINGS.voiceId).toBe(DEFAULT_VOICE_ID);
  expect(DEFAULT_VOICE_ID).toBe('s_hochiminh_female_hanhanvani_children_vc');
});

test('formats time estimates', () => {
  expect(formatClock(1.5)).toBe('1:30');
  expect(formatClock(75)).toBe('1:15:00');
  expect(formatMinutesLeft(0.4)).toBe('under a minute left');
  expect(formatMinutesLeft(24.2)).toBe('24 min left');
});
