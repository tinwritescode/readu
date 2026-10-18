// Sign-in with an emailed 6-digit code, shared by the toolbar popup and the panel on YouTube.
// The step the viewer is on lives in chrome.storage, so closing the popup to read the mail loses nothing.
import { CODE_LENGTH, CODE_TTL_MS, RESEND_COOLDOWN_MS, loginErrorText, type PendingLogin } from '../domain/login';
import { clearPendingLogin, loadLoginState } from '../adapters/chrome/loginState';
import { send } from '../adapters/chrome/messages';
import { h } from './dom';

const backIcon = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M15 6l-6 6 6 6');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  svg.append(path);
  return svg;
};

/**
 * The sign-in form. It opens on the step stored in chrome.storage: the code step while a code sent in the last
 * 10 minutes is waiting, else the email step with the last email filled in.
 */
export class LoginForm {
  readonly el = h('div', { class: 'rl' });
  private timer = 0;

  /** heading builds the title block of a step; text may be empty. */
  constructor(private heading: (step: 'email' | 'code', title: string, text: string) => Node[]) {}

  async show() {
    const { pendingLogin, loginError, lastEmail } = await loadLoginState();
    if (pendingLogin && Date.now() - pendingLogin.sentAt < CODE_TTL_MS) return this.codeStep(pendingLogin);
    const recentError = loginError && Date.now() - loginError.at < CODE_TTL_MS ? loginError : undefined;
    this.emailStep(recentError?.email ?? lastEmail ?? '', recentError?.message ?? '');
  }

  private render(...nodes: Node[]) {
    clearInterval(this.timer);
    this.el.replaceChildren(...nodes);
  }

  private emailStep(prefill: string, error = '') {
    const email = h('input', { type: 'email', class: 'rd-field', value: prefill, required: true, autocomplete: 'email', placeholder: 'ban@email.com' });
    const err = h('p', { class: 'rd-error', role: 'alert' }, error);
    const submit = h('button', { type: 'submit', class: 'rd-btn rd-btn-block' }, 'Gửi mã');
    const form = h('form', { class: 'rl-form' }, h('label', { class: 'rd-label' }, h('span', {}, 'Email'), email), err, submit);
    form.addEventListener('submit', e => {
      e.preventDefault();
      const value = email.value.trim();
      // Move on at once; the service worker records the step and any failure even if this popup closes.
      this.codeStep({ email: value, sentAt: Date.now() }, true);
    });
    this.render(...this.heading('email', 'Đăng nhập', 'Dùng tài khoản readu để nghe video YouTube bằng tiếng Việt.'), form, h('p', { class: 'rl-foot' }, 'Mã 6 số, dùng được trong 10 phút.'));
    email.focus();
  }

  private async requestCode(email: string): Promise<boolean> {
    const res = await send({ type: 'requestCode', email });
    if (res.ok) return true;
    this.emailStep(email, loginErrorText(res.status, res.error));
    return false;
  }

  private codeStep(pending: PendingLogin, sendNow = false) {
    const back = h('button', { type: 'button', class: 'rd-icon-btn rd-plain rl-back', ariaLabel: 'Đổi email' }, backIcon());
    back.addEventListener('click', async () => {
      await clearPendingLogin();
      this.emailStep(pending.email);
    });
    const status = h('p', { class: 'rl-text' }, sendNow ? `Đang gửi mã tới ${pending.email}…` : `Đã gửi mã tới ${pending.email}.`);

    const boxes = Array.from({ length: CODE_LENGTH }, (_, i) =>
      h('input', {
        type: 'text',
        class: 'rl-digit',
        inputMode: 'numeric',
        maxLength: 1,
        placeholder: ' ', // lets CSS tell filled boxes from empty ones
        autocomplete: i === 0 ? 'one-time-code' : 'off',
        ariaLabel: `Số thứ ${i + 1}`,
      }),
    );
    const err = h('p', { class: 'rd-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'rd-btn rd-btn-block' }, 'Xác nhận');
    const resend = h('button', { type: 'button', class: 'rd-link' });
    const changeEmail = h('button', { type: 'button', class: 'rd-link rd-muted' }, 'Đổi email');
    changeEmail.addEventListener('click', () => back.click());

    const code = () => boxes.map(b => b.value).join('');
    const fill = (digits: string, from: number) => {
      for (let i = 0; i < digits.length && from + i < CODE_LENGTH; i++) boxes[from + i].value = digits[i];
      boxes[Math.min(CODE_LENGTH - 1, from + digits.length)].focus();
      if (code().length === CODE_LENGTH) form.requestSubmit();
    };
    boxes.forEach((box, i) => {
      box.addEventListener('input', () => {
        const digits = box.value.replace(/\D/g, '');
        box.value = '';
        if (digits) fill(digits, i);
      });
      box.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && !box.value && i > 0) {
          boxes[i - 1].value = '';
          boxes[i - 1].focus();
          e.preventDefault();
        } else if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
        else if (e.key === 'ArrowRight' && i < CODE_LENGTH - 1) boxes[i + 1].focus();
      });
      box.addEventListener('paste', e => {
        e.preventDefault();
        fill((e.clipboardData?.getData('text') ?? '').replace(/\D/g, ''), i);
      });
    });

    let verifying = false;
    const form = h('form', { class: 'rl-form' }, h('div', { class: 'rl-digits' }, ...boxes), err, submit);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (verifying || code().length !== CODE_LENGTH) return;
      verifying = true;
      submit.disabled = true;
      err.textContent = '';
      const res = await send({ type: 'verifyCode', email: pending.email, code: code() });
      verifying = false;
      submit.disabled = false;
      if (res.ok) return; // the token lands in storage and the owner of this form shows the account
      err.textContent = loginErrorText(res.status, res.error);
      boxes.forEach(b => (b.value = ''));
      boxes[0].focus();
    });

    let sentAt = pending.sentAt;
    const tick = () => {
      const wait = Math.ceil((sentAt + RESEND_COOLDOWN_MS - Date.now()) / 1000);
      resend.disabled = wait > 0;
      resend.textContent = wait > 0 ? `Gửi lại mã sau ${wait} giây` : 'Gửi lại mã';
    };
    resend.addEventListener('click', async () => {
      sentAt = Date.now();
      tick();
      status.textContent = `Đang gửi mã tới ${pending.email}…`;
      if (await this.requestCode(pending.email)) status.textContent = `Đã gửi lại mã tới ${pending.email}.`;
    });

    this.render(back, ...this.heading('code', 'Kiểm tra email', ''), status, form, h('div', { class: 'rl-links' }, resend, changeEmail));
    tick();
    this.timer = window.setInterval(tick, 1000);
    boxes[0].focus();

    if (sendNow) {
      void this.requestCode(pending.email).then(ok => {
        if (ok && status.isConnected) status.textContent = `Đã gửi mã tới ${pending.email}.`;
      });
    }
  }
}
