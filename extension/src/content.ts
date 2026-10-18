// Runs on youtube.com in the extension's isolated world. Adds the "Dub VI" button and panel to the player,
// gets the dub made by the backend, and plays each Vietnamese sentence in time with the video.
import { requestCaptions } from './bridge';
import { toSegments } from './captions';
import { LoginForm } from './login';
import { LATE_START_MS, playbackRate, segmentAt, slotMs } from './timing';
import { loadSettings, saveSettings, send, type DubStatus, type Segment, type Settings, type Voice } from './types';

const POLL_MS = 2000;
/** With no audio after this long, the speech worker is probably waking from sleep. */
const COLD_START_HINT_MS = 5000;
/** Sentences ahead of the current one whose audio is fetched in advance. */
const PREFETCH_AHEAD = 10;
/** A sentence still speaking may run this far into the next one's time before it is cut off. */
const MAX_OVERRUN_MS = 1500;
/** The shortest time a sentence is squeezed into after a late start. */
const MIN_SLOT_MS = 800;

type Overlay = 'none' | 'preparing' | 'cold' | 'not-ready' | 'quota' | 'error';

const OVERLAY_TEXT: Record<Exclude<Overlay, 'none'>, [string, string]> = {
  preparing: ['Đang chuẩn bị lồng tiếng…', 'Đang dịch phụ đề sang tiếng Việt'],
  cold: ['Đang khởi động giọng đọc…', 'Lần đầu mất khoảng 30 giây'],
  'not-ready': ['Câu tiếp theo chưa sẵn sàng', 'Đang tạo giọng đọc, sẽ phát ngay khi xong'],
  quota: ['Đã hết lượt lồng tiếng hôm nay', 'Gói Free giới hạn số video mỗi ngày'],
  error: ['Không lồng tiếng được', ''],
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Turns the video's own sound down while dubbing. The video is routed once through a Web Audio gain, so the
 * level never fights YouTube, which rewrites video.volume from its own slider. If the element cannot be routed
 * (another extension already captured it), video.volume is used instead.
 */
class OriginalVolume {
  private static graphs = new WeakMap<HTMLVideoElement, GainNode>();
  private gain: GainNode | null;
  private level = 1;
  /** The viewer's own volume, when falling back to video.volume. */
  private viewerVolume: number | null = null;

  constructor(private video: HTMLVideoElement) {
    this.gain = OriginalVolume.route(video);
    if (!this.gain) video.addEventListener('volumechange', this.onVolumeChange);
  }

  private static route(video: HTMLVideoElement): GainNode | null {
    const known = OriginalVolume.graphs.get(video);
    if (known) return known;
    // Without a user gesture on the page the context would start suspended and silence the video.
    if (!navigator.userActivation?.hasBeenActive) return null;
    try {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      ctx.createMediaElementSource(video).connect(gain).connect(ctx.destination);
      // A routed video plays through this context, so it must run whenever the video does.
      video.addEventListener('play', () => void ctx.resume());
      void ctx.resume();
      OriginalVolume.graphs.set(video, gain);
      return gain;
    } catch {
      return null;
    }
  }

  set(level: number) {
    this.level = level;
    if (this.gain) {
      this.gain.gain.value = level;
      return;
    }
    this.viewerVolume ??= this.video.volume;
    this.video.volume = this.viewerVolume * level;
  }

  restore() {
    if (this.gain) {
      this.gain.gain.value = 1;
      return;
    }
    this.video.removeEventListener('volumechange', this.onVolumeChange);
    if (this.viewerVolume !== null) this.video.volume = this.viewerVolume;
    this.viewerVolume = null;
  }

  // A volume this code did not set came from the viewer or YouTube: take it as the full level and lower it again.
  private onVolumeChange = () => {
    if (this.viewerVolume === null || Math.abs(this.video.volume - this.viewerVolume * this.level) < 0.01) return;
    this.viewerVolume = this.video.volume;
    this.video.volume = this.viewerVolume * this.level;
  };
}

/** One dubbing session for one video: polls the backend and plays sentences in sync with the video. */
class Dub {
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

  constructor(
    private video: HTMLVideoElement,
    private info: { id: string; title: string; description: string },
    private segments: Segment[],
    private settings: Settings,
    private onUpdate: (dub: Dub) => void,
  ) {
    this.gain.connect(this.ctx.destination);
    this.gain.gain.value = settings.dubVolume;
    this.original = new OriginalVolume(video);
    this.original.set(settings.originalVolume);
    video.addEventListener('seeking', this.onSeek);
    video.addEventListener('ratechange', this.onRateChange);
  }

  overlay: Overlay = 'preparing';
  error = '';

  get progress(): { done: number; total: number } {
    return { done: this.ready.size, total: this.segments.length };
  }

  async start() {
    const res = await send({
      type: 'createDub',
      videoId: this.info.id,
      title: this.info.title,
      description: this.info.description,
      voice: this.settings.voice,
      position: this.video.currentTime * 1000,
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
    this.original.restore();
    void this.ctx.close();
  }

  setVolumes(originalVolume: number, dubVolume: number) {
    this.settings = { ...this.settings, originalVolume, dubVolume };
    this.gain.gain.value = dubVolume;
    this.original.set(originalVolume);
  }

  private fail(status: number, error: string) {
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
      });
      if (this.stopped) return;
      if (res.ok) this.apply(res.data);
      else if (res.status === 401) return this.fail(401, res.error);
      this.schedulePoll();
    }, POLL_MS);
  }

  private apply(st: DubStatus) {
    this.status = st;
    this.ready = new Set(st.ready);
    this.failed = new Set(st.failed);
    if (st.stage === 'error' && st.ready.length === 0) this.error = st.error ?? '';
    this.onUpdate(this);
  }

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
      return;
    }
    this.handled = cur;
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
    if (this.ready.size === 0) {
      next = Date.now() - this.startedAt > COLD_START_HINT_MS && (this.status?.translated ?? 0) > 0 ? 'cold' : 'preparing';
    } else if (cur >= 0 && cur !== this.handled && !this.playing && !this.ready.has(cur) && !this.failed.has(cur) && !this.video.paused) {
      next = 'not-ready';
    }
    if (next !== this.overlay) {
      this.overlay = next;
      this.onUpdate(this);
    }
  }
}

