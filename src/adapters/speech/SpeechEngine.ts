import type { TextRange, Voice } from '../../domain/types';

export interface SpeakOptions {
  voiceId?: string;
  /** Playback speed multiplier, 1 = the voice's normal pace. */
  speed: number;
}

export interface SpeechCallbacks {
  onStart?: () => void;
  /** Range of `text` (as passed to speak) about to be spoken. */
  onRange?: (range: TextRange) => void;
  onFinish?: () => void;
  onCancel?: () => void;
}

export interface SpeechSession {
  pause(): void;
  resume(): void;
  stop(): void;
}

/**
 * Swappable text-to-speech backend. The app talks only to this interface so
 * iOS system voices, voices bundled with the app, or a LAN server can be
 * selected without touching the reader UI.
 */
export interface SpeechEngine {
  readonly id: string;
  listVoices(): Promise<Voice[]>;
  speak(
    text: string,
    options: SpeakOptions,
    callbacks: SpeechCallbacks,
  ): Promise<SpeechSession>;
}
