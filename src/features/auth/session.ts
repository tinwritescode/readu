import { NativeModules } from 'react-native';

interface NativeSession {
  loadSession(): Promise<string | null>;
  saveSession(token: string): Promise<void>;
  clearSession(): Promise<void>;
}

/** The session token lives in the iOS Keychain, through VttsSpeech.m. */
const keychain = NativeModules.VttsSpeech as NativeSession;

/** The saved session token, or null when nobody is logged in. */
export function loadToken(): Promise<string | null> {
  return keychain.loadSession();
}

export function saveToken(token: string): Promise<void> {
  return keychain.saveSession(token);
}

export function clearToken(): Promise<void> {
  return keychain.clearSession();
}
