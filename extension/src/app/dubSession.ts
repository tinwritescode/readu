// One dubbing session for one video: asks the backend for the dub, polls it, and plays each Vietnamese sentence
// in time with the video.
import { OriginalVolume } from '../adapters/audio/originalVolume';
import { base64ToBuffer } from '../adapters/chrome/base64';
import { send } from '../adapters/chrome/messages';
import { RESUME_BUFFER_MS, START_BUFFER_MS, readyAheadMs } from '../domain/buffering';
import { LATE_START_MS, playbackRate, segmentAt, slotMs } from '../domain/timing';
import type { DubStatus, Segment, Settings } from '../domain/types';

const POLL_MS = 2000;
/** Polls come faster while the video waits for the dub, so it plays again soon after enough is ready. */
const WAIT_POLL_MS = 1000;
/** With no audio after this long, the speech worker is probably waking from sleep. */
const COLD_START_HINT_MS = 5000;
/** Sentences ahead of the current one whose audio is fetched in advance. */
const PREFETCH_AHEAD = 10;
/** A sentence still speaking may run this far into the next one's time before it is cut off. */
const MAX_OVERRUN_MS = 1500;
/** The shortest time a sentence is squeezed into after a late start. */
const MIN_SLOT_MS = 800;

export type Overlay = 'none' | 'waiting' | 'not-ready' | 'quota' | 'error';

/** One dubbing session for one video: polls the backend and plays sentences in sync with the video. */
export class Dub {
  /** The dub has its own context so pausing the video can pause it mid-sentence. */
  private ctx = new AudioContext();
  private gain = this.ctx.createGain();
  private original: OriginalVolume;
  private buffers = new Map<number, AudioBuffer | 'loading' | 'error'>();
  private loading = 0;
  private status: DubStatus | null = null;
  private ready = new Set<number>();
  private failed = new Set<number>();
  private playing: { idx: number; source: AudioBufferSourceNode; duration: number; slot: number } | null = null;
  /** The last sentence started or skipped, so it is not started twice. */
  private handled = -1;
  private startedAt = Date.now();
  private pollTimer = 0;
  private tickTimer = 0;
  private stopped = false;
  /** The video waits until this much dub (ms) is ready ahead; null while it plays. */
  private waitFor: number | null = START_BUFFER_MS;
  /** The video is paused by the dub, not by the viewer, so the dub plays it again. */
  private pausedByDub: boolean;
  /** The viewer chose to watch without waiting; the dub joins in when it catches up. */
  private skipWaiting = false;
  /** Set while the dub itself calls play(), so its own play event is not taken as the viewer's. */
  private resuming = false;
  /** When the current wait began, and the viewer's last click or key press (ms). */
  private waitStartedAt = Date.now();
  private lastInputAt = 0;
  /** The wait percentage last shown, so the overlay is redrawn only when it changes. */
  private shownPct = -1;

  /** playing: the video was playing when dubbing was turned on, and was paused to wait for the dub. */
  constructor(
    private video: HTMLVideoElement,
    private info: { id: string; title: string; description: string },
    private segments: Segment[],
    private settings: Settings,
    private onUpdate: (dub: Dub) => void,
    playing: boolean,
  ) {
    this.pausedByDub = playing;
    // Autoplay may have started while the captions loaded.
    if (!video.paused) {
      this.pausedByDub = true;
      video.pause();
    }
    this.gain.connect(this.ctx.destination);
    this.gain.gain.value = settings.dubVolume;
    this.original = new OriginalVolume(video);
    this.original.set(settings.originalVolume);
    video.addEventListener('seeking', this.onSeek);
    video.addEventListener('ratechange', this.onRateChange);
    video.addEventListener('play', this.onPlay);
    document.addEventListener('pointerdown', this.onInput, true);
    document.addEventListener('keydown', this.onInput, true);
  }

  overlay: Overlay = 'waiting';
  error = '';

  get progress(): { done: number; total: number } {
    return { done: this.ready.size, total: this.segments.length };
  }

  /** How much of the dub the video waits for is ready, 0..1. */
  get waitProgress(): number {
    if (this.waitFor === null) return 1;
    return Math.min(1, this.readyAhead() / this.waitFor);
  }

  /** No audio yet after a while: the speech worker is probably waking from sleep. */
  get coldStart(): boolean {
    return this.ready.size === 0 && Date.now() - this.startedAt > COLD_START_HINT_MS && (this.status?.translated ?? 0) > 0;
  }

