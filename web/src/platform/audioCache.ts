import { cacheName, type Synthesize } from '@shared/adapters/speech/audioCache';

/** Audio kept in the browser. The least recently played sentences go first. */
export const WEB_CACHE_LIMIT_BYTES = 200 * 1024 * 1024;

const CACHE_NAME = 'readu-speech';
const INDEX_KEY = 'readu.speechIndex';

/**
 * Sentence audio in the Cache API, evicted least recently used first. The
 * recency order and sizes live in localStorage, since the Cache API keeps
 * neither. Falls back to memory where the Cache API is missing (plain http).
 */
export class WebAudioCache {
  /** Name to size, least recently used first. */
  private readonly entries = new Map<string, number>();
  private readonly memory = new Map<string, Blob>();
  private store: Promise<Cache | null> | null = null;

  constructor(private readonly limit: number) {
    try {
      const saved = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]') as [string, number][];
      for (const [name, size] of saved) this.entries.set(name, size);
    } catch {
      // A broken index only costs re-downloads.
    }
  }

  private open(): Promise<Cache | null> {
    this.store ??= 'caches' in globalThis ? caches.open(CACHE_NAME).catch(() => null) : Promise.resolve(null);
    return this.store;
  }

  async get(name: string): Promise<Blob | null> {
    const store = await this.open();
    const blob = store ? await (await store.match(name))?.blob() : this.memory.get(name);
    if (!blob) {
      this.entries.delete(name);
      return null;
    }
    this.entries.delete(name);
    this.entries.set(name, blob.size);
    this.saveIndex();
    return blob;
  }

  async put(name: string, blob: Blob): Promise<void> {
    const store = await this.open();
    if (store) await store.put(name, new Response(blob, { headers: { 'Content-Type': blob.type } }));
    else this.memory.set(name, blob);
    this.entries.delete(name);
    this.entries.set(name, blob.size);
    await this.evict(store);
    this.saveIndex();
  }

  async clear(): Promise<void> {
    this.entries.clear();
    this.memory.clear();
    if ('caches' in globalThis) await caches.delete(CACHE_NAME);
    this.store = null;
    this.saveIndex();
  }

  private async evict(store: Cache | null): Promise<void> {
    let total = 0;
    for (const size of this.entries.values()) total += size;
    // The newest file always stays, even when it alone is over the limit.
    while (total > this.limit && this.entries.size > 1) {
      const [oldest, size] = this.entries.entries().next().value as [string, number];
      this.entries.delete(oldest);
      this.memory.delete(oldest);
      total -= size;
      await store?.delete(oldest);
    }
  }

  private saveIndex(): void {
    try {
      localStorage.setItem(INDEX_KEY, JSON.stringify([...this.entries]));
    } catch {
      // Storage full or blocked: the cache still works for this visit.
    }
  }
}

/**
 * The web side of the shared SentenceAudio: `path` makes sure a sentence is
 * cached and returns its cache name, which `blob` then reads. Concurrent
 * requests for the same sentence share one download.
 */
export class WebSentenceAudio {
  private readonly pending = new Map<string, Promise<string>>();

  constructor(
    readonly cache: WebAudioCache,
    private readonly synthesize: Synthesize,
  ) {}

  path(text: string, voiceId: string, speed: number): Promise<string> {
    const name = `${cacheName(voiceId, speed.toFixed(2), text)}.mp3`;
    const inFlight = this.pending.get(name);
    if (inFlight) return inFlight;

    const job = (async () => {
      if (await this.cache.get(name)) return name;
      const audio = await this.synthesize(text, voiceId, speed);
      await this.cache.put(name, new Blob([audio], { type: 'audio/mpeg' }));
      return name;
    })().finally(() => this.pending.delete(name));
    this.pending.set(name, job);
    return job;
  }

  /** The audio behind a name from `path`, fetching it again if it was evicted meanwhile. */
  async blob(name: string, text: string, voiceId: string, speed: number): Promise<Blob> {
    const cached = await this.cache.get(name);
    if (cached) return cached;
    await this.path(text, voiceId, speed);
    const again = await this.cache.get(name);
    if (!again) throw new Error('Could not keep the audio for this sentence.');
    return again;
  }
}
