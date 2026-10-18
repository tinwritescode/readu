// Messages from the popup and content script to the service worker, which owns the API.
import type { Account, DubStatus, Quota, Segment, Voice } from '../../domain/types';

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
      rate: number;
      segments: Segment[];
    }
  | { type: 'dubStatus'; id: number; voice: string; position: number; rate: number }
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
