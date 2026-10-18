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

export interface Quota {
  plan: string;
  used: number;
  /** -1 means unlimited. */
  limit: number;
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

/** Requests the popup and the content script send to the service worker. */
export type Request =
  | { type: 'requestCode'; email: string }
  | { type: 'verifyCode'; email: string; code: string }
  | { type: 'logout' }
  | { type: 'me' }
  | { type: 'quota' }
  | { type: 'voices' }
  | {
      type: 'createDub';
      videoId: string;
      title: string;
      description: string;
      voice: string;
      position: number;
      segments: Segment[];
    }
  | { type: 'dubStatus'; id: number; voice: string; position: number }
  | { type: 'dubAudio'; id: number; idx: number; voice: string };

/** Every reply carries either data or an error with the HTTP status (0 for network errors). */
export type Reply<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export interface Responses {
  requestCode: null;
  verifyCode: Account;
  logout: null;
  me: Account | null;
  quota: Quota;
  voices: Voice[];
  createDub: DubStatus;
  dubStatus: DubStatus;
  /** MP3 bytes, base64 encoded: extension messages carry JSON only. */
  dubAudio: string;
}

export async function send<K extends Request['type']>(
  req: Extract<Request, { type: K }>,
): Promise<Reply<Responses[K]>> {
  try {
    return await chrome.runtime.sendMessage(req);
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
}

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...((settings as Partial<Settings>) ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
