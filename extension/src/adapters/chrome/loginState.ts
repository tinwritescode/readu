// The sign-in step in chrome.storage, so closing the popup to read the mail loses nothing.
import type { LoginError, PendingLogin } from '../../domain/login';

export interface LoginState {
  pendingLogin?: PendingLogin;
  loginError?: LoginError;
  lastEmail?: string;
}

export async function loadLoginState(): Promise<LoginState> {
  return (await chrome.storage.local.get(['pendingLogin', 'loginError', 'lastEmail'])) as LoginState;
}

export async function clearPendingLogin() {
  await chrome.storage.local.remove('pendingLogin');
}
