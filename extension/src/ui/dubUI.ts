// The "Dub VI" button, panel and overlay on the watch page, and the dub they control.
import { requestCaptions } from '../adapters/youtube/bridge';
import { send } from '../adapters/chrome/messages';
import { loadSettings, saveSettings } from '../adapters/chrome/settings';
import { Dub, type Overlay } from '../app/dubSession';
import { ServerDubSource } from '../app/dubSource';
import { LocalDubSource } from '../app/localDubSource';
import { englishToVietnamese } from '../adapters/translate/chromeTranslator';
import { chooseEngine, type Engine } from '../domain/speechEngine';
import { KOKORO_VOICES, modelOf, VIENEU_VOICES } from '../domain/voices';
import { toSegments } from '../domain/captions';
import { isMusicVideo } from '../domain/music';
import type { InstallProgress, LocalEngine, LocalModel, ReadOn, Settings, Voice } from '../domain/types';
import { el } from './dom';
import { LoginForm } from './loginForm';

const OVERLAY_TEXT: Record<Exclude<Overlay, 'none'>, [string, string]> = {
  waiting: ['Đang tạo lồng tiếng…', 'Video sẽ tự phát khi đủ tiếng'],
  'not-ready': ['Đang xem không lồng tiếng', 'Sẽ lồng tiếng lại khi kịp'],
  quota: ['Đã hết phút lồng tiếng hôm nay', 'Gói Free giới hạn số phút mỗi ngày'],
  error: ['Không lồng tiếng được', ''],
};

/** The button, panel and overlay on the watch page, and the dub they control. */
export class DubUI {
  private button = el('button', 'ytp-button rdub-button readu-ui');
  private panel = el('div', 'rdub-panel readu-ui');
  private overlay = el('div', 'rdub-overlay readu-ui');
  private progress = el('section', 'rd-card rdub-progress');
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
  /** This video looked like music, so dubbing was turned off. */
  private isMusic = false;
  /** The viewer chose to dub this music video anyway. */
  private musicOverride = false;
  /** Reading on this computer with the chosen voice's model: downloaded or not, and how fast; null until asked. */
  private local: LocalEngine | null = null;
  private install: InstallProgress | null = null;
  private installing = false;

