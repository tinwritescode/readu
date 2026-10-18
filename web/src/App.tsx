import { Suspense, use, useEffect, useReducer, useRef, useState } from 'react';
import { ApiError, fetchVoices, logout, synthesize } from '@shared/adapters/speech/backend';
import type { SentenceAudio } from '@shared/adapters/speech/audioCache';
import type { LibraryEntry, ReaderDocument, Voice } from '@shared/domain/types';
import { documentFromPaste } from '@shared/features/import/DocumentImporter';
import { DEFAULT_VOICE_ID, libraryReducer, toEntry, type LibraryState } from '@shared/features/library/library';
import { usePlayer } from '@shared/features/reader/usePlayer';
import { WEB_CACHE_LIMIT_BYTES, WebAudioCache, WebSentenceAudio } from './platform/audioCache';
import { clearToken, deleteCover, loadToken, loadWebLibrary, saveToken, saveWebLibrary } from './platform/storage';
import { LibraryScreen } from './ui/LibraryScreen';
import { LoginScreen } from './ui/LoginScreen';
import { ReaderScreen } from './ui/ReaderScreen';
import { VoicePicker } from './ui/VoicePicker';

/** The session token the audio requests use. Set by the gate, cleared on logout. */
const session = { token: loadToken() };

const webAudio = new WebSentenceAudio(new WebAudioCache(WEB_CACHE_LIMIT_BYTES), (text, voiceId, speed) => {
  if (!session.token) return Promise.reject(new ApiError(401, 'Log in to listen.'));
  return synthesize(session.token, text, voiceId, speed);
});
/** The shared player takes the mobile SentenceAudio; the web one has the same `path`, which is all the player and its Reader use. */
const audio = webAudio as unknown as SentenceAudio;

const WELCOME = documentFromPaste(
  'Welcome to Readu. This page reads your text aloud with Vietnamese voices from the server, ' +
    'so it needs an internet connection. The sentence being read is highlighted in light green.\n\n' +
    'Click any sentence to start reading from there. Go back to the library to add your own text: ' +
    'paste it, or open an EPUB, PDF, Word or text file. You can also drop a file onto the library.',
);
const libraryPromise = loadWebLibrary({ ...WELCOME, title: 'Welcome to Readu' });

export function App() {
  return (
    <Suspense fallback={<div className="loading">Loading…</div>}>
      <Gate />
    </Suspense>
  );
}

function Gate() {
  const [token, setToken] = useState(session.token);
  session.token = token;

  const logIn = (next: string) => {
    saveToken(next);
    setToken(next);
  };
  /** `remote` also ends the session on the server; a rejected token has nothing to end. */
  const logOut = (remote: boolean) => {
    const current = session.token;
    session.token = null;
    clearToken();
    setToken(null);
    if (remote && current) logout(current);
  };

  if (!token) return <LoginScreen onLoggedIn={logIn} />;
  return <Root onLogout={logOut} />;
}

function Root({ onLogout }: { onLogout: (remote: boolean) => void }) {
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [library, dispatch] = useReducer(libraryReducer, use(libraryPromise));
  const player = usePlayer(audio, voices ?? [], library, dispatch, () => onLogout(false));
  const [screen, setScreen] = useState<'library' | 'reader'>('library');
  const [picking, setPicking] = useState(false);
  const resumeAfterPicker = useRef(false);

  usePersist(library);

  useEffect(() => {
    fetchVoices(session.token ?? '').then(
      list => {
        setVoices(list);
        const saved = library.settings.voiceId;
        if (list.length && !list.some(v => v.id === saved)) {
          dispatch({ type: 'settings', patch: { voiceId: DEFAULT_VOICE_ID } });
        }
      },
      e => {
        if (e instanceof ApiError && e.status === 401) onLogout(false);
        else setVoices([]);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = player.stop;
  useEffect(() => () => stop(), [stop]);

  const open = (entry: LibraryEntry) => {
    player.open(entry);
    setScreen('reader');
  };

  const add = async (doc: ReaderDocument) => {
    const entry = await toEntry(doc);
    dispatch({ type: 'add', entry });
    open(entry);
  };

  // A voice preview takes over the player, so reading stops while the
  // picker is open and resumes after it closes if it was playing.
  const openVoices = () => {
    resumeAfterPicker.current = player.status === 'speaking';
    if (player.status !== 'idle') player.stop();
    setPicking(true);
  };
  const closeVoices = () => {
    setPicking(false);
    if (resumeAfterPicker.current) player.toggle();
    else player.stop();
    resumeAfterPicker.current = false;
  };

  const entry = player.entry;

  return (
    <>
      {screen === 'reader' && entry ? (
        <ReaderScreen
          entry={entry}
          player={player}
          speed={library.settings.speed}
          fontSize={library.settings.fontSize}
          onFontSize={fontSize => dispatch({ type: 'settings', patch: { fontSize } })}
          onBack={() => setScreen('library')}
          onOpenVoices={openVoices}
          onLogout={() => onLogout(true)}
        />
      ) : (
        <LibraryScreen
          entries={library.entries}
          player={player}
          speed={library.settings.speed}
          onAdd={add}
          onOpen={open}
          onReopen={() => setScreen('reader')}
          onDelete={target => {
            player.closeIfCurrent(target.id);
            deleteCover(target);
            dispatch({ type: 'remove', id: target.id });
          }}
          onLogout={() => onLogout(true)}
        />
      )}
      {picking ? (
        <VoicePicker
          voices={voices}
          selectedId={player.voice?.id}
          previewingId={player.previewingId}
          previewLoading={player.previewLoading}
          onPreview={player.preview}
          onSelect={voice => {
            setPicking(false);
            player.setVoice(voice, resumeAfterPicker.current);
            resumeAfterPicker.current = false;
          }}
          onClose={closeVoices}
        />
      ) : null}
    </>
  );
}

/** Writes the library a moment after it changes, and right away when the tab is hidden. */
function usePersist(library: LibraryState) {
  const latest = useRef(library);
  latest.current = library;
  useEffect(() => {
    const id = setTimeout(() => saveWebLibrary(library), 1000);
    return () => clearTimeout(id);
  }, [library]);
  useEffect(() => {
    const save = () => {
      if (document.visibilityState === 'hidden') saveWebLibrary(latest.current);
    };
    document.addEventListener('visibilitychange', save);
    return () => document.removeEventListener('visibilitychange', save);
  }, []);
}
