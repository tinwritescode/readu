import { NativeModules } from 'react-native';
import type { LibraryEntry, ReaderDocument, ReaderSettings } from '../../domain/types';

export interface LibraryState {
  entries: LibraryEntry[];
  settings: ReaderSettings;
}

export type LibraryAction =
  | { type: 'add'; entry: LibraryEntry }
  | { type: 'remove'; id: string }
  | { type: 'open'; id: string; at: number }
  | { type: 'position'; id: string; position: number }
  | { type: 'settings'; patch: Partial<ReaderSettings> };

export const DEFAULT_SETTINGS: ReaderSettings = { voiceByLanguage: {}, speed: 1, fontSize: 19 };

export function libraryReducer(state: LibraryState, action: LibraryAction): LibraryState {
  const update = (id: string, patch: Partial<LibraryEntry>) => ({
    ...state,
    entries: state.entries.map(e => (e.id === id ? { ...e, ...patch } : e)),
  });
  switch (action.type) {
    case 'add':
      return { ...state, entries: [action.entry, ...state.entries] };
    case 'remove':
      return { ...state, entries: state.entries.filter(e => e.id !== action.id) };
    case 'open':
      return update(action.id, { openedAt: action.at });
    case 'position':
      return update(action.id, { position: action.position });
    case 'settings':
      return { ...state, settings: { ...state.settings, ...action.patch } };
  }
}

/** Most recently opened first. */
export function recentEntries(entries: LibraryEntry[]): LibraryEntry[] {
  return [...entries].sort((a, b) => b.openedAt - a.openedAt);
}

export function isFinished(entry: LibraryEntry): boolean {
  return entry.position >= entry.text.length;
}

interface NativeLibraryFile {
  loadLibrary(): Promise<string | null>;
  saveLibrary(json: string): Promise<void>;
}

interface NativeLanguage {
  detectLanguage(text: string): Promise<string | null>;
}

const file = NativeModules.VttsDocuments as NativeLibraryFile | undefined;
const speech = NativeModules.VttsSpeech as NativeLanguage | undefined;

export async function loadLibrary(seed: ReaderDocument): Promise<LibraryState> {
  const json = await file?.loadLibrary();
  if (json) {
    try {
      const saved = JSON.parse(json) as LibraryState;
      return { entries: saved.entries, settings: { ...DEFAULT_SETTINGS, ...saved.settings } };
    } catch {
      // A corrupt file starts a fresh library rather than blocking the app.
    }
  }
  return { entries: [await toEntry(seed)], settings: DEFAULT_SETTINGS };
}

export function saveLibrary(state: LibraryState): Promise<void> {
  return file?.saveLibrary(JSON.stringify(state)) ?? Promise.resolve();
}

export async function toEntry(doc: ReaderDocument): Promise<LibraryEntry> {
  const language = (await speech?.detectLanguage(doc.text.slice(0, 2000))) ?? null;
  return { ...doc, position: 0, language, openedAt: Date.now() };
}