/** The button, panel and overlay on the watch page, and the dub they control. */
class DubUI {
  private button = el('button', 'rdub-button');
  private panel = el('div', 'rdub-panel');
  private overlay = el('div', 'rdub-overlay');
  private progress = el('div', 'rdub-progress');
  private login = new LoginForm((_step, title, text) => {
    const head = el('div', 'rdub-login-head');
    head.append(el('div', 'rdub-login-title', title));
    if (text) head.append(el('p', 'rl-text', text));
    return [head];
  });
  private dub: Dub | null = null;
  private enabled = false;
  private settings!: Settings;
  private voices: Voice[] = [];
  private message = '';
  private captionsNote = '';
  private signedIn = false;
  private videoId = '';

  async init() {
    this.settings = await loadSettings();
    this.signedIn = !!(await chrome.storage.local.get('token')).token;
    this.button.type = 'button';
    this.button.title = 'Lồng tiếng Việt (Readu Dub)';
    this.button.innerHTML = '<span class="rdub-dot"></span><span>Dub VI</span>';
    this.button.addEventListener('click', e => {
      e.stopPropagation();
      this.panel.classList.toggle('rdub-open');
      if (this.panel.classList.contains('rdub-open')) void this.loadVoices();
      this.render();
    });
    this.panel.addEventListener('click', e => e.stopPropagation());
    this.panel.addEventListener('keydown', e => e.stopPropagation());

    chrome.storage.onChanged.addListener(changes => {
      if (changes.token) {
        this.signedIn = !!changes.token.newValue;
        if (!this.signedIn) this.setEnabled(false);
        else void this.loadVoices();
        this.render();
      }
      if (changes.settings) {
        const prev = this.settings;
        this.settings = { ...this.settings, ...(changes.settings.newValue as Settings) };
        if (this.enabled && prev.voice !== this.settings.voice) void this.restart();
        this.render();
      }
    });
    document.addEventListener('yt-navigate-finish', () => void this.onNavigate());
    setInterval(() => this.mount(), 1000);
    await this.onNavigate();
  }

  private async onNavigate() {
    const id = location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') ?? '' : '';
    if (id === this.videoId) return;
    this.videoId = id;
    this.setEnabled(false);
    this.message = '';
    this.captionsNote = '';
    this.mount();
    this.render();
    if (id && this.settings.autoDub && this.signedIn) this.setEnabled(true);
  }

  /** YouTube rebuilds its controls now and then, so the button and panel are put back when missing. */
  private mount() {
    const controls = document.querySelector('#movie_player .ytp-right-controls');
    if (controls && !this.button.isConnected) controls.prepend(this.button);
    const player = document.querySelector('#movie_player');
    if (player && !this.panel.isConnected) player.append(this.panel, this.overlay);
  }

  private async loadVoices() {
    if (this.voices.length || !this.signedIn) return;
    const res = await send({ type: 'voices' });
    if (res.ok) {
      this.voices = res.data;
      this.render();
    }
  }

  private setEnabled(on: boolean) {
    this.enabled = on;
    this.dub?.stop();
    this.dub = null;
    if (on) void this.startDub();
    this.render();
  }

  private async restart() {
    this.setEnabled(false);
    this.setEnabled(true);
  }

