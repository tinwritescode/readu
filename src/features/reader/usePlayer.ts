import { useCallback, useMemo, useRef, useState } from 'react';
import type { SentenceAudio } from '../../adapters/speech/audioCache';
import { ApiError } from '../../adapters/speech/backend';
import { Reader, type PlaybackStatus } from '../../adapters/speech/playback';
import type { LibraryEntry, TextRange, Voice } from '../../domain/types';
import type { LibraryAction, LibraryState } from '../library/library';
import { sentenceIndexAt, splitSentences } from './textRanges';

/** The server's speed limit; the reader offers up to 2×, which plays at this. */
const MAX_SERVER_SPEED = 1.9;

/** A short sentence in the voice's language, for the voice picker's preview. */
export const PREVIEW_TEXT = 'Xin chào, đây là giọng đọc của tôi.';

/**
 * The one playback session of the app. It outlives the reader screen so the
 * library's mini player can pause or resume the document being read, and it
 * writes the reading position back into the library as sentences are spoken.
 */
export function usePlayer(
  audio: SentenceAudio,
  voices: Voice[],
  library: LibraryState,
  dispatch: (action: LibraryAction) => void,
  onSessionLost: () => void,
) {
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [sleepAt, setSleepAt] = useState<number | null>(null);
  const [status, setStatus] = useState<PlaybackStatus>('idle');
  const [spoken, setSpoken] = useState<number | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const entry = library.entries.find(e => e.id === currentId) ?? null;
  const { settings } = library;
  const sentences = useMemo(() => (entry ? splitSentences(entry.text) : []), [entry?.text]); // eslint-disable-line react-hooks/exhaustive-deps

  // The reader is created once, so its callbacks read the latest values here.
  const latest = useRef({ entry, sentences, sleepAt, dispatch, onSessionLost });
  latest.current = { entry, sentences, sleepAt, dispatch, onSessionLost };

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) {
      latest.current.onSessionLost();
      return;
    }
    setError(e instanceof Error ? e.message : String(e));
  };

  const [reader] = useState(
    () =>
      new Reader(audio, {
        onStatus: (next, silent) => {
          if (silent) {
            if (next === 'idle') setPreviewId(null);
            return;
          }
          setStatus(next);
          if (next === 'idle') setSpoken(null);
        },
        onSentence: index => {
          setSpoken(index);
          const { entry: current, sentences: list, sleepAt: due, dispatch: send } = latest.current;
          if (!current || !list[index]) return;
          send({ type: 'position', id: current.id, position: list[index].start });
          if (due !== null && Date.now() >= due) {
            reader.pause();
            setSleepAt(null);
          }
        },
        onFinish: () => {
          const { entry: current, dispatch: send } = latest.current;
          if (current) send({ type: 'position', id: current.id, position: current.text.length });
          setSleepAt(null);
        },
        onError: e => fail(e),
      }),
  );

  const voiceId = settings.voiceId;
  const voice = voices.find(v => v.id === voiceId);
  const serverSpeed = (speed: number) => Math.min(speed, MAX_SERVER_SPEED);

  const run = (promise: Promise<void>) => {
    promise.catch(fail);
  };

  /** Where playback continues: the sentence the reader stopped in. */
  const resumeOffset = (target: LibraryEntry) => {
    if (target.position >= target.text.length) return 0;
    const list = target.id === entry?.id ? sentences : splitSentences(target.text);
    return list.length ? list[sentenceIndexAt(list, target.position)].start : 0;
  };

  /** Starts reading `target` at the sentence containing `offset`. */
  const readFrom = (
    target: LibraryEntry,
    offset: number,
    speed = settings.speed,
    voiceFor = voiceId,
  ) => {
    setError(null);
    setPreviewId(null);
    const list = target.id === entry?.id ? sentences : splitSentences(target.text);
    run(
      reader.play(
        {
          title: target.title,
          texts: list.map(s => target.text.slice(s.start, s.end)),
          voiceId: voiceFor,
          speed: serverSpeed(speed),
          silent: false,
        },
        sentenceIndexAt(list, offset),
      ),
    );
  };

  /** Offset of the sentence being spoken, else the bookmark. */
  const currentOffset = (target: LibraryEntry) =>
    spoken !== null && sentences[spoken] ? sentences[spoken].start : target.position;

  const open = (target: LibraryEntry) => {
    if (target.id !== currentId) {
      reader.stop();
      setCurrentId(target.id);
    }
    dispatch({ type: 'open', id: target.id, at: Date.now() });
  };

  const toggle = (target: LibraryEntry | null = entry) => {
    if (!target) return;
    if (target.id === currentId && status === 'speaking') reader.pause();
    else if (target.id === currentId && status === 'paused') reader.resume();
    else {
      open(target);
      readFrom(target, resumeOffset(target));
    }
  };

  const playFrom = (offset: number) => {
    if (entry) readFrom(entry, offset);
  };

  /** Jumps to `offset`; keeps playing if it was, otherwise just moves the bookmark. */
  const seek = (offset: number) => {
    if (!entry) return;
    if (status === 'idle') dispatch({ type: 'position', id: entry.id, position: offset });
    else readFrom(entry, offset);
  };

  const skip = (direction: -1 | 1) => {
    if (!entry || !sentences.length) return;
    const index = sentenceIndexAt(sentences, status === 'idle' ? entry.position : currentOffset(entry));
    const target = sentences[Math.max(0, Math.min(sentences.length - 1, index + direction))];
    seek(target.start);
  };

  const setSpeed = (speed: number) => {
    dispatch({ type: 'settings', patch: { speed } });
    if (entry && status !== 'idle') readFrom(entry, currentOffset(entry), speed);
  };

  /** `resume` starts reading from the bookmark in the new voice even if playback was stopped. */
  const setVoice = (next: Voice, resume = false) => {
    dispatch({ type: 'settings', patch: { voiceId: next.id } });
    if (!entry) return;
    if (status !== 'idle') readFrom(entry, currentOffset(entry), settings.speed, next.id);
    else if (resume) readFrom(entry, resumeOffset(entry), settings.speed, next.id);
  };

  const preview = (next: Voice) => {
    if (previewId === next.id) {
      setPreviewId(null);
      reader.stop();
      return;
    }
    setError(null);
    setPreviewId(next.id);
    run(
      reader.play(
        { title: 'Voice preview', texts: [PREVIEW_TEXT], voiceId: next.id, speed: serverSpeed(settings.speed), silent: true },
        0,
      ),
    );
  };

  const stop = useCallback(() => {
    setPreviewId(null);
    reader.stop();
  }, [reader]);

  const closeIfCurrent = (id: string) => {
    if (id !== currentId) return;
    stop();
    setCurrentId(null);
  };

  /**
   * The range to highlight: the sentence being spoken, or while stopped the
   * sentence at the bookmark so the reader shows where reading will resume.
   */
  const highlight: TextRange | null =
    spoken !== null && sentences[spoken]
      ? sentences[spoken]
      : entry && entry.position > 0 && entry.position < entry.text.length
        ? { start: entry.position, end: entry.position }
        : null;

  return {
    entry,
    status,
    error,
    highlight,
    sentences,
    voice,
    previewingId: previewId,
    sleepAt,
    setSleepAt,
    open,
    toggle,
    playFrom,
    seek,
    skip,
    setSpeed,
    setVoice,
    preview,
    stop,
    closeIfCurrent,
  };
}

export type Player = ReturnType<typeof usePlayer>;
