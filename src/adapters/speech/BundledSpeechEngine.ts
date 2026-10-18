import type { Voice } from '../../domain/types';
import type { SpeechEngine, SpeechSession } from './SpeechEngine';

/**
 * Voices shipped inside the app bundle (the vTTS store listing says its voices
 * are built in and run on-device).
 *
 * TODO: pick a model runtime (e.g. Piper/VITS via ONNX Runtime or sherpa-onnx),
 * bundle voice files, and report word timings so highlighting keeps working.
 */
export class BundledSpeechEngine implements SpeechEngine {
  readonly id = 'bundled';

  async listVoices(): Promise<Voice[]> {
    return [];
  }

  async speak(): Promise<SpeechSession> {
    throw new Error('Bundled voices are not implemented yet');
  }
}
