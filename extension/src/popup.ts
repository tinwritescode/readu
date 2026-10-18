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
  const usage = h('div', { class: 'usage' });
  if (quota.ok) {
    const { used, limit } = quota.data;
    if (limit < 0) {
      usage.append(h('div', { class: 'row' }, h('strong', {}, 'Video hôm nay'), h('span', {}, `${used} · không giới hạn`)));
    } else {
      const fill = h('div');
      fill.style.width = `${Math.min(100, (100 * used) / Math.max(1, limit))}%`;
      usage.append(
        h('div', { class: 'row' }, h('strong', {}, 'Video hôm nay'), h('span', {}, `${used}/${limit}`)),
        h('div', { class: 'bar' }, fill),
        h('div', { class: 'note' }, 'Mở lại video đã lồng tiếng hôm nay không tính thêm lượt.'),
      );
    }
  }

  const auto = h('input', { type: 'checkbox', checked: settings.autoDub });
  auto.addEventListener('change', () => void saveSettings({ autoDub: auto.checked }));
  const voice = h('select', { class: 'rl-input' });
  for (const v of voices.ok ? voices.data : []) {
    voice.append(h('option', { value: v.code, selected: v.code === settings.voice }, `${v.name} · ${v.gender === 'male' ? 'Nam' : 'Nữ'}`));
  }
  voice.addEventListener('change', () => void saveSettings({ voice: voice.value }));

  const logout = h('button', { type: 'button', class: 'rl-link rl-muted' }, 'Đăng xuất');
  logout.addEventListener('click', () => void send({ type: 'logout' }));

  app.replaceChildren(
    head,
    h('div', { class: 'email' }, account.email),
    usage,
    h('label', { class: 'toggle' }, h('span', {}, 'Tự bật dub khi mở video'), auto),
    h('label', { class: 'rl-label' }, h('span', {}, 'Giọng mặc định'), voice),
    h('p', { class: 'hint' }, 'Mở một video YouTube và bấm nút “Dub VI” trên thanh điều khiển.'),
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
