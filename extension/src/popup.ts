// The toolbar popup: sign in with an emailed code, then see the plan, today's quota and the dubbing defaults.
import { LoginForm } from './login';
import { loadSettings, saveSettings, send, type Account } from './types';

const app = document.getElementById('app')!;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...children);
  return e;
}

const brand = () => h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'r'), h('div', { class: 'brand-name' }, 'readu Dub'));

function heading(title: string, text: string): Node[] {
  return [h('div', { class: 'heading' }, h('h2', {}, title), ...(text ? [h('p', { class: 'rl-text' }, text)] : []))];
}

async function showLogin() {
  const form = new LoginForm((step, title, text) => (step === 'code' ? heading(title, text) : [brand(), ...heading(title, text)]));
  app.replaceChildren(form.el);
  await form.show();
}

async function showAccount(account: Account) {
  const [quota, voices, settings] = await Promise.all([send({ type: 'quota' }), send({ type: 'voices' }), loadSettings()]);

  const head = h('div', { class: 'row' }, brand(), h('span', { class: 'plan' }, account.plan === 'free' ? 'Free' : account.plan));

  const usage = h('section', { class: 'rd-card' });
  if (quota.ok) {
    const { usedSeconds, limitSeconds } = quota.data;
    const used = Math.floor(usedSeconds / 60);
    if (limitSeconds < 0) {
      usage.append(h('div', { class: 'rd-muted' }, 'Hôm nay'), h('div', { class: 'stat' }, `${used} phút`), h('div', { class: 'rd-muted rd-small' }, 'Gói của bạn không giới hạn.'));
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
  for (const v of voices.ok ? voices.data : []) {
    voice.append(h('option', { value: v.code, selected: v.code === settings.voice }, `${v.name} · ${v.gender === 'male' ? 'Nam' : 'Nữ'}`));
  }
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

async function refresh() {
  const me = await send({ type: 'me' });
  if (me.ok && me.data) await showAccount(me.data);
  else await showLogin();
}

// Signing in or out, here or from the panel on YouTube, switches the view.
chrome.storage.onChanged.addListener(changes => {
  if (changes.token) void refresh();
});

void refresh();
