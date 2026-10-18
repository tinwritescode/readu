// Messages between the content script and the page script (mainWorld.ts), which can read YouTube's player.
import type { Json3Event } from './captions';

export const TO_PAGE = 'readu-dub:to-page';
export const TO_CONTENT = 'readu-dub:to-content';

export type CaptionsResult =
  | { ok: true; videoId: string; events: Json3Event[]; language: string; auto: boolean }
  | { ok: false; videoId: string; reason: 'no-captions' | 'fetch-failed' | 'no-player' };

let nextId = 1;

/** Asks the page script for the current video's caption events. */
export function requestCaptions(): Promise<CaptionsResult> {
  const id = nextId++;
  return new Promise(resolve => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window || e.data?.channel !== TO_CONTENT || e.data.id !== id) return;
      window.removeEventListener('message', onMessage);
      resolve(e.data.result as CaptionsResult);
    };
    window.addEventListener('message', onMessage);
    window.postMessage({ channel: TO_PAGE, id, type: 'captions' }, '*');
  });
}