  private async startDub() {
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    if (!this.signedIn) {
      this.enabled = false;
      this.panel.classList.add('rdub-open');
      return this.render();
    }
    if (!video) return;
    this.message = 'Đang đọc phụ đề…';
    this.render();
    const result = await requestCaptions();
    if (!this.enabled) return;
    const segments = result.ok ? toSegments(result.events) : [];
    if (!result.ok || segments.length === 0) {
      this.enabled = false;
      this.message =
        result.ok || result.reason === 'no-captions'
          ? 'Chưa hỗ trợ video không có phụ đề.'
          : 'Không đọc được phụ đề của video này.';
      return this.render();
    }
    this.message = '';
    this.captionsNote = result.auto ? 'Phụ đề tự động' : result.language === 'en' || result.language.startsWith('en-') ? 'Phụ đề tiếng Anh' : `Phụ đề ${result.language} → EN`;
    this.dub = new Dub(video, { id: result.videoId, title: result.title, description: result.description }, segments, this.settings, () => this.renderStatus());
    this.render();
    await this.dub.start();
  }

  private render() {
    this.button.classList.toggle('rdub-on', this.enabled);
    this.panel.replaceChildren(...this.panelContent());
    this.renderStatus();
  }

  /** Updates only the overlay and progress, so a poll does not rebuild the panel under the viewer's cursor. */
  private renderStatus() {
    const overlay = this.enabled ? (this.dub?.overlay ?? 'none') : 'none';
    this.overlay.className = 'rdub-overlay' + (overlay !== 'none' ? ' rdub-show' : '');
    if (overlay !== 'none') {
      const [title, sub] = OVERLAY_TEXT[overlay];
      this.overlay.replaceChildren(
        el('div', 'rdub-overlay-title', title),
        el('div', 'rdub-overlay-sub', overlay === 'error' ? this.dub!.error : sub),
      );
    }
    if (!this.dub) return this.progress.replaceChildren();
    const { done, total } = this.dub.progress;
    const bar = el('div', 'rdub-bar');
    const fill = el('div', 'rdub-bar-fill');
    fill.style.width = `${total ? (100 * done) / total : 0}%`;
    bar.append(fill);
    this.progress.replaceChildren(el('div', 'rdub-progress-text', `Đã lồng tiếng ${done}/${total} câu`), bar);
  }

  private panelContent(): HTMLElement[] {
    const head = el('div', 'rdub-head');
    head.append(el('div', 'rdub-title', 'Readu Dub'));
    const toggle = el('button', 'rdub-switch' + (this.enabled ? ' rdub-on' : ''));
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(this.enabled));
    toggle.setAttribute('aria-label', 'Bật lồng tiếng');
    toggle.addEventListener('click', () => this.setEnabled(!this.enabled));
    const close = el('button', 'rdub-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Đóng');
    close.addEventListener('click', () => this.panel.classList.remove('rdub-open'));
    head.append(toggle, close);

    const lang = el('div', 'rdub-lang');
    lang.append(el('span', 'rdub-chip', 'EN'), el('span', 'rdub-arrow', '→'), el('span', 'rdub-chip rdub-chip-accent', 'VI'));
    if (this.captionsNote) lang.append(el('span', 'rdub-note', this.captionsNote));

    if (!this.signedIn) {
      // Signing in here survives switching tabs to read the mail, which the toolbar popup does not.
      // Only (re)load the step when the form first appears, so a re-render keeps what the viewer typed.
      if (!this.login.el.isConnected) void this.login.show();
      return [head, this.login.el];
    }

    const out: HTMLElement[] = [head, lang];
    if (this.message) out.push(el('div', 'rdub-message', this.message));

    out.push(el('div', 'rdub-label', 'Giọng đọc'));
    const list = el('div', 'rdub-voices');
    if (!this.voices.length) list.append(el('div', 'rdub-muted', this.signedIn ? 'Đang tải giọng đọc…' : 'Đăng nhập để chọn giọng'));
    for (const v of this.voices) {
      const b = el('button', 'rdub-voice' + (v.code === this.settings.voice ? ' rdub-selected' : ''));
      b.type = 'button';
      b.append(el('span', 'rdub-voice-name', v.name), el('span', 'rdub-voice-gender', v.gender === 'male' ? 'Nam' : 'Nữ'));
      b.addEventListener('click', () => void saveSettings({ voice: v.code }));
      list.append(b);
    }
    out.push(list);

    out.push(
      this.slider('Âm lượng gốc', this.settings.originalVolume, v => this.setVolumes({ originalVolume: v })),
      this.slider('Âm lượng lồng tiếng', this.settings.dubVolume, v => this.setVolumes({ dubVolume: v })),
    );

    out.push(this.progress);
    return out;
  }

  private setVolumes(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    this.dub?.setVolumes(this.settings.originalVolume, this.settings.dubVolume);
    void saveSettings(patch);
  }

  private slider(label: string, value: number, onInput: (v: number) => void): HTMLElement {
    const row = el('label', 'rdub-slider');
    const text = el('div', 'rdub-slider-head');
    const val = el('span', 'rdub-slider-value', `${Math.round(value * 100)}%`);
    text.append(el('span', '', label), val);
    const input = el('input');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.value = String(Math.round(value * 100));
    input.addEventListener('input', () => {
      val.textContent = `${input.value}%`;
      onInput(Number(input.value) / 100);
    });
    row.append(text, input);
    return row;
  }
}

void new DubUI().init();
