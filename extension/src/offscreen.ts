// A hidden extension page that reads Vietnamese on this computer. It is the only place that may use threads
// and WebGPU for the model and keep it loaded between sentences. The service worker forwards requests here.
import { encodeWav } from './adapters/audio/wav';
import { toBase64 } from './adapters/chrome/base64';
import { CORE_BYTES, install, isInstalled } from './adapters/speech/kokoroAssets';
import { KokoroEngine } from './adapters/speech/kokoroEngine';
import { SAMPLE_RATE } from './domain/kokoroText';
import type { InstallProgress, LocalEngine } from './domain/types';
import { OFFSCREEN, type OffscreenRequest } from './adapters/chrome/offscreen';

let engine: Promise<KokoroEngine> | null = null;
let realtime: number | undefined;
// One sentence at a time: the model already uses the whole GPU or every core.
let queue: Promise<unknown> = Promise.resolve();

/** Runs work after everything queued before it, whether that worked or not. */
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => undefined).then(work);
  queue = next;
  return next;
}

function loadEngine(): Promise<KokoroEngine> {
  engine ??= KokoroEngine.load().catch(e => {
    engine = null;
    throw e;
  });
  return engine;
}

async function status(): Promise<LocalEngine> {
  const installed = await isInstalled();
  const backend = installed && engine ? (await engine).backend : undefined;
  return { installed, downloadBytes: CORE_BYTES, backend, realtime };
}

function progress(p: InstallProgress) {
  void chrome.runtime.sendMessage({ type: 'kokoroProgress', progress: p });
}

async function handle(req: OffscreenRequest): Promise<unknown> {
  switch (req.type) {
    case 'localEngine':
      return status();
    case 'localInstall':
      try {
        await install((done, total) => progress({ done, total }));
      } catch (e) {
        progress({ done: 0, total: CORE_BYTES, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
      return null;
    case 'localBenchmark': {
      const e = await loadEngine();
      realtime = await inTurn(() => e.benchmark(req.voice));
      return status();
    }
    case 'localSpeak': {
      const e = await loadEngine();
      const samples = await inTurn(() => e.synthesize(req.text, req.voice, req.speed));
      return toBase64(encodeWav(samples, SAMPLE_RATE));
    }
  }
}

chrome.runtime.onMessage.addListener((msg: { target?: string; req: OffscreenRequest }, _sender, sendResponse) => {
  if (msg.target !== OFFSCREEN) return false;
  handle(msg.req).then(
    data => sendResponse({ ok: true, data }),
    (e: unknown) => sendResponse({ ok: false, status: 0, error: e instanceof Error ? e.message : String(e) }),
  );
  return true;
});
