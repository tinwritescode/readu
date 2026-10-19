// Model files downloaded once into Cache Storage, so a voice reads on this computer without the network.
// A file is looked up in every cache of the extension, so files two voice models share (the sea-g2p
// dictionary) are downloaded once, whichever model came first.

export interface Asset {
  url: string;
  bytes: number;
}

export class AssetSet {
  constructor(
    private cacheName: string,
    private assets: Asset[],
  ) {}

  /** Bytes still to download before this set is complete. */
  async missingBytes(): Promise<number> {
    let n = 0;
    for (const a of this.assets) if (!(await caches.match(a.url))) n += a.bytes;
    return n;
  }

  async isInstalled(): Promise<boolean> {
    return (await this.missingBytes()) === 0;
  }

  /** Downloads whatever is missing, reporting bytes done of the set's total. A file is stored only once complete. */
  async install(onProgress: (done: number, total: number) => void): Promise<void> {
    const total = this.assets.reduce((n, a) => n + a.bytes, 0);
    const cache = await caches.open(this.cacheName);
    let done = 0;
    for (const asset of this.assets) {
      if (await caches.match(asset.url)) {
        done += asset.bytes;
        onProgress(done, total);
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
        onProgress(done, total);
      }
      await cache.put(asset.url, new Response(new Blob(parts as BlobPart[])));
    }
  }

  /** A file's bytes, fetching and caching it first if no cache has it yet. */
  async read(url: string): Promise<ArrayBuffer> {
    let res = await caches.match(url);
    if (!res) {
      const fresh = await fetch(url);
      if (!fresh.ok) throw new Error(`download failed (${fresh.status}): ${url}`);
      await (await caches.open(this.cacheName)).put(url, fresh.clone());
      res = fresh;
    }
    return res.arrayBuffer();
  }

  async uninstall(): Promise<void> {
    await caches.delete(this.cacheName);
  }
}
