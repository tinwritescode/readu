import { useCallback, useEffect, useRef, useState } from 'react';
import type { TextRange } from '../../domain/types';
import type { SpeechEngine, SpeechSession } from '../../adapters/speech/SpeechEngine';

export type PlaybackStatus = 'idle' | 'speaking' | 'paused';

export interface ReadAloudOptions {
  voiceId?: string;
  speed: number;
}

/**
 * Reads `text` aloud through `engine` and tracks the word being spoken, in
 * offsets of the full text. Playing again from `fromOffset` is how speed or
 * voice changes take effect mid-document, since an utterance's rate is fixed
 * once it starts.
 */
export function useReadAloud(engine: SpeechEngine, events: { onFinish?: () => void } = {}) {
  const onFinishRef = useRef(events.onFinish);
  onFinishRef.current = events.onFinish;
  const [status, setStatus] = useState<PlaybackStatus>('idle');
  const [word, setWord] = useState<TextRange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<SpeechSession | null>(null);
  const run = useRef(0);

  const play = useCallback(
    async (text: string, options: ReadAloudOptions, fromOffset = 0) => {
      const runId = ++run.current;
      const isCurrent = () => runId === run.current;
      setError(null);
      setStatus('speaking');
      try {
        session.current = await engine.speak(text.slice(fromOffset), options, {
          onRange: range => {
            if (!isCurrent()) return;
            setWord({ start: range.start + fromOffset, end: range.end + fromOffset });
          },
          onFinish: () => {
            if (!isCurrent()) return;
            session.current = null;
            setStatus('idle');
            setWord(null);
            onFinishRef.current?.();
          },
          onCancel: () => {
            if (!isCurrent()) return;
            session.current = null;
            setStatus('idle');
          },
        });
      } catch (e) {
        if (!isCurrent()) return;
        setStatus('idle');
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [engine],
  );

  const pause = useCallback(() => {
    session.current?.pause();
    setStatus('paused');
  }, []);

  const resume = useCallback(() => {
    session.current?.resume();
    setStatus('speaking');
  }, []);

  const stop = useCallback(() => {
    run.current++;
    session.current?.stop();
    session.current = null;
    setStatus('idle');
    setWord(null);
  }, []);

  useEffect(() => () => session.current?.stop(), []);

  return { status, word, error, play, pause, resume, stop };
}
