import type { ReaderDocument } from '../../domain/types';

export interface LibrarySync {
  backup(documents: ReaderDocument[]): Promise<void>;
  restore(): Promise<ReaderDocument[]>;
}

/**
 * Backup and sync through iCloud (external system "iCloud").
 *
 * TODO: enable the iCloud capability, store the library in the app's
 * ubiquity container (or CloudKit private database), resolve conflicts by
 * last-modified time, and sync reading positions and pronunciation rules.
 */
export class ICloudLibrarySync implements LibrarySync {
  async backup(): Promise<void> {
    throw new Error('iCloud backup is not implemented yet');
  }

  async restore(): Promise<ReaderDocument[]> {
    throw new Error('iCloud restore is not implemented yet');
  }
}
