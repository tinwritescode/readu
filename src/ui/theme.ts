export const colors = {
  background: '#F6F4EF',
  surface: '#FFFFFF',
  chip: '#F1EEE8',
  track: '#EBE8E1',
  text: '#1C1B19',
  reading: '#3A3833',
  read: '#A8A397',
  muted: '#807B72',
  border: '#D6D1C6',
  accent: '#2F5BE8',
  accentSoft: '#E3E9FD',
  onAccent: '#FFFFFF',
  inverse: '#1C1B19',
  onInverse: '#F6F4EF',
  onInverseMuted: '#B8B3A8',
  sentenceHighlight: '#FBF1C7',
  wordHighlight: '#2F5BE8',
  danger: '#B3261E',
};

export const readingFont = 'Georgia';

/** Tint and ink for a document's cover tile, by format. */
export const formatTile = {
  paste: { tint: '#FBF1C7', ink: '#8A6A00', label: 'TEXT' },
  txt: { tint: '#E4F2E4', ink: '#2E7D32', label: 'TXT' },
  epub: { tint: '#E3E9FD', ink: '#2F5BE8', label: 'EPUB' },
  pdf: { tint: '#FDE4DE', ink: '#B3261E', label: 'PDF' },
  docx: { tint: '#E6EEF7', ink: '#1F5A96', label: 'DOCX' },
} as const;
