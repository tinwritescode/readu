import { del, get, set } from 'idb-keyval';
import { DEFAULT_SETTINGS, loadLibrary, type LibraryState } from '@shared/features/library/library';
import type { ReaderDocument } from '@shared/domain/types';

/**
 * The browser's stand-ins for what VttsDocuments.m and VttsSpeech.m keep on
 * iOS: the library in IndexedDB (books outgrow localStorage), covers there as
 * blobs, and the session token in localStorage.
 */

const LIBRARY_KEY = 'library';
const TOKEN_KEY = 'readu.token';
const coverKey = (name: string) => `cover:${name}`;

/** The saved library, or the shared seed library when there is none yet. */
export async function loadWebLibrary(seed: ReaderDocument): Promise<LibraryState> {
  const saved = await get<LibraryState>(LIBRARY_KEY).catch(() => undefined);
  if (saved?.entries) return { entries: saved.entries, settings: { ...DEFAULT_SETTINGS, ...saved.settings } };
  return loadLibrary(seed);
}

export function saveWebLibrary(state: LibraryState): Promise<void> {
  return set(LIBRARY_KEY, state).catch(() => undefined);
}

export function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function saveCover(name: string, blob: Blob): Promise<void> {
  return set(coverKey(name), blob);
}

export function loadCover(name: string): Promise<Blob | undefined> {
  return get<Blob>(coverKey(name));
}

export function deleteCover(doc: ReaderDocument): void {
  if (doc.cover) del(coverKey(doc.cover)).catch(() => undefined);
}
