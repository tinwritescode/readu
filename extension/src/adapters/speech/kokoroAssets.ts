import { storedEntries } from '../archive/storedZip';
import { AssetSet, type Asset } from './assetCache';

// The files Kokoro needs to read on this computer, downloaded once into Cache Storage. They are the same files
// the Readu app downloads onto phones (src/adapters/speech/kokoro in the app).

const MODEL_REPO = 'https://huggingface.co/contextboxai/Kokoro-Vietnamese/resolve/9f210d622209fcc216fe2ac6159fed2ff381cb8a';
/** Shared by every voice; each voicepack is fetched the first time its voice is used. */
const CORE: Asset[] = [
  { url: `${MODEL_REPO}/kokoro_vi.onnx`, bytes: 325_731_953 },
  { url: `${MODEL_REPO}/config.json`, bytes: 2_351 },
  { url: 'https://github.com/pnnbao97/sea-g2p/releases/download/v0.10.0/sea_g2p.bin', bytes: 62_829_820 },
];

export const MODEL_URL = CORE[0].url;
export const CONFIG_URL = CORE[1].url;
export const DICT_URL = CORE[2].url;
export const voicepackUrl = (voice: string) => `${MODEL_REPO}/voicepacks/${voice}.pt`;

/** Bytes downloaded before reading on this computer can start. */
export const CORE_BYTES = CORE.reduce((n, a) => n + a.bytes, 0);

const KOKORO = new AssetSet('readu-kokoro-v1', CORE);
export const isInstalled = () => KOKORO.isInstalled();
export const install = (onProgress: (done: number, total: number) => void) => KOKORO.install(onProgress);
export const read = (url: string) => KOKORO.read(url);

/**
 * A voicepack's style rows as floats. A .pt file is a zip archive; torch stores the tensor uncompressed in the
 * entry ending in "/data/0", as little-endian float32 of shape [510, 1, 256].
 */
export function voicepackFloats(pt: ArrayBuffer): Float32Array {
  const [tensor] = storedEntries(pt, name => name.endsWith('/data/0')).values();
  if (!tensor) throw new Error('voicepack has no tensor');
  return new Float32Array(tensor.slice().buffer);
}
