export interface PronunciationRule {
  /** Text as written, e.g. "SQL". */
  match: string;
  /** How it should be spoken, e.g. "sequel". */
  replacement: string;
}

export interface PronunciationDictionary {
  rules(): Promise<PronunciationRule[]>;
  save(rules: PronunciationRule[]): Promise<void>;
}

/**
 * TODO: persist rules, then apply them on the native side as
 * AVSpeechSynthesisIPANotationAttribute on an NSAttributedString utterance so
 * spoken ranges still map to the original text (plain string substitution
 * would shift highlight offsets).
 */
export class StubPronunciationDictionary implements PronunciationDictionary {
  async rules(): Promise<PronunciationRule[]> {
    return [];
  }

  async save(): Promise<void> {
    throw new Error('Pronunciation rules are not implemented yet');
  }
}
