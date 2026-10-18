import type { PlaybackEvents, PlaybackStatus, ReadingJob } from '@shared/adapters/speech/playback';
import type { WebSentenceAudio } from './audioCache';

export type { PlaybackEvents, PlaybackStatus, ReadingJob };

/** Sentences downloaded ahead of the one playing. */
export const PREFETCH = 2;

interface ActiveJob extends ReadingJob {
  current: number;
}

/**
 * The browser build of the shared Reader (playback.ts in src/, which uses
 * react-native-track-player): same methods and events, played one sentence at
 * a time through a single <audio> element, with the Media Session API standing
 * in for the lock-screen controls.
 */
export class Reader {
  private job: ActiveJob | null = null;
  private readonly element = new Audio();
  private url: string | null = null;
  /** Bumped by every play, jump and stop, so a slow download cannot start a sentence that was left. */
  private run = 0;

  constructor(
    private readonly audio: WebSentenceAudio,
    private readonly events: PlaybackEvents,
  ) {
    this.element.preload = 'auto';
    this.element.addEventListener('playing', () => this.status('speaking'));
    this.element.addEventListener('waiting', () => this.status('loading'));
    this.element.addEventListener('ended', () => this.next());
    this.element.addEventListener('error', () => {
      if (this.job && this.element.src) this.events.onError(new Error('The audio could not be played.'));
    });

    const session = navigator.mediaSession;
    if (session) {
      session.setActionHandler('play', () => this.resume());
      session.setActionHandler('pause', () => this.pause());
      session.setActionHandler('nexttrack', () => this.jump(this.job ? this.job.current + 1 : 0));
      session.setActionHandler('previoustrack', () => this.jump(this.job ? this.job.current - 1 : 0));
      session.setActionHandler('stop', () => this.stop());
    }
  }

  /** Nothing to set up in the browser; kept so the Reader matches the mobile one. */
  ensureSetup(): Promise<void> {
    return Promise.resolve();
  }

  /** Starts `job` at sentence `from`, replacing whatever was playing. */
  async play(job: ReadingJob, from: number): Promise<void> {
    const count = job.texts.length;
    if (count === 0) return this.finish(job);
    const start = Math.min(Math.max(0, from), count - 1);
    this.job = { ...job, current: start };
    if (navigator.mediaSession) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: job.title, artist: 'Readu' });
    }
    // Safari only lets audio start inside the click that asked for it, so the
    // element is claimed now, before the download below gives the click up.
    // The old sentence is unloaded first so the claim does not replay it.
    this.element.pause();
    this.element.removeAttribute('src');
    this.element.load();
    this.release();
    this.element.play().catch(() => undefined);
    await this.load(this.job, start);
  }

  /** Replays the active job from another sentence. */
  jump(index: number): void {
    const job = this.job;
    if (!job) return;
    this.play(job, Math.min(Math.max(0, index), job.texts.length - 1)).catch(e => this.events.onError(e));
  }

  async pause(): Promise<void> {
    if (!this.job) return;
    this.element.pause();
    this.status('paused');
  }

  async resume(): Promise<void> {
    if (!this.job) return;
    await this.element.play();
  }

  async stop(): Promise<void> {
    this.run++;
    this.job = null;
    this.element.pause();
    this.release();
    this.events.onStatus('idle', false);
  }

  /** Fetches sentence `index` of `job`, plays it, and starts fetching the ones after it. */
  private async load(job: ActiveJob, index: number): Promise<void> {
    const run = ++this.run;
    job.current = index;
    this.status('loading');
    const text = job.texts[index];
    const name = await this.audio.path(text, job.voiceId, job.speed);
    const blob = await this.audio.blob(name, text, job.voiceId, job.speed);
    if (run !== this.run || this.job !== job) return;

    this.release();
    this.url = URL.createObjectURL(blob);
    this.element.src = this.url;
    if (!job.silent) this.events.onSentence(index);
    for (let ahead = index + 1; ahead <= Math.min(index + PREFETCH, job.texts.length - 1); ahead++) {
      this.audio.path(job.texts[ahead], job.voiceId, job.speed).catch(() => undefined);
    }
    await this.element.play();
  }

  private next(): void {
    const job = this.job;
    if (!job) return;
    if (job.current >= job.texts.length - 1) return this.finish(job);
    this.load(job, job.current + 1).catch(e => this.events.onError(e));
  }

  private status(next: PlaybackStatus): void {
    if (this.job) this.events.onStatus(next, this.job.silent);
    if (navigator.mediaSession) {
      navigator.mediaSession.playbackState = next === 'paused' ? 'paused' : next === 'speaking' ? 'playing' : 'none';
    }
  }

  private release(): void {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }

  private finish(job: ActiveJob | ReadingJob): void {
    this.job = null;
    this.release();
    this.events.onStatus('idle', job.silent);
    if (!job.silent) this.events.onFinish();
  }
}
