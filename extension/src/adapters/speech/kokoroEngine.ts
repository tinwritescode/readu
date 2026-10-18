// Kokoro-Vietnamese running in this browser: sea-g2p as WebAssembly turns text into model input, and
// onnxruntime-web runs the model on the GPU through WebGPU, or on every CPU core through WebAssembly.
// Runs in the offscreen document, which may use threads and WebGPU and lives as long as the extension needs it.
import * as ort from 'onnxruntime-web/webgpu';
import initSeaG2p, { SeaG2p } from '../../../vendor/sea-g2p/sea_g2p_rs.js';
import { mergeAudio, SAMPLE_RATE, toModelInputs } from '../../domain/kokoroText';
import { CONFIG_URL, DICT_URL, MODEL_URL, read, voicepackFloats, voicepackUrl } from './kokoroAssets';

export type Backend = 'webgpu' | 'wasm';

export class KokoroEngine {
  private voicepacks = new Map<string, Float32Array>();

  private constructor(
    private session: ort.InferenceSession,
    private g2p: SeaG2p,
    private vocab: Record<string, number>,
    readonly backend: Backend,
  ) {}

  /** Loads the model from Cache Storage; it must be installed. WebGPU is tried first. */
  static async load(): Promise<KokoroEngine> {
    ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
    ort.env.wasm.numThreads = self.crossOriginIsolated ? navigator.hardwareConcurrency : 1;
    const [model, config, dict] = await Promise.all([read(MODEL_URL), read(CONFIG_URL), read(DICT_URL), initSeaG2p({ module_or_path: chrome.runtime.getURL('sea_g2p_rs_bg.wasm') })]);
    const g2p = new SeaG2p(new Uint8Array(dict));
    const vocab = (JSON.parse(new TextDecoder().decode(config)) as { vocab: Record<string, number> }).vocab;
    const bytes = new Uint8Array(model);
    const failures: string[] = [];
    for (const backend of ['webgpu', 'wasm'] as const) {
      if (backend === 'webgpu' && !('gpu' in navigator)) continue;
      try {
        const session = await ort.InferenceSession.create(bytes, { executionProviders: [backend] });
        return new KokoroEngine(session, g2p, vocab, backend);
      } catch (e) {
        failures.push(`${backend}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw new Error(`the model would not load (${failures.join('; ')})`);
  }

  private async voicepack(voice: string): Promise<Float32Array> {
    let pack = this.voicepacks.get(voice);
    if (!pack) {
      pack = voicepackFloats(await read(voicepackUrl(voice)));
      this.voicepacks.set(voice, pack);
    }
    return pack;
  }

  /** Vietnamese text to 24 kHz mono samples. */
  async synthesize(text: string, voice: string, speed: number): Promise<Float32Array> {
    const pack = await this.voicepack(voice);
    const chunks: Float32Array[] = [];
    for (const input of toModelInputs(text, this.g2p, this.vocab)) {
      const out = await this.session.run({
        input_ids: new ort.Tensor('int64', BigInt64Array.from(input.ids, BigInt), [1, input.ids.length]),
        ref_s: new ort.Tensor('float32', pack.slice(input.styleIndex * 256, input.styleIndex * 256 + 256), [1, 256]),
        speed: new ort.Tensor('float32', new Float32Array([speed]), []),
      });
      chunks.push(out[this.session.outputNames[0]].data as Float32Array);
    }
    return mergeAudio(chunks);
  }

  /** How many seconds of speech this computer makes per second, on a typical caption sentence. */
  async benchmark(voice: string): Promise<number> {
    const text = 'Hôm nay mình sẽ cùng nhau tìm hiểu cách máy chủ này hoạt động, từng bước một.';
    await this.synthesize(text, voice, 1.1); // the first run compiles shaders and warms caches
    const t0 = performance.now();
    const samples = await this.synthesize(text, voice, 1.1);
    return samples.length / SAMPLE_RATE / ((performance.now() - t0) / 1000);
  }
}
