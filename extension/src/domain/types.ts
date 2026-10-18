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
}

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
}

export const DEFAULT_SETTINGS: Settings = {
  voice: 'mai_loan',
  originalVolume: 0.2,
  dubVolume: 1,
  autoDub: false,
};
