// The service worker is the only part that talks to the Readu API. It holds the session token,
// and its host permission lets it call the API without CORS, which a content script on youtube.com could not.
import { ApiError } from './adapters/api/client';
import type { Reply, Request, Responses } from './adapters/chrome/messages';
import { handleRequest } from './app/handleRequest';
import type { InstallProgress } from './domain/types';

/** Sent by the offscreen document while it downloads the voice. */
type OffscreenNote = { type: 'localProgress'; progress: InstallProgress } | { target: string };

chrome.runtime.onMessage.addListener((req: Request | OffscreenNote, _sender, sendResponse: (r: Reply<Responses[keyof Responses]>) => void) => {
  // Requests for the offscreen document are answered there; its progress notes are kept for every tab to see.
  if ('target' in req) return false;
  if (req.type === 'localProgress') {
    void chrome.storage.local.set({ localInstall: req.progress });
    return false;
  }
  handleRequest(req).then(
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
