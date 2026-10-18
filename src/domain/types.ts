export type DocumentFormat = 'txt' | 'epub' | 'pdf' | 'docx' | 'paste';

export interface ReaderDocument {
  id: string;
  title: string;
  format: DocumentFormat;
  text: string;
  /** File name of the cover image in the app's covers directory (EPUB cover or PDF first page). */
  cover?: string;
}

/** A document in the library plus where the reader left off. */
export interface LibraryEntry extends ReaderDocument {
  /** UTF-16 offset to resume from; equal to text.length once finished. */
  position: number;
  /** BCP-47 language detected from the text, e.g. "en" or "vi". */
  language: string | null;
  openedAt: number;
}

export interface ReaderSettings {
  /** Chosen voice id per base language ("en", "vi"), so each document reads in a voice that speaks it. */
  voiceByLanguage: Record<string, string>;
  speed: number;
  fontSize: number;
}

export type VoiceQuality = 'default' | 'enhanced' | 'premium';

export interface Voice {
  id: string;
  name: string;
  /** BCP-47 tag, e.g. "en-GB". */
  language: string;
  /** The language named in itself, e.g. "Tiếng Việt". */
  languageName: string;
  regionName: string;
  quality: VoiceQuality;
}

/** UTF-16 offsets into the text being spoken, same units as JS string indices. */
export interface TextRange {
  start: number;
  end: number;
}

export type AudioFormat = 'm4a' | 'mp3' | 'wav' | 'm4b';
