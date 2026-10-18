// What the service worker does for each request from the popup and the content script.
import { ApiError, api, token } from '../adapters/api/client';
import { toBase64 } from '../adapters/chrome/base64';
import type { Request } from '../adapters/chrome/messages';
import { toOffscreen } from '../adapters/chrome/offscreen';
import { loginErrorText, type PendingLogin } from '../domain/login';
import type { Account, LocalEngine } from '../domain/types';
import { modelOf } from '../domain/voices';

export async function handleRequest(req: Request): Promise<unknown> {
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
            rate: req.rate,
            segments: req.segments,
          },
        })
      ).json();
    case 'dubStatus':
      return (
        await api(
          `/v1/dubs/${req.id}?voice=${encodeURIComponent(req.voice)}&position=${Math.round(req.position)}&rate=${req.rate}`,
        )
      ).json();
    case 'localEngine': {
      // The offscreen document forgets the speed it measured when it closes; the last measurement is kept here.
      const engine = (await toOffscreen(req)) as LocalEngine;
      const key = `${req.model}Bench`;
      const bench = ((await chrome.storage.local.get(key)) as Record<string, LocalEngine | undefined>)[key];
      return { ...engine, backend: engine.backend ?? bench?.backend, realtime: engine.realtime ?? bench?.realtime };
    }
    case 'localBenchmark': {
      const engine = (await toOffscreen(req)) as LocalEngine;
      await chrome.storage.local.set({ [`${modelOf(req.voice)}Bench`]: engine });
      return engine;
    }
    case 'localInstall':
    case 'localSpeak':
      return toOffscreen(req);
    case 'dubAudio':
      return toBase64(
        await (await api(`/v1/dubs/${req.id}/audio/${req.idx}?voice=${encodeURIComponent(req.voice)}`)).arrayBuffer(),
      );
  }
}
