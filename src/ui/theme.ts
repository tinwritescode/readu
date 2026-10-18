/** Paper and ink: a grey-green paper, near-black ink, moss green for actions, highlighter green for speech. */
export const colors = {
  background: '#F1F2EE',
  surface: '#FBFBF8',
  chip: '#E4E6E0',
  track: '#E1E4DE',
  text: '#17191A',
  reading: '#17191A',
  read: '#8F948D',
  muted: '#6A6F69',
  border: '#D3D7D0',
  borderLight: '#E1E4DE',
  accent: '#1E5B47',
  accentSoft: '#DCE8D2',
  onAccent: '#FBFBF8',
  inverse: '#17191A',
  onInverse: '#F1F2EE',
  sentenceHighlight: '#DCE8D2',
  wordHighlight: '#B9D3A6',
  danger: '#B3261E',
};

/**
 * Bundled in assets/fonts (SIL OFL), named by PostScript name. Literata is the reading face and
 * document titles; Public Sans the small uppercase labels in the reader. Everything else uses SF Pro.
 */
export const fonts = {
  read: 'Literata-Regular',
  readItalic: 'Literata-Italic',
  readMedium: 'Literata-Medium',
  readSemiBold: 'Literata-SemiBold',
  label: 'PublicSans-Medium',
  labelBold: 'PublicSans-SemiBold',
};

/** Small uppercase label used in the reader's nav and dock. */
export const labelText = {
  fontFamily: fonts.labelBold,
  fontSize: 11,
  letterSpacing: 1.1,
  textTransform: 'uppercase',
  color: colors.muted,
} as const;
