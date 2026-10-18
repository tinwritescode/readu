// The toolbar popup's two views: sign in with an emailed code, then the plan, today's quota and the dubbing defaults.
import { send } from '../adapters/chrome/messages';
import { loadSettings, saveSettings } from '../adapters/chrome/settings';
import { planName } from '../domain/plans';
import type { Account, Voice } from '../domain/types';
import { VIENEU_VOICES } from '../domain/voices';
import { h } from './dom';
import { LoginForm } from './loginForm';

const brand = () => h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'r'), h('div', { class: 'brand-name' }, 'readu Dub'));

function heading(title: string, text: string): Node[] {
  return [h('div', { class: 'heading' }, h('h2', {}, title), ...(text ? [h('p', { class: 'rl-text' }, text)] : []))];
}

export async function showLogin(app: HTMLElement) {
  const form = new LoginForm((step, title, text) => (step === 'code' ? heading(title, text) : [brand(), ...heading(title, text)]));
  app.replaceChildren(form.el);
  await form.show();
}

export async function showAccount(app: HTMLElement, account: Account) {
  const [quota, voices, settings] = await Promise.all([send({ type: 'quota' }), send({ type: 'voices' }), loadSettings()]);

  const head = h('div', { class: 'row' }, brand(), h('span', { class: 'plan' }, planName(account.plan)));

  const usage = h('section', { class: 'rd-card' });
  if (quota.ok) {
    const { usedSeconds, limitSeconds } = quota.data;
    const used = Math.floor(usedSeconds / 60);
    if (limitSeconds < 0) {
      usage.append(h('div', { class: 'rd-muted' }, 'Hôm nay'), h('div', { class: 'stat' }, `${used} phút`), h('div', { class: 'rd-muted rd-small' }, 'Không giới hạn phút nghe.'));
    } else {
      const fill = h('div');
      fill.style.width = `${Math.min(100, (100 * usedSeconds) / Math.max(1, limitSeconds))}%`;
      usage.append(
        h('div', { class: 'row' }, h('span', { class: 'rd-muted' }, 'Hôm nay'), h('span', { class: 'rd-muted' }, `còn ${Math.max(0, Math.round(limitSeconds / 60) - used)} phút`)),
        h('div', { class: 'stat' }, `${used}/${Math.round(limitSeconds / 60)} phút`),
        h('div', { class: 'rd-bar' }, fill),
        h('div', { class: 'rd-muted rd-small' }, 'Chỉ tính phần đã phát. Nghe lại trong ngày không tính.'),
      );
    }
  }

  const auto = h('button', { type: 'button', class: 'rd-switch', ariaLabel: 'Tự bật khi mở video' });
  auto.setAttribute('role', 'switch');
  auto.setAttribute('aria-checked', String(settings.autoDub));
  auto.addEventListener('click', () => {
    const on = auto.getAttribute('aria-checked') !== 'true';
    auto.setAttribute('aria-checked', String(on));
    void saveSettings({ autoDub: on });
  });
  const voice = h('select', { class: 'rd-field' });
  const option = (v: Voice) => h('option', { value: v.code, selected: v.code === settings.voice }, `${v.name} · ${v.gender === 'male' ? 'Nam' : 'Nữ'}`);
  voice.append(
    h('optgroup', { label: 'Kokoro' }, ...(voices.ok ? voices.data : []).map(option)),
    h('optgroup', { label: 'VieNeu · chỉ đọc trên máy này' }, ...VIENEU_VOICES.map(option)),
  );
  voice.addEventListener('change', () => void saveSettings({ voice: voice.value }));
  const prefs = h(
    'section',
    { class: 'rd-card' },
    h('div', { class: 'row setting' }, h('span', {}, 'Tự bật khi mở video'), auto),
    h('label', { class: 'rd-label' }, h('span', {}, 'Giọng đọc'), voice),
  );

  const logout = h('button', { type: 'button', class: 'rd-link rd-danger' }, 'Đăng xuất');
  logout.addEventListener('click', () => void send({ type: 'logout' }));

  app.replaceChildren(
    head,
    h('div', { class: 'email' }, account.email),
    usage,
    prefs,
    h('p', { class: 'rd-muted rd-small hint' }, 'Mở video YouTube rồi bấm “Dub VI” trên thanh điều khiển.'),
    logout,
  );
}
