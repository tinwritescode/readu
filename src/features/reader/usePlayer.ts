import { useEffect, useMemo, useState } from 'react';
import type { LibraryEntry, TextRange, Voice } from '../../domain/types';
import type { SpeechEngine } from '../../adapters/speech/SpeechEngine';
import type { LibraryAction, LibraryState } from '../library/library';
import { resolveVoice } from '../voices/voices';
import { sentenceIndexAt, splitSentences } from './textRanges';
import { useReadAloud } from './useReadAloud';

/**
 * The one playback session of the app. It outlives the reader screen so the
 * library's mini player can pause or resume the document being read, and it
 * writes the reading position back into the library as words are spoken.
 */
export function usePlayer(
  engine: SpeechEngine,
  voices: Voice[],
  library: LibraryState,
  dispatch: (action: LibraryAction) => void,
) {
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [sleepAt, setSleepAt] = useState<number | null>(null);
  const entry = library.entries.find(e => e.id === currentId) ?? null;
  const { settings } = library;

  const reader = useReadAloud(engine, {
    onFinish: () => {
      if (entry) dispatch({ type: 'position', id: entry.id, position: entry.text.length });
      setSleepAt(null);
    },
  });

  const sentences = useMemo(() => (entry ? splitSentences(entry.text) : []), [entry?.text]); // eslint-disable-line react-hooks/exhaustive-deps
  const language = entry?.language ?? 'en';
  const voice = resolveVoice(voices, language, settings.voiceByLanguage);

  useEffect(() => {
    if (!reader.word || !currentId) return;
    dispatch({ type: 'position', id: currentId, position: reader.word.start });
    if (sleepAt !== null && Date.now() >= sleepAt) {
      reader.pause();
      setSleepAt(null);
    }
  }, [reader.word]); // eslint-disable-line react-hooks/exhaustive-deps

  const speakFrom = (
    target: LibraryEntry,
    offset: number,
    next = {
      voice: resolveVoice(voices, target.language ?? 'en', settings.voiceByLanguage),
      speed: settings.speed,
    },
  ) => reader.play(target.text, { voiceId: next.voice?.id, speed: next.speed }, offset);

  /** Where playback continues: the start of the sentence the reader stopped in. */
  const resumeOffset = (target: LibraryEntry) => {
    if (target.position >= target.text.length) return 0;
    const list = target.id === entry?.id ? sentences : splitSentences(target.text);
    return list.length ? Math.min(list[sentenceIndexAt(list, target.position)].start, target.position) : 0;
  };

  const open = (target: LibraryEntry) => {
    if (target.id !== currentId) {
      reader.stop();
      setCurrentId(target.id);
    }
    dispatch({ type: 'open', id: target.id, at: Date.now() });
  };

  const toggle = (target: LibraryEntry | null = entry) => {
    if (!target) return;
    if (target.id === currentId && reader.status === 'speaking') reader.pause();
    else if (target.id === currentId && reader.status === 'paused') reader.resume();
    else {
      open(target);
      speakFrom(target, resumeOffset(target));
    }
  };

  const playFrom = (offset: number) => {
    if (entry) speakFrom(entry, offset);
  };

  /** Jumps to `offset`; keeps playing if it was, otherwise just moves the bookmark. */
  const seek = (offset: number) => {
    if (!entry) return;
    if (reader.status === 'idle') dispatch({ type: 'position', id: entry.id, position: offset });
    else speakFrom(entry, offset);
  };

  const skip = (direction: -1 | 1) => {
    if (!entry || !sentences.length) return;
    const at = reader.word?.start ?? entry.position;
    const index = sentenceIndexAt(sentences, at);
    const target = sentences[Math.max(0, Math.min(sentences.length - 1, index + direction))];
    seek(target.start);
  };

  const restartIfPlaying = (next: { voice: Voice | undefined; speed: number }) => {
    if (entry && reader.status !== 'idle') speakFrom(entry, reader.word?.start ?? entry.position, next);
  };

  const setSpeed = (speed: number) => {
    dispatch({ type: 'settings', patch: { speed } });
    restartIfPlaying({ voice, speed });
  };

  /** `resume` starts reading from the bookmark in the new voice even if playback was stopped. */
  const setVoice = (next: Voice, resume = false) => {
    dispatch({
      type: 'settings',
      patch: { voiceByLanguage: { ...settings.voiceByLanguage, [language]: next.id } },
    });
    if (resume && entry && reader.status === 'idle') {
      speakFrom(entry, resumeOffset(entry), { voice: next, speed: settings.speed });
    } else {
      restartIfPlaying({ voice: next, speed: settings.speed });
    }
  };

  const closeIfCurrent = (id: string) => {
    if (id !== currentId) return;
    reader.stop();
    setCurrentId(null);
  };

  /**
   * The range to highlight: the word being spoken, or while stopped an empty
   * range at the bookmark so its sentence shows where reading will resume.
   */
  const highlight: TextRange | null =
    reader.word ??
    (entry && entry.position > 0 && entry.position < entry.text.length
      ? { start: entry.position, end: entry.position }
      : null);

  return {
    entry,
    status: reader.status,
    error: reader.error,
    highlight,
    sentences,
    voice,
    language,
    sleepAt,
    setSleepAt,
    open,
    toggle,
    playFrom,
    seek,
    skip,
    setSpeed,
    setVoice,
    stop: reader.stop,
    closeIfCurrent,
  };
}

export type Player = ReturnType<typeof usePlayer>;
