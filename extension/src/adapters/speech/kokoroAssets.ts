// The files Kokoro needs to read on this computer, downloaded once into Cache Storage. They are the same files
// the Readu app downloads onto phones (src/adapters/speech/kokoro in the app).

const MODEL_REPO = 'https://huggingface.co/contextboxai/Kokoro-Vietnamese/resolve/9f210d622209fcc216fe2ac6159fed2ff381cb8a';
const CACHE = 'readu-kokoro-v1';

interface Asset {
  url: string;
  bytes: number;
}

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

export async function isInstalled(): Promise<boolean> {
  const cache = await caches.open(CACHE);
  const found = await Promise.all(CORE.map(a => cache.match(a.url)));
  return found.every(Boolean);
}

/** Downloads whatever is missing, reporting bytes done of CORE_BYTES. A file is stored only once complete. */
export async function install(onProgress: (done: number, total: number) => void): Promise<void> {
  const cache = await caches.open(CACHE);
  let done = 0;
  for (const asset of CORE) {
    if (await cache.match(asset.url)) {
      done += asset.bytes;
      onProgress(done, CORE_BYTES);
      continue;
    }
    const res = await fetch(asset.url);
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status}): ${asset.url}`);
    const parts: Uint8Array[] = [];
    const reader = res.body.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      parts.push(value);
      done += value.length;
      onProgress(done, CORE_BYTES);
    }
    await cache.put(asset.url, new Response(new Blob(parts as BlobPart[])));
  }
}

/** A cached file's bytes, fetching and caching it first if needed (voicepacks). */
export async function read(url: string): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE);
  let res = await cache.match(url);
  if (!res) {
    const fresh = await fetch(url);
    if (!fresh.ok) throw new Error(`download failed (${fresh.status}): ${url}`);
    await cache.put(url, fresh.clone());
    res = fresh;
  }
  return res.arrayBuffer();
}

export async function uninstall(): Promise<void> {
  await caches.delete(CACHE);
}

/**
 * A voicepack's style rows as floats. A .pt file is a zip archive; torch stores the tensor uncompressed in the
 * entry ending in "/data/0", as little-endian float32 of shape [510, 1, 256].
 */
export function voicepackFloats(pt: ArrayBuffer): Float32Array {
  const view = new DataView(pt);
  // The end-of-central-directory record is in the last 64 KiB plus 22 bytes.
  let eocd = -1;
  for (let i = pt.byteLength - 22; i >= Math.max(0, pt.byteLength - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('voicepack is not a zip archive');
  const entries = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let n = 0; n < entries; n++) {
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(pt, p + 46, nameLen));
    if (name.endsWith('/data/0')) {
      if (method !== 0) throw new Error('voicepack tensor is compressed');
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      return new Float32Array(pt.slice(start, start + size));
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('voicepack has no tensor');
}
