import { useState, type FormEvent } from 'react';
import { ApiError, requestLoginCode, verifyLoginCode } from '@shared/adapters/speech/backend';

/** Email, then the code the server emails: the same two steps as the mobile login. */
export function LoginScreen({ onLoggedIn }: { onLoggedIn: (token: string) => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (sentTo) onLoggedIn(await verifyLoginCode(sentTo, code.trim()));
      else {
        await requestLoginCode(email.trim());
        setSentTo(email.trim());
      }
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <h1 className="brand">Readu</h1>
        <p className="muted">{sentTo ? `Enter the code we sent to ${sentTo}.` : 'Log in with your email. We will send you a code.'}</p>
        {sentTo ? (
          <input
            className="field"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="Code"
            value={code}
            onChange={e => setCode(e.target.value)}
            autoFocus
            required
          />
        ) : (
          <input
            className="field"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            autoFocus
            required
          />
        )}
        {error ? <p className="error">{error}</p> : null}
        <button className="button primary" disabled={busy}>
          {busy ? '…' : sentTo ? 'Log in' : 'Send code'}
        </button>
        {sentTo ? (
          <button
            type="button"
            className="link"
            onClick={() => {
              setSentTo(null);
              setCode('');
              setError(null);
            }}>
            Use another email
          </button>
        ) : null}
      </form>
    </main>
  );
}
