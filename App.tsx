import React, { Suspense, use, useEffect, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StatusBar, StyleSheet, View } from 'react-native';
import RNFS from 'react-native-fs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AudioCache, CACHE_LIMIT_BYTES, SentenceAudio } from './src/adapters/speech/audioCache';
import { ApiError, fetchVoices, logout, synthesize } from './src/adapters/speech/backend';
import type { LibraryEntry, ReaderDocument, Voice } from './src/domain/types';
import { clearToken, loadToken, saveToken } from './src/features/auth/session';
import { deleteCover, documentFromPaste } from './src/features/import/DocumentImporter';
import { libraryReducer, loadLibrary, saveLibrary, toEntry } from './src/features/library/library';
import { usePlayer } from './src/features/reader/usePlayer';
import { LibraryScreen } from './src/ui/LibraryScreen';
import { LoginScreen } from './src/ui/LoginScreen';
import { ReaderScreen } from './src/ui/ReaderScreen';
import { VoicePicker } from './src/ui/VoicePicker';
import { colors } from './src/ui/theme';

/** The session token the audio requests use. Set by the gate, cleared on logout. */
const session = { token: null as string | null };

const audio = new SentenceAudio(
  new AudioCache(`${RNFS.CachesDirectoryPath}/speech`, CACHE_LIMIT_BYTES),
  (text, voiceId, speed) => {
    if (!session.token) return Promise.reject(new ApiError(401, 'Log in to listen.'));
    return synthesize(session.token, text, voiceId, speed);
  },
);

const WELCOME = documentFromPaste(
  'Welcome to vTTS Reader. This app reads your text aloud with Vietnamese voices from the server, ' +
    'so it needs an internet connection. The sentence being read is highlighted in light green.\n\n' +
    'Tap any sentence to start reading from there. Go back to the library to add your own text: ' +
    'paste it, or open an EPUB, PDF, Word or text file from the Files app!',
);
const libraryPromise = loadLibrary({ ...WELCOME, title: 'Welcome to vTTS Reader' });

/** Logged in or not, and the token when logged in. Undefined while the saved token is read. */
function Gate() {
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    loadToken().then(setToken, () => setToken(null));
  }, []);

  session.token = token ?? null;

  const logIn = (next: string) => {
    session.token = next;
    saveToken(next).then(() => setToken(next));
  };
  /** `remote` also ends the session on the server; a rejected token has nothing to end. */
  const logOut = (remote: boolean) => {
    const current = session.token;
    session.token = null;
    setToken(null);
    clearToken();
    if (remote && current) logout(current);
  };

  if (token === undefined) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator />
      </View>
    );
  }
  if (token === null) return <LoginScreen onLoggedIn={logIn} />;
  return <Root onLogout={logOut} />;
}

function Root({ onLogout }: { onLogout: (remote: boolean) => void }) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [library, dispatch] = useReducer(libraryReducer, use(libraryPromise));
  const player = usePlayer(audio, voices, library, dispatch, () => onLogout(false));
  const [screen, setScreen] = useState<'library' | 'reader'>('library');
  const [picking, setPicking] = useState(false);
  const resumeAfterPicker = useRef(false);

  usePersist(library);

  // Loaded once per login; the voice list does not change while the app runs.
  useEffect(() => {
    fetchVoices(session.token ?? '').then(setVoices, e => {
      if (e instanceof ApiError && e.status === 401) onLogout(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving the app (log out or token lost) stops whatever the player is still playing.
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
          onDelete={target => {
            player.closeIfCurrent(target.id);
            deleteCover(target);
            dispatch({ type: 'remove', id: target.id });
          }}
        />
      )}
      <VoicePicker
        visible={picking}
        voices={voices}
        selectedId={player.voice?.id}
        previewingId={player.previewingId}
        onPreview={player.preview}
        onSelect={voice => {
          setPicking(false);
          player.setVoice(voice, resumeAfterPicker.current);
          resumeAfterPicker.current = false;
        }}
        onClose={closeVoices}
      />
    </>
  );
}

/** Writes the library a moment after it changes, and right away when the app goes to the background. */
function usePersist(library: Parameters<typeof saveLibrary>[0]) {
  const latest = useRef(library);
  latest.current = library;
  useEffect(() => {
    const id = setTimeout(() => saveLibrary(library), 1000);
    return () => clearTimeout(id);
  }, [library]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active') saveLibrary(latest.current);
    });
    return () => sub.remove();
  }, []);
}

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <Suspense
        fallback={
          <View style={styles.loading}>
            <ActivityIndicator />
          </View>
        }>
        <Gate />
      </Suspense>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
});

export default App;
