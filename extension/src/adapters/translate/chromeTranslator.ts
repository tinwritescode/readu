// Chrome's built-in Translator: English to Vietnamese with a model on this computer, no network once its
// language pack is downloaded. Creating it while the pack still has to be downloaded takes a click or key
// press on the page, so it is created when the viewer turns dubbing on.

interface ChromeTranslator {
  translate(text: string): Promise<string>;
  destroy(): void;
}

interface TranslatorFactory {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>;
  create(o: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: EventTarget) => void;
  }): Promise<ChromeTranslator>;
}

const LANGS = { sourceLanguage: 'en', targetLanguage: 'vi' };

export type TranslatorProblem = 'unsupported' | 'needs-click' | 'failed';

export class TranslatorError extends Error {
  constructor(readonly problem: TranslatorProblem, message: string) {
    super(message);
  }
}

function factory(): TranslatorFactory | undefined {
  return (globalThis as { Translator?: TranslatorFactory }).Translator;
}

let shared: Promise<ChromeTranslator> | null = null;

/** The English to Vietnamese translator, created once per page. onDownload reports the language pack's
 *  download, 0..1, the first time. */
export function englishToVietnamese(onDownload?: (fraction: number) => void): Promise<ChromeTranslator> {
  shared ??= (async () => {
    const T = factory();
    if (!T) throw new TranslatorError('unsupported', 'This Chrome has no built-in translator (Chrome 138 or later).');
    const availability = await T.availability(LANGS);
    if (availability === 'unavailable') throw new TranslatorError('unsupported', 'Chrome cannot translate English to Vietnamese here.');
    if (availability !== 'available' && !navigator.userActivation?.isActive) {
      throw new TranslatorError('needs-click', 'The Vietnamese language pack needs a click to download.');
    }
    try {
      return await T.create({
        ...LANGS,
        monitor: m => m.addEventListener('downloadprogress', e => onDownload?.((e as ProgressEvent).loaded)),
      });
    } catch (e) {
      throw new TranslatorError('failed', e instanceof Error ? e.message : String(e));
    }
  })().catch(e => {
    shared = null;
    throw e;
  });
  return shared;
}
