// The Readu API, called from the service worker with the session token from chrome.storage.

const API_BASE = 'https://api.readu.tyvn.online';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function token(): Promise<string | undefined> {
  const { token } = await chrome.storage.local.get('token');
  return token as string | undefined;
}

export async function api(path: string, init: { method?: string; json?: unknown; auth?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.json !== undefined) headers['Content-Type'] = 'application/json';
  if (init.auth !== false) {
    const t = await token();
    if (!t) throw new ApiError(401, 'not signed in');
    headers.Authorization = `Bearer ${t}`;
  }
  const res = await fetch(API_BASE + path, {
    method: init.method ?? 'GET',
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (res.status === 401 && init.auth !== false) await chrome.storage.local.remove(['token', 'account']);
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  }
  return res;
}
