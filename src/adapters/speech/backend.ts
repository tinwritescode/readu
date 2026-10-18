import type { Voice } from '../../domain/types';

/** The vtts-backend service that holds the Vbee and Resend keys. */
export const BACKEND_URL = 'https://vtts-backend.fly.dev';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request(path: string, init: RequestInit & { token?: string; json?: unknown }): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.json !== undefined) headers['Content-Type'] = 'application/json';
  if (init.token) headers.Authorization = `Bearer ${init.token}`;

  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  }
  return res;
}

export async function requestLoginCode(email: string): Promise<void> {
  await request('/v1/auth/code', { method: 'POST', json: { email } });
}

/** Trades the emailed code for a session token. */
export async function verifyLoginCode(email: string, code: string): Promise<string> {
  const res = await request('/v1/auth/session', { method: 'POST', json: { email, code } });
  const body = (await res.json()) as { token: string };
  return body.token;
}

export async function logout(token: string): Promise<void> {
  await request('/v1/auth/session', { method: 'DELETE', token }).catch(() => undefined);
}

export async function fetchVoices(token: string): Promise<Voice[]> {
  const res = await request('/v1/voices', { method: 'GET', token });
  const body = (await res.json()) as { voices: Array<{ code: string; name: string; gender: string }> };
  return body.voices.map(v => ({ id: v.code, name: v.name, gender: v.gender }));
}

/** MP3 audio for `text`, base64-encoded so it can be written straight to a file. */
export async function synthesize(
  token: string,
  text: string,
  voiceId: string,
  speed: number,
): Promise<ArrayBuffer> {
  const res = await request('/v1/speech', {
    method: 'POST',
    token,
    json: { text, voice: voiceId, speed },
  });
  return res.arrayBuffer();
}
