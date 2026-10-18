export const colors = {
  background: '#FAF8F5',
  surface: '#FFFFFF',
  surfaceElevated: '#FFFFFF',
  chip: '#F3EFE8',
  chipActive: '#EBF1FD',
  track: '#ECE7DF',
  trackFill: '#1D4ED8',
  text: '#191816',
  reading: '#292723',
  read: '#A49F96',
  muted: '#7F796E',
  border: '#E5DFD4',
  borderLight: '#EFEAE1',
  accent: '#1D4ED8',
  accentSoft: '#EEF3FD',
  onAccent: '#FFFFFF',
  inverse: '#191816',
  onInverse: '#FAF8F5',
  onInverseMuted: '#A7A194',
  sentenceHighlight: '#FDF3CF',
  sentenceHighlightBorder: '#F5E29F',
  wordHighlight: '#2563EB',
  wordHighlightText: '#FFFFFF',
  danger: '#DC2626',
  success: '#16A34A',
};

export const readingFont = 'Georgia';

/** Tint, ink, and format badge styling for a document's cover tile. */
export const formatTile = {
  paste: { tint: '#FEF3C7', ink: '#B45309', label: 'TEXT' },
  txt: { tint: '#DCFCE7', ink: '#15803D', label: 'TXT' },
  epub: { tint: '#DBEAFE', ink: '#1D4ED8', label: 'EPUB' },
  pdf: { tint: '#FEE2E2', ink: '#B91C1C', label: 'PDF' },
  docx: { tint: '#E0E7FF', ink: '#4338CA', label: 'DOCX' },
} as const;
