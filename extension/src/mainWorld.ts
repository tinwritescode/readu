// Runs in the page's own JavaScript world so it can read YouTube's player and its caption requests.
// It only answers the content script; it never talks to the network except to fetch captions from youtube.com.
import { pickTrack, type CaptionTrack } from './captions';
import { TO_CONTENT, TO_PAGE, type CaptionsResult } from './bridge';

interface Player extends HTMLElement {
  getPlayerResponse?: () => PlayerResponse | undefined;
  loadModule?: (module: string) => void;
}

interface PlayerResponse {
  videoDetails?: { videoId?: string; title?: string; shortDescription?: string; lengthSeconds?: string };
  microformat?: { playerMicroformatRenderer?: { category?: string } };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
}

// YouTube now signs caption requests with a "pot" token only its player can make. Watching the player's own
// timedtext requests gives a URL that works; it is reused with fmt=json3 for the track we want.
const seenTimedtext: string[] = [];
function noteUrl(url: string) {
  if (url.includes('/api/timedtext') && url.includes('pot=')) seenTimedtext.push(new URL(url, location.href).href);
}
const origOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  noteUrl(String(url));
  return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
} as typeof XMLHttpRequest.prototype.open;
const origFetch = window.fetch;
window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
  noteUrl(input instanceof Request ? input.url : String(input));
  return origFetch.call(this, input, init);
};

function player(): Player | null {
  return document.getElementById('movie_player') as Player | null;
}

function withJson3(url: string, track: CaptionTrack, translate: boolean): string {
  const u = new URL(url, location.href);
  u.searchParams.set('fmt', 'json3');
  u.searchParams.set('lang', track.languageCode);
  if (track.kind) u.searchParams.set('kind', track.kind);
  else u.searchParams.delete('kind');
  if (translate) u.searchParams.set('tlang', 'en');
  else u.searchParams.delete('tlang');
  return u.href;
}

async function fetchEvents(url: string) {
  const res = await origFetch(url, { credentials: 'include' });
  const text = res.ok ? await res.text() : '';
  if (!text) return null;
  return (JSON.parse(text) as { events?: unknown[] }).events ?? null;
}

/** Turns captions on for a moment so the player makes a signed request, then restores the user's setting. */
async function signedUrl(videoId: string): Promise<string | undefined> {
  const find = () => seenTimedtext.findLast(u => new URL(u).searchParams.get('v') === videoId);
  if (find()) return find();
  const button = document.querySelector<HTMLButtonElement>('.ytp-subtitles-button');
  const pressed = button?.getAttribute('aria-pressed') === 'true';
  if (button && !pressed) button.click();
  else if (!button) player()?.loadModule?.('captions');
  for (let i = 0; i < 40 && !find(); i++) await new Promise(r => setTimeout(r, 150));
  if (button && !pressed) button.click();
  return find();
}

async function captions(): Promise<CaptionsResult> {
  const p = player();
  const pr = p?.getPlayerResponse?.() ?? (window as unknown as { ytInitialPlayerResponse?: PlayerResponse }).ytInitialPlayerResponse;
  const videoId = pr?.videoDetails?.videoId ?? new URLSearchParams(location.search).get('v') ?? '';
  if (!pr) return { ok: false, videoId, reason: 'no-player' };
  const picked = pickTrack(pr.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []);
  if (!picked) return { ok: false, videoId, reason: 'no-captions' };
  const { track, translate } = picked;
  const auto = track.kind === 'asr';
  try {
    let events = await fetchEvents(withJson3(track.baseUrl, track, translate));
    if (!events) {
      const signed = await signedUrl(videoId);
      if (signed) events = await fetchEvents(withJson3(signed, track, translate));
    }
    if (!events) return { ok: false, videoId, reason: 'fetch-failed' };
    const title = pr.videoDetails?.title ?? '';
    const description = (pr.videoDetails?.shortDescription ?? '').slice(0, 1000);
    const category = pr.microformat?.playerMicroformatRenderer?.category ?? '';
    const durationSec = Number(pr.videoDetails?.lengthSeconds ?? 0);
    return { ok: true, videoId, title, description, category, durationSec, events: events as never, language: track.languageCode, auto };
  } catch {
    return { ok: false, videoId, reason: 'fetch-failed' };
  }
}

window.addEventListener('message', async e => {
  if (e.source !== window || e.data?.channel !== TO_PAGE || e.data.type !== 'captions') return;
  const result = await captions();
  window.postMessage({ channel: TO_CONTENT, id: e.data.id, result }, '*');
});
