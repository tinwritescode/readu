// The dub made on this computer: Chrome's translator turns each English sentence into Vietnamese and Kokoro or
// VieNeu reads it in the offscreen document. Nothing goes to the Readu server, so it needs no account and no quota.
import { base64ToBuffer } from '../adapters/chrome/base64';
import { send, type Reply } from '../adapters/chrome/messages';
import { englishToVietnamese, TranslatorError } from '../adapters/translate/chromeTranslator';
import { slotMs } from '../domain/timing';
import type { Segment } from '../domain/types';
import { modelOf } from '../domain/voices';
import type { DubProgress, DubSource } from './dubSource';

/** Audio is made this far ahead of the viewer (video time). Shorter than the server's 3 minutes: the work is the
 *  same in the end, but it comes in short bursts as the video plays instead of minutes at full load, which heats
 *  the computer, and less is wasted when the viewer skips ahead. It stays above the playback gate's 30 s. */
const AHEAD_MS = 60_000;
/** A sentence that fails this many times stays silent. */
const MAX_FAILURES = 3;
/** Matches the server's reading speed: Vietnamese usually runs longer than the English it replaces. */
const SPEED = 1.1;
/** Chrome gets this long to make its translator, language pack download included, before the dub gives up. */
const TRANSLATOR_TIMEOUT_MS = 2 * 60_000;

export class LocalDubSource implements DubSource {
  private vi: (string | undefined)[] = [];
  private audioOf = new Map<number, ArrayBuffer>();
  private failures = new Map<number, number>();
  private position = 0;
  private rate = 1;
  private stopped = false;
  private error = '';
  private fatal = '';
  private note: string | undefined = 'Đang chuẩn bị bộ dịch của Chrome…';
  /** Wakes the worker when the viewer moves. */
  private nudge: (() => void) | null = null;

  constructor(
    private segments: Segment[],
    private voice: string,
  ) {}

  async start(position: number, rate: number): Promise<Reply<DubProgress>> {
    this.position = position;
    this.rate = rate;
    const engine = await send({ type: 'localEngine', model: modelOf(this.voice) });
    if (!engine.ok) return engine;
    if (!engine.data.installed) return { ok: false, status: 0, error: 'Chưa tải giọng đọc về máy này.' };
    void this.work();
    return { ok: true, data: this.progress() };
  }

  async poll(position: number, rate: number): Promise<Reply<DubProgress>> {
    this.position = position;
    this.rate = rate;
    this.nudge?.();
    return { ok: true, data: this.progress() };
  }

  async audio(idx: number): Promise<Reply<ArrayBuffer>> {
    const wav = this.audioOf.get(idx);
    // decodeAudioData takes the buffer over, so the session gets a copy.
    return wav ? { ok: true, data: wav.slice(0) } : { ok: false, status: 404, error: 'not ready' };
  }

  stop() {
    this.stopped = true;
    this.nudge?.();
  }

  private progress(): DubProgress {
    const failed = [...this.failures].filter(([, n]) => n >= MAX_FAILURES).map(([i]) => i);
    const ready = [...this.audioOf.keys()];
    return {
      ready,
      failed,
      translated: this.vi.filter(Boolean).length,
      done: ready.length + failed.length >= this.segments.length,
      error: ready.length === 0 && this.error ? this.error : undefined,
      fatal: this.fatal || undefined,
      note: this.note,
    };
  }

  /** The next sentence to make: the first one from the viewer onwards, within the window, without audio. */
  private next(): number {
    const end = this.position + AHEAD_MS * Math.max(1, this.rate);
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      if (s.start + slotMs(this.segments, i) <= this.position) continue;
      if (s.start >= end) break;
      if (!this.audioOf.has(i) && (this.failures.get(i) ?? 0) < MAX_FAILURES) return i;
    }
    return -1;
  }

  /** Chrome's translator, or a reason it cannot be had: the language pack may take a while to download. */
  private async translator() {
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new TranslatorError('failed', 'Chrome chưa tải xong gói dịch tiếng Việt. Thử lại sau ít phút.')), TRANSLATOR_TIMEOUT_MS);
    });
    try {
      return await Promise.race([englishToVietnamese(f => (this.note = `Đang tải gói dịch tiếng Việt của Chrome… ${Math.round(f * 100)}%`)), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async work() {
    let translator;
    try {
      translator = await this.translator();
    } catch (e) {
      const problem = e instanceof TranslatorError ? e.problem : 'failed';
      this.fatal =
        problem === 'unsupported'
          ? 'Chrome này chưa dịch được Anh sang Việt trên máy (cần Chrome 138 trở lên). Hãy chọn đọc trên máy chủ.'
          : problem === 'needs-click'
            ? 'Bấm bật lồng tiếng để Chrome tải gói dịch tiếng Việt.'
            : e instanceof Error
              ? e.message
              : String(e);
      return;
    }
    this.note = undefined;
    while (!this.stopped) {
      const i = this.next();
      if (i < 0) {
        await new Promise<void>(resolve => {
          this.nudge = resolve;
          setTimeout(resolve, 1000);
        });
        continue;
      }
      try {
        this.vi[i] ??= await translator.translate(this.segments[i].text);
        const res = await send({ type: 'localSpeak', text: this.vi[i]!, voice: this.voice, speed: SPEED });
        if (!res.ok) throw new Error(res.error);
        this.audioOf.set(i, base64ToBuffer(res.data));
        this.error = '';
      } catch (e) {
        this.failures.set(i, (this.failures.get(i) ?? 0) + 1);
        this.error = e instanceof Error ? e.message : String(e);
      }
      // Keep memory bounded on long videos: audio well behind the viewer is dropped and made again if needed.
      for (const idx of this.audioOf.keys()) if (this.segments[idx].start < this.position - 120_000) this.audioOf.delete(idx);
    }
  }
}
