// The data the extension works with, independent of Chrome, YouTube and the API.
/** One sentence of the video: when it is said (ms) and the English text. */
export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface Voice {
  code: string;
  name: string;
  gender: string;
  /** Which model reads it; Kokoro when absent (the server's list). */
  model?: LocalModel;
}

/** The speech models that can read on this computer. */
export type LocalModel = 'kokoro' | 'vieneu';

/** What the backend reports about a dub while it is being made. */
export interface DubStatus {
  id: number;
  voice: string;
  total: number;
  translated: number;
  ready: number[];
  failed: number[];
  stage: 'translating' | 'speaking' | 'done' | 'error';
  error?: string;
}

export interface Account {
  email: string;
  plan: string;
}

/** Minutes of dub listened to today. */
export interface Quota {
  plan: string;
  usedSeconds: number;
  /** -1 means unlimited. */
  limitSeconds: number;
}

export interface Settings {
  voice: string;
  /** Original audio level while dubbing, 0..1. */
  originalVolume: number;
  /** Dub level, 0..1. */
  dubVolume: number;
  autoDub: boolean;
  /** Where the Vietnamese is made: this computer, the Readu server, or whichever fits. */
  readOn: ReadOn;
}

export type ReadOn = 'auto' | 'device' | 'server';

export const DEFAULT_SETTINGS: Settings = {
  voice: 'mai_loan',
  originalVolume: 0.2,
  dubVolume: 1,
  autoDub: false,
  readOn: 'auto',
};

/** Reading on this computer: whether the voice is downloaded, and how fast this computer reads once measured. */
export interface LocalEngine {
  installed: boolean;
  /** Bytes to download before it can read. */
  downloadBytes: number;
  backend?: 'webgpu' | 'wasm';
  /** Seconds of speech made per second. */
  realtime?: number;
}

/** Progress of downloading the voice, kept in chrome.storage so every tab and the popup can show it. */
export interface InstallProgress {
  model: LocalModel;
  done: number;
  total: number;
  error?: string;
}
