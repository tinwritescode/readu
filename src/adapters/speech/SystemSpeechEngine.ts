import { NativeEventEmitter, NativeModules } from 'react-native';
import type { Voice } from '../../domain/types';
import type {
  SpeakOptions,
  SpeechCallbacks,
  SpeechEngine,
  SpeechSession,
} from './SpeechEngine';

interface NativeVttsSpeech {
  getVoices(): Promise<Voice[]>;
  speak(
    text: string,
    options: { voiceId?: string; rate: number },
  ): Promise<string>;
  pause(): void;
  resume(): void;
  stop(): void;
}

interface NativeSpeechEvent {
  utteranceId: string;
  location?: number;
  length?: number;
}

type SpeechEventName = 'onStart' | 'onRange' | 'onFinish' | 'onCancel';
const SPEECH_EVENTS: SpeechEventName[] = ['onStart', 'onRange', 'onFinish', 'onCancel'];

const native = NativeModules.VttsSpeech as NativeVttsSpeech | undefined;

/** AVSpeechUtterance rate is 0...1 with 0.5 as the normal pace. */
const NORMAL_RATE = 0.5;

export function speedToNativeRate(speed: number): number {
  const rate =
    speed <= 1
      ? NORMAL_RATE * speed
      : NORMAL_RATE + (speed - 1) * ((1 - NORMAL_RATE) / 2);
  return Math.min(1, Math.max(0, rate));
}

/** Offline speech through the voices installed in iOS (Settings > Accessibility > Spoken Content). */
export class SystemSpeechEngine implements SpeechEngine {
  readonly id = 'ios-system';
  private readonly emitter: NativeEventEmitter<
    Record<SpeechEventName, [NativeSpeechEvent]>
  >;

  constructor(private readonly module: NativeVttsSpeech) {
    this.emitter = new NativeEventEmitter(module as never);
  }

  listVoices(): Promise<Voice[]> {
    return this.module.getVoices();
  }

  async speak(
    text: string,
    options: SpeakOptions,
    callbacks: SpeechCallbacks,
  ): Promise<SpeechSession> {
    this.module.stop();

    let utteranceId: string | null = null;
    const pending: Array<[SpeechEventName, NativeSpeechEvent]> = [];
    const dispatch = (name: SpeechEventName, event: NativeSpeechEvent) => {
      if (event.utteranceId !== utteranceId) return;
      switch (name) {
        case 'onStart':
          callbacks.onStart?.();
          break;
        case 'onRange': {
          const start = event.location ?? 0;
          callbacks.onRange?.({ start, end: start + (event.length ?? 0) });
          break;
        }
        case 'onFinish':
          cleanup();
          callbacks.onFinish?.();
          break;
        case 'onCancel':
          cleanup();
          callbacks.onCancel?.();
          break;
      }
    };
    const subscriptions = SPEECH_EVENTS.map(
      name =>
        this.emitter.addListener(name, (event: NativeSpeechEvent) => {
          if (utteranceId === null) pending.push([name, event]);
          else dispatch(name, event);
        }),
    );
    const cleanup = () => subscriptions.forEach(s => s.remove());

    try {
      utteranceId = await this.module.speak(text, {
        voiceId: options.voiceId,
        rate: speedToNativeRate(options.speed),
      });
    } catch (error) {
      cleanup();
      throw error;
    }
    // Events can arrive before the speak() promise resolves.
    pending.forEach(([name, event]) => dispatch(name, event));

    return {
      pause: () => this.module.pause(),
      resume: () => this.module.resume(),
      stop: () => this.module.stop(),
    };
  }
}

export function createSystemSpeechEngine(): SpeechEngine {
  if (!native) {
    throw new Error('VttsSpeech native module is not linked');
  }
  return new SystemSpeechEngine(native);
}