  async init() {
    this.settings = await loadSettings();
    this.signedIn = !!(await chrome.storage.local.get('token')).token;
    this.install = ((await chrome.storage.local.get('localInstall')) as { localInstall?: InstallProgress }).localInstall ?? null;
    void this.loadLocal();
    this.button.type = 'button';
    this.button.title = 'Lồng tiếng Việt';
    this.button.setAttribute('aria-label', 'Lồng tiếng Việt');
    const pill = el('span', 'rdub-pill');
    pill.append(el('span', 'rdub-dot'), el('span', '', 'Dub VI'));
    this.button.append(pill);
    this.button.addEventListener('click', e => {
      e.stopPropagation();
      this.panel.classList.toggle('rdub-open');
      if (this.panel.classList.contains('rdub-open')) void this.loadVoices();
      this.render();
    });
    this.panel.addEventListener('click', e => e.stopPropagation());
    this.panel.addEventListener('keydown', e => e.stopPropagation());

    chrome.storage.onChanged.addListener(changes => {
      if (changes.localInstall) {
        this.install = (changes.localInstall.newValue as InstallProgress | undefined) ?? null;
        this.render();
      }
      if (changes.token) {
        this.signedIn = !!changes.token.newValue;
        if (!this.signedIn) this.setEnabled(false);
        else void this.loadVoices();
        this.render();
      }
      if (changes.settings) {
        const prev = this.settings;
        this.settings = { ...this.settings, ...(changes.settings.newValue as Settings) };
        // Kokoro and VieNeu are downloaded and measured separately.
        if (modelOf(prev.voice) !== this.model()) {
          this.local = null;
          void this.loadLocal();
        }
        if (this.enabled && (prev.voice !== this.settings.voice || prev.readOn !== this.settings.readOn)) this.restart();
        // On or off chosen in the popup applies to this video too.
        if (prev.autoDub !== this.settings.autoDub && this.settings.autoDub !== this.enabled && this.videoId) {
          this.setEnabled(this.settings.autoDub);
        }
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
    this.isMusic = false;
    this.musicOverride = false;
    this.mount();
    this.render();
    // The last on/off choice carries over to the next video.
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
    if (this.voices.length) return;
    // The server and this computer have the same voices; the server's list is used when signed in.
    const res = this.signedIn ? await send({ type: 'voices' }) : null;
    this.voices = res?.ok ? res.data : KOKORO_VOICES;
    this.render();
  }

  private async loadLocal() {
    const res = await send({ type: 'localEngine', model: this.model() });
    if (res.ok) this.local = res.data;
    this.render();
  }

  /** The model that reads the chosen voice on this computer. */
  private model(): LocalModel {
    return modelOf(this.settings.voice);
  }

  /** Where this dub would be made with the current setting. */
  private engine(): Engine {
    return chooseEngine(this.settings.readOn, this.local ?? { installed: false, downloadBytes: 0 }, navigator.onLine, this.model());
  }

  /** Downloads the voice, then measures how fast this computer reads with it. */
  private async installLocal() {
    this.installing = true;
    this.render();
    const res = await send({ type: 'localInstall', model: this.model() });
    if (res.ok) {
      this.message = 'Đang đo tốc độ máy…';
      this.render();
      const bench = await send({ type: 'localBenchmark', voice: this.settings.voice });
      this.message = bench.ok ? '' : `Không đọc thử được: ${bench.error}`;
    }
    this.installing = false;
    await this.loadLocal();
  }

  private setEnabled(on: boolean) {
    this.enabled = on;
    this.dub?.stop();
    this.dub = null;
    if (on) void this.startDub();
    this.render();
  }

  /** The viewer turned dubbing on or off: remember it for the next videos. */
  private choose(on: boolean) {
    if (on && this.isMusic) this.musicOverride = true;
    // Chrome's translator may need its Vietnamese pack downloaded, which only a click can start.
    if (on && this.engine() === 'device') void englishToVietnamese().catch(() => undefined);
    this.setEnabled(on);
    void saveSettings({ autoDub: on });
  }

  private restart() {
    this.setEnabled(false);
    this.setEnabled(true);
  }

  private async startDub() {
    const video = document.querySelector<HTMLVideoElement>('#movie_player video');
    if (!this.local) await this.loadLocal();
    const engine = this.engine();
    // The server needs an account; this computer needs the voice downloaded. Either way the panel shows how.
    if ((engine === 'server' && !this.signedIn) || (engine === 'device' && !this.local?.installed)) {
      this.enabled = false;
      this.panel.classList.add('rdub-open');
      return this.render();
    }
    if (!video) return;
    // The video waits for the dub from the start, so the first words are not said before the dub has them.
    const playing = !video.paused;
    if (playing) video.pause();
    const giveBack = () => {
      if (playing && video.paused) void video.play();
    };
    this.message = 'Đang đọc phụ đề…';
    this.render();
    const result = await requestCaptions();
    if (!this.enabled) return giveBack();
    const segments = result.ok ? toSegments(result.events) : [];
    if (!result.ok || segments.length === 0) {
      giveBack();
      this.enabled = false;
      this.message =
        result.ok || result.reason === 'no-captions' ? 'Video này chưa có phụ đề nên chưa lồng tiếng được.' : 'Không đọc được phụ đề của video này.';
      return this.render();
    }
    // Songs are left alone without a fuss: dubbing stays off and the panel says why in one line.
    if (!this.musicOverride && isMusicVideo({ category: result.category, durationSec: result.durationSec, events: result.events, segments })) {
      giveBack();
      this.enabled = false;
      this.isMusic = true;
      this.message = '';
      return this.render();
    }
    this.message = '';
    this.captionsNote = result.auto ? 'Phụ đề tự động' : result.language === 'en' || result.language.startsWith('en-') ? 'Phụ đề tiếng Anh' : `Phụ đề ${result.language}`;
    const source =
      engine === 'device'
        ? new LocalDubSource(segments, this.settings.voice)
        : new ServerDubSource({ id: result.videoId, title: result.title, description: result.description }, segments, this.settings.voice);
    this.dub = new Dub(video, source, segments, this.settings, () => this.renderStatus(), playing);
    this.render();
    await this.dub.start();
  }

  private render() {
    this.button.classList.toggle('rdub-on', this.enabled);
    this.button.classList.toggle('rdub-music', this.isMusic && !this.enabled);
    this.button.title = this.isMusic && !this.enabled ? 'Video nhạc: không lồng tiếng' : 'Lồng tiếng Việt';
    this.panel.replaceChildren(...this.panelContent());
    this.renderStatus();
  }

  /** Updates only the overlay and progress, so a poll does not rebuild the panel under the viewer's cursor. */
  private renderStatus() {
    const overlay = this.enabled ? (this.dub?.overlay ?? 'none') : 'none';
    this.overlay.classList.toggle('rdub-show', overlay !== 'none');
    if (overlay !== 'none') {
      this.renderOverlay(overlay);
    }
    if (!this.dub) return this.progress.replaceChildren();
    const { done, total } = this.dub.progress;
    const bar = el('div', 'rd-bar');
    const fill = el('div');
    fill.style.width = `${total ? (100 * done) / total : 0}%`;
    bar.append(fill);
    const row = el('div', 'rdub-row');
    row.append(el('span', 'rd-muted', 'Đã lồng tiếng'), el('span', 'rdub-count', `${done}/${total} câu`));
    this.progress.replaceChildren(row, bar);
  }

  private panelContent(): HTMLElement[] {
    const head = el('div', 'rdub-head');
    head.append(el('div', 'rdub-title', 'Lồng tiếng'));
    const engine = this.engine();
    const canDub = engine === 'device' ? !!this.local?.installed : this.signedIn;
    if (canDub) {
      const toggle = el('button', 'rd-switch');
      toggle.type = 'button';
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', String(this.enabled));
      toggle.setAttribute('aria-label', 'Bật lồng tiếng');
      toggle.addEventListener('click', () => this.choose(!this.enabled));
      head.append(toggle);
    }
    const close = el('button', 'rd-icon-btn rd-plain');
    close.type = 'button';
    close.setAttribute('aria-label', 'Đóng');
    close.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    close.addEventListener('click', () => this.panel.classList.remove('rdub-open'));
    head.append(close);

    const out: HTMLElement[] = [head, this.readOnSection(engine)];
    if (engine === 'server' && !this.signedIn) {
      // Signing in here survives switching tabs to read the mail, which the toolbar popup does not.
      // Only (re)load the step when the form first appears, so a re-render keeps what the viewer typed.
      if (!this.login.el.isConnected) void this.login.show();
      return [...out, this.login.el];
    }

    out.push(el('div', 'rd-muted rd-small rdub-sub', ['Tiếng Anh → Tiếng Việt', this.captionsNote].filter(Boolean).join(' · ')));
    if (this.isMusic && !this.enabled) {
      const note = el('div', 'rd-tile rdub-note');
      const anyway = el('button', 'rd-link', 'Vẫn lồng tiếng');
      anyway.type = 'button';
      anyway.addEventListener('click', () => this.choose(true));
      note.append(el('span', 'rd-muted', 'Video nhạc nên không lồng tiếng.'), anyway);
      out.push(note);
    } else if (this.message) {
      out.push(el('div', 'rd-tile rd-muted', this.message));
    }

    out.push(el('div', 'rdub-label', 'Giọng Kokoro'));
    const kokoro = this.voiceChips(this.voices);
    if (!this.voices.length) kokoro.append(el('span', 'rd-muted rd-small', 'Đang tải giọng đọc…'));
    out.push(kokoro, el('div', 'rdub-label', 'Giọng VieNeu · chỉ đọc trên máy này'), this.voiceChips(VIENEU_VOICES));

    const volumes = el('section', 'rd-card');
    volumes.append(
      this.slider('Âm gốc', this.settings.originalVolume, v => this.setVolumes({ originalVolume: v })),
      this.slider('Giọng Việt', this.settings.dubVolume, v => this.setVolumes({ dubVolume: v })),
    );
    out.push(volumes, this.progress);
    return out;
  }

  private voiceChips(voices: Voice[]): HTMLElement {
    const list = el('div', 'rd-chips');
    for (const v of voices) {
      const b = el('button', 'rd-chip' + (v.code === this.settings.voice ? ' rd-active' : ''), v.name);
      b.type = 'button';
      b.title = v.gender === 'male' ? 'Giọng nam' : 'Giọng nữ';
      b.addEventListener('click', () => void saveSettings({ voice: v.code }));
      list.append(b);
    }
    return list;
  }

  /** Where the dub is made, and downloading the voice to read on this computer. */
  private readOnSection(engine: Engine): HTMLElement {
    const box = el('section', 'rd-card rdub-readon');
    const choices: Array<[ReadOn, string]> = [
      ['auto', 'Tự động'],
      ['device', 'Máy này'],
      ['server', 'Máy chủ'],
    ];
    const row = el('div', 'rdub-segmented');
    for (const [value, label] of choices) {
      const b = el('button', 'rd-chip' + (this.settings.readOn === value ? ' rd-active' : ''), label);
      b.type = 'button';
      b.addEventListener('click', () => void saveSettings({ readOn: value }));
      row.append(b);
    }
    const local = this.local;
    let note: string;
    if (this.model() === 'vieneu') {
      const speed = local?.realtime ? ` · nhanh ${local.realtime.toFixed(1)}×` : '';
      note = `Giọng VieNeu chỉ đọc trên máy này, không cần mạng${speed}`;
    } else if (engine === 'device') {
      const speed = local?.realtime ? ` · nhanh ${local.realtime.toFixed(1)}× (${local.backend === 'webgpu' ? 'GPU' : 'CPU'})` : '';
      note = `Đọc trên máy này, không cần mạng${speed}`;
    } else if (this.settings.readOn === 'auto' && local?.installed && local.realtime !== undefined) {
      note = `Máy này đọc chậm (${local.realtime.toFixed(1)}×) nên dùng máy chủ`;
    } else {
      note = 'Dịch và đọc trên máy chủ Readu (cần đăng nhập)';
    }
    box.append(el('div', 'rdub-label', 'Đọc ở đâu'), row, el('div', 'rd-muted rd-small', note));

    if (local && !local.installed) {
      const p = this.install?.model === this.model() ? this.install : null;
      if (this.installing || (p && !p.error && p.done < p.total)) {
        const pct = p ? Math.floor((100 * p.done) / p.total) : 0;
        const bar = el('div', 'rd-bar');
        const fill = el('div');
        fill.style.width = `${pct}%`;
        bar.append(fill);
        box.append(el('div', 'rd-muted rd-small', `Đang tải giọng đọc… ${pct}%`), bar);
      } else {
        const mb = Math.round(local.downloadBytes / 1e6);
        const name = this.model() === 'vieneu' ? 'VieNeu' : 'Kokoro';
        const get = el('button', 'rd-btn rd-btn-outline rd-btn-block', `Tải giọng ${name} về máy (${mb} MB)`);
        get.type = 'button';
        get.addEventListener('click', () => void this.installLocal());
        box.append(get);
        if (p?.error) box.append(el('p', 'rd-error', `Tải không xong: ${p.error}`));
      }
    }
    return box;
  }

  private renderOverlay(overlay: Exclude<Overlay, 'none'>) {
    const dub = this.dub!;
    let [title, sub] = OVERLAY_TEXT[overlay];
    if (overlay === 'error') sub = dub.error;
    if (overlay !== 'waiting') {
      this.overlay.replaceChildren(el('div', 'rdub-overlay-title', title), el('div', 'rdub-overlay-sub', sub));
      return;
    }
    if (dub.coldStart) sub = 'Đang khởi động giọng đọc, lần đầu mất khoảng 30 giây';
    if (dub.note) sub = dub.note;
    const pct = Math.round(dub.waitProgress * 100);
    const bar = el('div', 'rd-bar');
    const fill = el('div');
    fill.style.width = `${pct}%`;
    bar.append(fill);
    const now = el('button', 'rd-link rdub-watch-now', 'Xem luôn');
    now.type = 'button';
    now.addEventListener('click', e => {
      e.stopPropagation();
      dub.watchNow();
      this.renderStatus();
    });
    this.overlay.replaceChildren(el('div', 'rdub-overlay-title', `${title} ${pct}%`), el('div', 'rdub-overlay-sub', sub), bar, now);
  }

  private setVolumes(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    this.dub?.setVolumes(this.settings.originalVolume, this.settings.dubVolume);
    void saveSettings(patch);
  }

  private slider(label: string, value: number, onInput: (v: number) => void): HTMLElement {
    const row = el('label', 'rdub-slider');
    const text = el('div', 'rdub-row');
    const val = el('span', 'rd-muted', `${Math.round(value * 100)}%`);
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
