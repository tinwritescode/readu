// The toolbar popup: sign in with an emailed code, then see the plan, today's quota and the dubbing defaults.
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

function show(...nodes: Node[]) {
  app.replaceChildren(h('h1', {}, 'Readu Dub'), ...nodes);
}

function errorText(status: number, error: string): string {
  if (status === 0) return 'Không kết nối được máy chủ.';
  if (status === 429) return 'Vui lòng đợi một phút rồi gửi lại mã.';
  if (status === 401) return 'Mã không đúng hoặc đã hết hạn.';
  if (status === 400) return 'Email không hợp lệ.';
  return error;
}

function emailStep(prefill = '') {
  const email = h('input', { type: 'email', placeholder: 'ban@example.com', value: prefill, required: true, autocomplete: 'email' });
  const err = h('p', { class: 'error' });
  const submit = h('button', { type: 'submit' }, 'Gửi mã đăng nhập');
  const form = h('form', { class: 'card' }, h('label', {}, 'Email', email), err, submit);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    submit.disabled = true;
    err.textContent = '';
    const res = await send({ type: 'requestCode', email: email.value.trim() });
    submit.disabled = false;
    if (res.ok) codeStep(email.value.trim());
    else err.textContent = errorText(res.status, res.error);
  });
  show(h('p', {}, 'Đăng nhập bằng tài khoản Readu để lồng tiếng Việt cho video YouTube.'), form);
  email.focus();
}

function codeStep(email: string) {
  const code = h('input', {
    type: 'text',
    class: 'code',
    inputMode: 'numeric',
    maxLength: 6,
    autocomplete: 'one-time-code',
    placeholder: '••••••',
  });
  const err = h('p', { class: 'error' });
  const submit = h('button', { type: 'submit' }, 'Đăng nhập');
  const back = h('button', { type: 'button', class: 'ghost' }, 'Đổi email');
  back.addEventListener('click', () => emailStep(email));
  const form = h('form', { class: 'card' }, h('label', {}, 'Mã 6 số', code), err, submit, back);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    submit.disabled = true;
    err.textContent = '';
    const res = await send({ type: 'verifyCode', email, code: code.value.trim() });
    submit.disabled = false;
    if (res.ok) void accountStep(res.data);
    else err.textContent = errorText(res.status, res.error);
  });
  show(h('p', {}, `Đã gửi mã tới ${email}. Mã hết hạn sau 10 phút.`), form);
  code.focus();
}

async function accountStep(account: Account) {
  const [quota, voices, settings] = await Promise.all([send({ type: 'quota' }), send({ type: 'voices' }), loadSettings()]);

  const plan = h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', {}, account.email), h('span', { class: 'plan' }, account.plan)));
  if (quota.ok) {
    const { used, limit } = quota.data;
    if (limit < 0) {
      plan.append(h('p', { class: 'muted' }, `Không giới hạn video · hôm nay đã lồng tiếng ${used} video`));
    } else {
      const fill = h('div');
      fill.style.width = `${Math.min(100, (100 * used) / Math.max(1, limit))}%`;
      plan.append(h('div', { class: 'row muted' }, h('span', {}, 'Video hôm nay'), h('span', {}, `${used}/${limit}`)), h('div', { class: 'bar' }, fill));
    }
  }

  const auto = h('input', { type: 'checkbox', checked: settings.autoDub });
  auto.addEventListener('change', () => void saveSettings({ autoDub: auto.checked }));
  const voice = h('select');
  for (const v of voices.ok ? voices.data : []) {
    voice.append(h('option', { value: v.code, selected: v.code === settings.voice }, `${v.name} · ${v.gender === 'male' ? 'Nam' : 'Nữ'}`));
  }
  voice.addEventListener('change', () => void saveSettings({ voice: voice.value }));
  const prefs = h(
    'div',
    { class: 'card' },
    h('label', { class: 'toggle' }, 'Tự động lồng tiếng khi mở video', auto),
    h('label', {}, 'Giọng mặc định', voice),
  );

  const logout = h('button', { type: 'button', class: 'ghost' }, 'Đăng xuất');
  logout.addEventListener('click', async () => {
    await send({ type: 'logout' });
    emailStep(account.email);
  });

  show(plan, prefs, h('p', { class: 'muted' }, 'Mở một video YouTube và bấm nút “Dub VI” trên thanh điều khiển.'), logout);
}

async function main() {
  show(h('p', {}, 'Đang tải…'));
  const me = await send({ type: 'me' });
  if (me.ok && me.data) void accountStep(me.data);
  else emailStep();
}

void main();
