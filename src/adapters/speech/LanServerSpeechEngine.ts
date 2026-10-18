import type { Voice } from '../../domain/types';
import type { SpeechEngine, SpeechSession } from './SpeechEngine';

/**
 * Optional speech server on the local network (external system "LAN server").
 *
 * TODO: define the HTTP contract (GET /voices, POST /synthesize returning audio
 * plus word timings), add server discovery/config UI, stream playback.
 */
export class LanServerSpeechEngine implements SpeechEngine {
  readonly id = 'lan-server';

  constructor(readonly baseUrl: string) {}

  async listVoices(): Promise<Voice[]> {
    return [];
  }

  async speak(): Promise<SpeechSession> {
    throw new Error('LAN server speech is not implemented yet');
  }
}
