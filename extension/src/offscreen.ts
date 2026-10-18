// A hidden extension page that reads Vietnamese on this computer. It is the only place that may use threads
// and WebGPU for the models and keep them loaded between sentences. The service worker forwards requests here.
// Two models read here: Kokoro and VieNeu, each downloaded on its own.
import { encodeWav } from './adapters/audio/wav';
import { toBase64 } from './adapters/chrome/base64';
import { OFFSCREEN, type OffscreenRequest } from './adapters/chrome/offscreen';
import type { AssetSet } from './adapters/speech/assetCache';
import { DICT_URL, KOKORO } from './adapters/speech/kokoroAssets';
import { KokoroEngine } from './adapters/speech/kokoroEngine';
import { seaG2p, setUpOrt } from './adapters/speech/runtime';
import { readVieneuFiles, VIENEU, vieneuVoice } from './adapters/speech/vieneuAssets';
import { VIENEU_SAMPLE_RATE, VieneuEngine } from './adapters/speech/vieneuEngine';
import { SAMPLE_RATE } from './domain/kokoroText';
import type { InstallProgress, LocalEngine, LocalModel } from './domain/types';
import { modelOf, vieneuPreset } from './domain/voices';

/** What a model does here, whichever it is. */
interface Reader {
  backend: 'webgpu' | 'wasm';
  /** Text to WAV bytes. */
  speak(text: string, voice: string, speed: number): Promise<ArrayBuffer>;
  benchmark(voice: string): Promise<number>;
}

async function loadKokoro(): Promise<Reader> {
  const e = await KokoroEngine.load();
  return {
    backend: e.backend,
    speak: async (text, voice, speed) => encodeWav(await e.synthesize(text, voice, speed), SAMPLE_RATE),
    benchmark: voice => e.benchmark(voice),
  };
}

async function loadVieneu(): Promise<Reader> {
  setUpOrt();
  const [files, g2p] = await Promise.all([readVieneuFiles(), seaG2p(() => VIENEU.read(DICT_URL))]);
  const e = await VieneuEngine.load(files, g2p, ['wasm']);
  return {
    backend: e.backend,
    // VieNeu has no speed control; it already reads faster than Kokoro at 1.1.
    speak: async (text, voice) => encodeWav(await e.synthesize(text, vieneuVoice(vieneuPreset(voice))), VIENEU_SAMPLE_RATE),
    benchmark: voice => e.benchmark(vieneuVoice(vieneuPreset(voice))),
  };
}

const MODELS: Record<LocalModel, { assets: AssetSet; load: () => Promise<Reader> }> = {
  kokoro: { assets: KOKORO, load: loadKokoro },
  vieneu: { assets: VIENEU, load: loadVieneu },
};
const readers: Partial<Record<LocalModel, Promise<Reader>>> = {};
const realtime: Partial<Record<LocalModel, number>> = {};
// One sentence at a time: a model already uses the whole GPU or the cores it was given.
let queue: Promise<unknown> = Promise.resolve();

/** Runs work after everything queued before it, whether that worked or not. */
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => undefined).then(work);
  queue = next;
  return next;
}

function reader(model: LocalModel): Promise<Reader> {
  readers[model] ??= MODELS[model].load().catch(e => {
    delete readers[model];
    throw e;
  });
  return readers[model];
}

async function status(model: LocalModel): Promise<LocalEngine> {
  const downloadBytes = await MODELS[model].assets.missingBytes();
  const loaded = readers[model];
  const backend = downloadBytes === 0 && loaded ? (await loaded).backend : undefined;
  return { installed: downloadBytes === 0, downloadBytes, backend, realtime: realtime[model] };
}

function progress(p: InstallProgress) {
  void chrome.runtime.sendMessage({ type: 'localProgress', progress: p });
}

async function handle(req: OffscreenRequest): Promise<unknown> {
  switch (req.type) {
    case 'localEngine':
      return status(req.model);
    case 'localInstall':
      try {
        await MODELS[req.model].assets.install((done, total) => progress({ model: req.model, done, total }));
      } catch (e) {
        progress({ model: req.model, done: 0, total: 1, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
      return null;
    case 'localBenchmark': {
      const model = modelOf(req.voice);
      const r = await reader(model);
      realtime[model] = await inTurn(() => r.benchmark(req.voice));
      return status(model);
    }
    case 'localSpeak': {
      const r = await reader(modelOf(req.voice));
      return toBase64(await inTurn(() => r.speak(req.text, req.voice, req.speed)));
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
