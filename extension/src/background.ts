// The service worker is the only part that talks to the Readu API. It holds the session token,
// and its host permission lets it call the API without CORS, which a content script on youtube.com could not.
import { ApiError } from './adapters/api/client';
import type { Reply, Request, Responses } from './adapters/chrome/messages';
import { handleRequest } from './app/handleRequest';

chrome.runtime.onMessage.addListener((req: Request, _sender, sendResponse: (r: Reply<Responses[keyof Responses]>) => void) => {
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
