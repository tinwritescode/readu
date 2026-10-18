import { fromByteArray } from 'base64-js';
import RNFS from 'react-native-fs';

/** Audio kept on the device. The least recently played sentences go first. */
export const CACHE_LIMIT_BYTES = 500 * 1024 * 1024;

/**
 * MP3 files in one directory, evicted least recently used first. Recency is
 * kept in memory and seeded from file modification times at startup.
 */
export class AudioCache {
  /** File name to size, least recently used first. */
  private readonly entries = new Map<string, number>();
  private loaded: Promise<void> | null = null;

  constructor(
    private readonly dir: string,
    private readonly limit: number,
  ) {}

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      await RNFS.mkdir(this.dir);
      const files = (await RNFS.readDir(this.dir))
        .filter(f => f.isFile())
        .sort((a, b) => (a.mtime?.getTime() ?? 0) - (b.mtime?.getTime() ?? 0));
      for (const file of files) this.entries.set(file.name, file.size);
    })();
    return this.loaded;
  }

  /** Path of a cached file, marking it as just used. */
  async get(name: string): Promise<string | null> {
    await this.load();
    const size = this.entries.get(name);
    if (size === undefined) return null;
    this.entries.delete(name);
    this.entries.set(name, size);
    return this.pathOf(name);
  }

  async put(name: string, bytes: Uint8Array): Promise<string> {
    await this.load();
    await RNFS.writeFile(this.pathOf(name), fromByteArray(bytes), 'base64');
    this.entries.delete(name);
    this.entries.set(name, bytes.byteLength);
    await this.evict();
    return this.pathOf(name);
  }

  private async evict(): Promise<void> {
    let total = 0;
    for (const size of this.entries.values()) total += size;
    // The newest file always stays, even when it alone is over the limit.
    while (total > this.limit && this.entries.size > 1) {
      const [oldest, size] = this.entries.entries().next().value as [string, number];
      this.entries.delete(oldest);
      total -= size;
      await RNFS.unlink(this.pathOf(oldest)).catch(() => undefined);
    }
  }

  private pathOf(name: string): string {
    return `${this.dir}/${name}`;
  }
}

/** A 16-digit hex name from two FNV-1a passes: enough to key cache files without a crypto library. */
/* eslint-disable no-bitwise */
export function cacheName(...parts: string[]): string {
  const text = parts.join('\u0000');
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
/* eslint-enable no-bitwise */

export type Synthesize = (text: string, voiceId: string, speed: number) => Promise<ArrayBuffer>;

/**
 * Local MP3 path for a sentence, synthesized on first use. Concurrent requests
 * for the same sentence share one download.
 */
export class SentenceAudio {
  private readonly pending = new Map<string, Promise<string>>();

  constructor(
    private readonly cache: AudioCache,
    private readonly synthesize: Synthesize,
  ) {}

  path(text: string, voiceId: string, speed: number): Promise<string> {
    const name = `${cacheName(voiceId, speed.toFixed(2), text)}.mp3`;
    const inFlight = this.pending.get(name);
    if (inFlight) return inFlight;

    const job = (async () => {
      const cached = await this.cache.get(name);
      if (cached) return cached;
      const audio = await this.synthesize(text, voiceId, speed);
      return this.cache.put(name, new Uint8Array(audio));
    })().finally(() => this.pending.delete(name));
    this.pending.set(name, job);
    return job;
  }
}