  /** The viewer chose to watch now; the dub plays each sentence once it is ready. */
  watchNow() {
    this.skipWaiting = true;
    this.endWait();
  }

  async start() {
    const res = await send({
      type: 'createDub',
      videoId: this.info.id,
      title: this.info.title,
      description: this.info.description,
      voice: this.settings.voice,
      position: this.video.currentTime * 1000,
      rate: this.video.playbackRate,
      segments: this.segments,
    });
    if (this.stopped) return;
    if (!res.ok) {
      this.fail(res.status, res.error);
      return;
    }
    this.apply(res.data);
    this.tickTimer = window.setInterval(() => this.tick(), 50);
    this.schedulePoll();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.tickTimer);
    clearTimeout(this.pollTimer);
    this.stopSource();
    this.video.removeEventListener('seeking', this.onSeek);
    this.video.removeEventListener('ratechange', this.onRateChange);
    this.video.removeEventListener('play', this.onPlay);
    document.removeEventListener('pointerdown', this.onInput, true);
    document.removeEventListener('keydown', this.onInput, true);
    this.endWait();
    this.original.restore();
    void this.ctx.close();
  }

  setVolumes(originalVolume: number, dubVolume: number) {
    this.settings = { ...this.settings, originalVolume, dubVolume };
    this.gain.gain.value = dubVolume;
    this.original.set(originalVolume);
  }

  private fail(status: number, error: string) {
    // With no dub coming, the video should not stay paused for it.
    this.endWait();
    if (status === 402) {
      this.overlay = 'quota';
    } else {
      this.overlay = 'error';
      this.error =
        status === 401
          ? 'Hãy đăng nhập trong biểu tượng Readu Dub trên thanh công cụ.'
          : status === 503 || status === 404
            ? 'Máy chủ chưa bật tính năng lồng tiếng (cần deploy backend bản mới).'
            : `Lỗi máy chủ: ${error}`;
    }
    this.onUpdate(this);
  }

  private schedulePoll() {
    if (this.stopped || this.status?.stage === 'done') return;
    this.pollTimer = window.setTimeout(async () => {
      const res = await send({
        type: 'dubStatus',
        id: this.status!.id,
        voice: this.settings.voice,
        position: this.video.currentTime * 1000,
        rate: this.video.playbackRate,
      });
      if (this.stopped) return;
      if (res.ok) this.apply(res.data);
      else if (res.status === 401) return this.fail(401, res.error);
      this.schedulePoll();
    }, this.waitFor === null ? POLL_MS : WAIT_POLL_MS);
  }

  private apply(st: DubStatus) {
    this.status = st;
    this.ready = new Set(st.ready);
    this.failed = new Set(st.failed);
    if (st.stage === 'error' && st.ready.length === 0) this.error = st.error ?? '';
    this.onUpdate(this);
  }

  /** Dub ready ahead of the video: sentences with audio on the server, or that failed and stay silent. */
  private readyAhead(): number {
    return readyAheadMs(this.segments, this.video.currentTime * 1000, i => this.ready.has(i) || this.failed.has(i));
  }

  /** Pauses the video until ms of dub is ready ahead. */
  private beginWait(ms: number) {
    this.waitFor = ms;
    this.waitStartedAt = Date.now();
    if (!this.video.paused) {
      this.pausedByDub = true;
      this.video.pause();
    }
    this.onUpdate(this);
  }

  /** Stops waiting and plays the video again if the dub paused it. */
  private endWait() {
    this.waitFor = null;
    if (this.pausedByDub) {
      this.pausedByDub = false;
      this.resuming = true;
      void this.video.play().finally(() => (this.resuming = false));
    }
  }

  private onInput = () => {
    this.lastInputAt = Date.now();
  };

  // The viewer pressed play while the video waited: their choice wins, and the video plays without the dub
  // until it catches up. A play with no click or key just before it, made after the wait began, is YouTube's
  // autoplay (the click on the video's link came earlier), and waits too.
  private onPlay = () => {
    if (this.resuming || this.waitFor === null) return;
    const byViewer = this.lastInputAt > this.waitStartedAt && Date.now() - this.lastInputAt < 1500;
    if (!byViewer) {
      this.pausedByDub = true;
      this.video.pause();
      return;
    }
    this.pausedByDub = false;
    this.watchNow();
    this.onUpdate(this);
  };

  private onSeek = () => {
    this.stopSource();
    this.handled = -1;
  };

  private onRateChange = () => {
    const p = this.playing;
    if (p) p.source.playbackRate.value = playbackRate(p.duration, p.slot, this.video.playbackRate);
  };

  private stopSource() {
    try {
      this.playing?.source.stop();
    } catch {
      // already stopped
    }
    this.playing = null;
  }

  private load(idx: number) {
    if (this.buffers.has(idx) || this.loading >= 3 || !this.ready.has(idx) || !this.status) return;
    this.buffers.set(idx, 'loading');
    this.loading++;
    void send({ type: 'dubAudio', id: this.status.id, idx, voice: this.settings.voice })
      .then(async res => {
        if (!res.ok && res.status === 402) {
          // Today's minutes ran out mid-video: stop asking and say so.
          this.buffers.delete(idx);
          clearTimeout(this.pollTimer);
          return this.fail(402, res.error);
        }
        if (!res.ok) throw new Error(res.error);
        this.buffers.set(idx, await this.ctx.decodeAudioData(base64ToBuffer(res.data)));
      })
      .catch(() => this.buffers.set(idx, 'error'))
      .finally(() => this.loading--);
  }

  private tick() {
    const t = this.video.currentTime * 1000;
    const cur = segmentAt(this.segments, t);
    const from = cur >= 0 ? cur : this.segments.findIndex(s => s.start > t);
    if (from >= 0) for (let i = from; i < Math.min(this.segments.length, from + PREFETCH_AHEAD); i++) this.load(i);
    // Keep memory bounded on long videos.
    for (const idx of this.buffers.keys()) if (idx < from - 20 && this.buffers.get(idx) !== 'loading') this.buffers.delete(idx);

    if (this.waitFor !== null) {
      // Enough ready ahead, and the sentence to play first is loaded: play.
      const first = this.buffers.get(cur);
      if (this.readyAhead() >= this.waitFor && (cur < 0 || first instanceof AudioBuffer || first === 'error' || this.failed.has(cur))) {
        this.endWait();
      }
    }
    this.updateOverlay(cur);
    // Pausing holds the sentence where it is; playing again carries on from there.
    if (this.video.paused || this.video.seeking || this.video.ended) {
      if (this.ctx.state === 'running') void this.ctx.suspend();
      return;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (cur < 0 || cur === this.handled) return;

    const lateness = t - this.segments[cur].start;
    // The previous sentence is still speaking: let it finish rather than cut it off, unless it has run far
    // into this sentence's time. The next one then starts late and speeds up to catch up.
    if (this.playing && this.playing.idx !== cur) {
      if (lateness < MAX_OVERRUN_MS) return;
      this.stopSource();
    }
    const buf = this.buffers.get(cur);
    if (!(buf instanceof AudioBuffer)) {
      if (lateness > LATE_START_MS || this.failed.has(cur) || buf === 'error') this.handled = cur;
      // The dub fell behind: wait for it like the video waits for its own buffer, unless the viewer chose
      // to watch on without it.
      else if (!this.skipWaiting) this.beginWait(RESUME_BUFFER_MS);
      return;
    }
    this.handled = cur;
    // The dub has caught up, so it waits again the next time it falls behind.
    this.skipWaiting = false;
    if (lateness > LATE_START_MS) return;
    // The sentence always starts from its beginning, fitted into what is left of its time.
    const slot = Math.max(MIN_SLOT_MS, slotMs(this.segments, cur) - lateness);
    const source = this.ctx.createBufferSource();
    source.buffer = buf;
    source.playbackRate.value = playbackRate(buf.duration, slot, this.video.playbackRate);
    source.connect(this.gain);
    source.start();
    const playing = { idx: cur, source, duration: buf.duration, slot };
    source.onended = () => {
      if (this.playing === playing) this.playing = null;
    };
    this.playing = playing;
  }

  private updateOverlay(cur: number) {
    if (this.overlay === 'quota' || this.overlay === 'error') return;
    let next: Overlay = 'none';
    if (this.waitFor !== null) {
      next = 'waiting';
    } else if (cur >= 0 && cur !== this.handled && !this.playing && !this.ready.has(cur) && !this.failed.has(cur) && !this.video.paused) {
      next = 'not-ready';
    }
    const pct = Math.round(this.waitProgress * 100);
    if (next !== this.overlay || (next === 'waiting' && pct !== this.shownPct)) {
      this.overlay = next;
      this.shownPct = pct;
      this.onUpdate(this);
    }
  }

}
