// Where a dub session gets its Vietnamese audio from: the Readu server, or this computer (localDubSource.ts).
import { base64ToBuffer } from '../adapters/chrome/base64';
import { send, type Reply } from '../adapters/chrome/messages';
import type { DubStatus, Segment } from '../domain/types';

/** Which sentences have audio, so the session knows what it can play and when to wait. */
export interface DubProgress {
  ready: number[];
  failed: number[];
  translated: number;
  /** Every sentence has audio or has failed: no need to ask again. */
  done: boolean;
  /** Why nothing could be made, when nothing was. */
  error?: string;
  /** Nothing can be made at all, and why: the session stops and says so. */
  fatal?: string;
  /** What the source is doing while the viewer waits, when it is more than making sentences. */
  note?: string;
}

export interface DubSource {
  /** Starts making the dub from where the viewer is. A failure carries an HTTP-like status (402: quota). */
  start(position: number, rate: number): Promise<Reply<DubProgress>>;
  /** Tells the source where the viewer is, and returns what is ready now. */
  poll(position: number, rate: number): Promise<Reply<DubProgress>>;
  /** A sentence's audio as an encoded file (MP3 or WAV), for decodeAudioData. */
  audio(idx: number): Promise<Reply<ArrayBuffer>>;
  stop(): void;
}

function progressOf(st: DubStatus): DubProgress {
  return {
    ready: st.ready,
    failed: st.failed,
    translated: st.translated,
    done: st.stage === 'done',
    error: st.stage === 'error' ? st.error : undefined,
  };
}

/** The Readu server translates and speaks; the extension polls it and fetches each sentence it plays. */
export class ServerDubSource implements DubSource {
  private id = 0;

  constructor(
    private info: { id: string; title: string; description: string },
    private segments: Segment[],
    private voice: string,
  ) {}

  async start(position: number, rate: number): Promise<Reply<DubProgress>> {
    const res = await send({
      type: 'createDub',
      videoId: this.info.id,
      title: this.info.title,
      description: this.info.description,
      voice: this.voice,
      position,
      rate,
      segments: this.segments,
    });
    if (!res.ok) return res;
    this.id = res.data.id;
    return { ok: true, data: progressOf(res.data) };
  }

  async poll(position: number, rate: number): Promise<Reply<DubProgress>> {
    const res = await send({ type: 'dubStatus', id: this.id, voice: this.voice, position, rate });
    return res.ok ? { ok: true, data: progressOf(res.data) } : res;
  }

  async audio(idx: number): Promise<Reply<ArrayBuffer>> {
    const res = await send({ type: 'dubAudio', id: this.id, idx, voice: this.voice });
    return res.ok ? { ok: true, data: base64ToBuffer(res.data) } : res;
  }

  stop() {}
}
