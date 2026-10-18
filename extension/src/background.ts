// The service worker is the only part that talks to the Readu API. It holds the session token,
// and its host permission lets it call the API without CORS, which a content script on youtube.com could not.
import { loginErrorText, type PendingLogin } from './login';
import type { Account, Reply, Request, Responses } from './types';

const API_BASE = 'https://api.readu.tyvn.online';

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function token(): Promise<string | undefined> {
  const { token } = await chrome.storage.local.get('token');
  return token as string | undefined;
}

async function api(path: string, init: { method?: string; json?: unknown; auth?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.json !== undefined) headers['Content-Type'] = 'application/json';
  if (init.auth !== false) {
    const t = await token();
    if (!t) throw new ApiError(401, 'not signed in');
    headers.Authorization = `Bearer ${t}`;
  }
  const res = await fetch(API_BASE + path, {
    method: init.method ?? 'GET',
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (res.status === 401 && init.auth !== false) await chrome.storage.local.remove(['token', 'account']);
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  }
  return res;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function handle(req: Request): Promise<unknown> {
  switch (req.type) {
    case 'requestCode': {
      // The login step is remembered here, not in the popup: Chrome closes the popup as soon as the viewer
      // clicks elsewhere, e.g. to open their mail, and the next popup picks up at the code step.
      const pendingLogin: PendingLogin = { email: req.email, sentAt: Date.now() };
      await chrome.storage.local.set({ pendingLogin, lastEmail: req.email });
      await chrome.storage.local.remove('loginError');
      try {
        await api('/v1/auth/code', { method: 'POST', json: { email: req.email }, auth: false });
      } catch (e) {
        const message = e instanceof ApiError ? loginErrorText(e.status, e.message) : loginErrorText(0, String(e));
        await chrome.storage.local.remove('pendingLogin');
        await chrome.storage.local.set({ loginError: { email: req.email, message, at: Date.now() } });
        throw e;
      }
      return null;
    }
    case 'verifyCode': {
      const res = await api('/v1/auth/session', { method: 'POST', json: { email: req.email, code: req.code }, auth: false });
      const { token } = (await res.json()) as { token: string };
      await chrome.storage.local.set({ token });
      const account = (await (await api('/v1/me')).json()) as Account;
      await chrome.storage.local.set({ account });
      await chrome.storage.local.remove(['pendingLogin', 'loginError']);
      return account;
    }
    case 'logout':
      await api('/v1/auth/session', { method: 'DELETE' }).catch(() => undefined);
      await chrome.storage.local.remove(['token', 'account']);
      return null;
    case 'me':
      if (!(await token())) return null;
      return (await api('/v1/me')).json();
    case 'quota':
      return (await api('/v1/dubs/quota')).json();
    case 'voices':
      return ((await (await api('/v1/voices')).json()) as { voices: unknown }).voices;
    case 'createDub':
      return (
        await api('/v1/dubs', {
          method: 'POST',
          json: {
            videoId: req.videoId,
            title: req.title,
            description: req.description,
            voice: req.voice,
            position: Math.round(req.position),
            segments: req.segments,
          },
        })
      ).json();
    case 'dubStatus':
      return (
        await api(`/v1/dubs/${req.id}?voice=${encodeURIComponent(req.voice)}&position=${Math.round(req.position)}`)
      ).json();
    case 'dubAudio':
      return toBase64(
        await (await api(`/v1/dubs/${req.id}/audio/${req.idx}?voice=${encodeURIComponent(req.voice)}`)).arrayBuffer(),
      );
  }
}

chrome.runtime.onMessage.addListener((req: Request, _sender, sendResponse: (r: Reply<Responses[keyof Responses]>) => void) => {
  handle(req).then(
    data => sendResponse({ ok: true, data: data as never }),
    (e: unknown) =>
      sendResponse({
        ok: false,
        status: e instanceof ApiError ? e.status : 0,
        error: e instanceof Error ? e.message : String(e),
      }),
  );
  return true; // the reply is sent asynchronously
});
