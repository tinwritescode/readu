import type { AudioFormat, ReaderDocument } from '../../domain/types';

export interface ExportRequest {
  document: ReaderDocument;
  voiceId?: string;
  speed: number;
  format: AudioFormat;
}

export interface AudioExporter {
  /** Resolves with the file URL of the written audio. */
  export(request: ExportRequest): Promise<string>;
}

/**
 * TODO: render with AVSpeechSynthesizer.write(_:toBufferCallback:) into an
 * AVAudioFile, then encode: WAV (PCM), M4A (AAC via AVAssetExportSession),
 * M4B (AAC + chapter markers per section), MP3 (needs a bundled encoder such
 * as LAME; iOS has no system MP3 encoder). Share via UIActivityViewController.
 */
export class StubAudioExporter implements AudioExporter {
  async export(): Promise<string> {
    throw new Error('Audio export is not implemented yet');
  }
}
