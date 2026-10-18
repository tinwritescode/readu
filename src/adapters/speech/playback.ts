import TrackPlayer, {
  Capability,
  Event,
  State,
  type Track,
} from 'react-native-track-player';
import type { SentenceAudio } from './audioCache';

export type PlaybackStatus = 'idle' | 'speaking' | 'paused';

/** What to read: one sentence per entry of `texts`, all in one voice and speed. */
export interface ReadingJob {
  title: string;
  texts: string[];
  voiceId: string;
  speed: number;
  /** A voice preview: plays with no reading position or sentence highlight. */
  silent: boolean;
}

export interface PlaybackEvents {
  onStatus(status: PlaybackStatus, silent: boolean): void;
  /** Index of the sentence now playing. Not called for silent jobs. */
  onSentence(index: number): void;
  /** The last sentence of a reading job has finished. */
  onFinish(): void;
  onError(error: unknown): void;
}

/** Sentences downloaded and queued ahead of the one playing. */
export const PREFETCH = 2;

interface ActiveJob extends ReadingJob {
  /** Index of the last sentence in the player queue. */
  queued: number;
  /** The sentence playing now. */
  current: number;
}

/**
 * Plays sentences of a document through react-native-track-player. The queue
 * holds the sentence playing plus the next few, each fetched as an MP3 and
 * tagged with its sentence index, so the lock screen and the reader stay in step.
 */
export class Reader {
  private job: ActiveJob | null = null;
  private chain: Promise<void> = Promise.resolve();
  private setup: Promise<void> | null = null;

  constructor(
    private readonly audio: SentenceAudio,
    private readonly events: PlaybackEvents,
  ) {}

  /** Sets up the player and the lock-screen controls once. Safe to call again. */
  ensureSetup(): Promise<void> {
    this.setup ??= (async () => {
      try {
        await TrackPlayer.setupPlayer({ autoHandleInterruptions: true });
      } catch (e) {
        if ((e as { code?: string }).code !== 'player_already_initialized') throw e;
      }
      await TrackPlayer.updateOptions({
        capabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext, Capability.SkipToPrevious],
        compactCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext, Capability.SkipToPrevious],
        notificationCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext, Capability.SkipToPrevious],
      });
      TrackPlayer.addEventListener(Event.PlaybackState, ({ state }) => this.onState(state));
      TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, ({ track }) => this.onTrackChanged(track));
      TrackPlayer.addEventListener(Event.PlaybackQueueEnded, () => this.onQueueEnded());
      TrackPlayer.addEventListener(Event.PlaybackError, e => this.events.onError(new Error(e.message)));
      TrackPlayer.addEventListener(Event.RemotePlay, () => this.resume());
      TrackPlayer.addEventListener(Event.RemotePause, () => this.pause());
      TrackPlayer.addEventListener(Event.RemoteNext, () => this.jump(this.job ? this.job.current + 1 : 0));
      TrackPlayer.addEventListener(Event.RemotePrevious, () => this.jump(this.job ? this.job.current - 1 : 0));
      TrackPlayer.addEventListener(Event.RemoteStop, () => this.stop());
    })();
    return this.setup;
  }

  /** Starts `job` at sentence `from`, replacing whatever was playing. */
  async play(job: ReadingJob, from: number): Promise<void> {
    await this.ensureSetup();
    const count = job.texts.length;
    if (count === 0) return this.finish(job);
    const start = Math.min(Math.max(0, from), count - 1);
    this.job = { ...job, queued: start - 1, current: start };
    this.events.onStatus('speaking', job.silent);
    await TrackPlayer.reset();
    await this.enqueue(start + PREFETCH);
    if (this.job?.texts !== job.texts) return;
    await TrackPlayer.play();
  }

  /** Replays the active job from another sentence. Used by the lock screen's next and previous. */
  jump(index: number): void {
    const job = this.job;
    if (!job) return;
    const target = Math.min(Math.max(0, index), job.texts.length - 1);
    this.play(job, target).catch(e => this.events.onError(e));
  }

  async pause(): Promise<void> {
    if (this.job) await TrackPlayer.pause();
  }

  async resume(): Promise<void> {
    if (this.job) await TrackPlayer.play();
  }

  async stop(): Promise<void> {
    this.job = null;
    this.events.onStatus('idle', false);
    await this.ensureSetup();
    await TrackPlayer.reset();
  }

  /** Downloads and queues sentences up to `last`, one at a time and in order. */
  private enqueue(last: number): Promise<void> {
    const job = this.job;
    if (!job) return Promise.resolve();
    const run = this.chain.then(async () => {
      const upTo = Math.min(last, job.texts.length - 1);
      while (this.job === job && job.queued < upTo) {
        const index = job.queued + 1;
        const path = await this.audio.path(job.texts[index], job.voiceId, job.speed);
        if (this.job !== job) return;
        await TrackPlayer.add({
          id: String(index),
          url: `file://${path}`,
          title: job.title,
          artist: 'vTTS Reader',
        } satisfies Track);
        job.queued = index;
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private onState(state: State): void {
    if (!this.job) return;
    if (state === State.Playing || state === State.Buffering || state === State.Loading) {
      this.events.onStatus('speaking', this.job.silent);
    } else if (state === State.Paused) {
      this.events.onStatus('paused', this.job.silent);
    }
  }

  private onTrackChanged(track: Track | undefined): void {
    const job = this.job;
    if (!job || !track) return;
    job.current = Number(track.id);
    if (!job.silent) this.events.onSentence(job.current);
    this.enqueue(job.current + PREFETCH).catch(e => this.events.onError(e));
  }

  /** The queue ran dry: either the reading is over, or the next sentence is still downloading. */
  private async onQueueEnded(): Promise<void> {
    const job = this.job;
    if (!job) return;
    if (job.queued >= job.texts.length - 1) return this.finish(job);

    try {
      const before = (await TrackPlayer.getQueue()).length;
      await this.enqueue(job.queued + PREFETCH);
      if (this.job !== job) return;
      if ((await TrackPlayer.getQueue()).length > before) {
        await TrackPlayer.skip(before);
        await TrackPlayer.play();
      }
    } catch (e) {
      this.events.onError(e);
    }
  }

  private finish(job: ActiveJob | ReadingJob): void {
    this.job = null;
    this.events.onStatus('idle', job.silent);
    if (!job.silent) this.events.onFinish();
  }
}
