import type { Voice } from '../../domain/types';

const QUALITY_RANK = { premium: 0, enhanced: 1, default: 2 } as const;

export const baseLanguage = (tag: string) => tag.split('-')[0].toLowerCase();

export function byQuality(a: Voice, b: Voice): number {
  return QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality] || a.name.localeCompare(b.name);
}

export function voicesFor(voices: Voice[], language: string): Voice[] {
  return voices.filter(v => baseLanguage(v.language) === language).sort(byQuality);
}

/** The saved voice for `language` if still installed, else its best installed voice, else any voice. */
export function resolveVoice(
  voices: Voice[],
  language: string,
  voiceByLanguage: Record<string, string>,
): Voice | undefined {
  const saved = voices.find(v => v.id === voiceByLanguage[language]);
  return saved ?? voicesFor(voices, language)[0] ?? voicesFor(voices, 'en')[0] ?? voices[0];
}

export interface LanguageGroup {
  language: string;
  label: string;
  voices: Voice[];
}

/** Voices grouped by base language, alphabetical by the language's own name. */
export function groupByLanguage(voices: Voice[]): LanguageGroup[] {
  const groups = new Map<string, Voice[]>();
  for (const voice of voices) {
    const key = baseLanguage(voice.language);
    groups.set(key, [...(groups.get(key) ?? []), voice]);
  }
  return [...groups]
    .map(([language, list]) => ({ language, label: list[0].languageName, voices: list.sort(byQuality) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
