export interface Translator {
  translate(text: string, from: string, to: string): Promise<string>;
}

/**
 * On-device translation via Apple's Translation framework (external system
 * "Apple Translation").
 *
 * TODO: native module hosting a TranslationSession (iOS 18+, obtained through
 * SwiftUI's .translationTask), language-pack download prompt, and chunking
 * long documents by paragraph.
 */
export class AppleTranslator implements Translator {
  async translate(): Promise<string> {
    throw new Error('Apple Translation is not implemented yet');
  }
}
