import React, { Suspense, use, useEffect, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createSystemSpeechEngine } from './src/adapters/speech/SystemSpeechEngine';
import type { LibraryEntry, ReaderDocument } from './src/domain/types';
import { documentFromPaste } from './src/features/import/DocumentImporter';
import { libraryReducer, loadLibrary, saveLibrary, toEntry } from './src/features/library/library';
import { usePlayer } from './src/features/reader/usePlayer';
import { LibraryScreen } from './src/ui/LibraryScreen';
import { ReaderScreen } from './src/ui/ReaderScreen';
import { VoicePicker } from './src/ui/VoicePicker';
import { colors } from './src/ui/theme';

// Swap for BundledSpeechEngine / LanServerSpeechEngine once implemented.
const engine = createSystemSpeechEngine();
const voicesPromise = engine.listVoices();

const WELCOME = documentFromPaste(
  'Welcome to vTTS Reader. This app reads your text aloud with the voices built into iOS, ' +
    'so it works without an internet connection. The word being spoken is highlighted in blue, ' +
    'and the whole sentence in yellow.\n\nTap any sentence to start reading from there. ' +
    'Go back to the library to add your own text: paste it, or open an EPUB, PDF, Word or text file from the Files app!',
);
const libraryPromise = loadLibrary({ ...WELCOME, title: 'Welcome to vTTS Reader' });

function Root() {
  const voices = use(voicesPromise);
  const [library, dispatch] = useReducer(libraryReducer, use(libraryPromise));
  const player = usePlayer(engine, voices, library, dispatch);
  const [screen, setScreen] = useState<'library' | 'reader'>('library');
  const [picking, setPicking] = useState(false);
  const resumeAfterPicker = useRef(false);

  usePersist(library);

  const open = (entry: LibraryEntry) => {
    player.open(entry);
    setScreen('reader');
  };

  const add = async (doc: ReaderDocument) => {
    const entry = await toEntry(doc);
    dispatch({ type: 'add', entry });
    open(entry);
  };

  // A voice preview takes over the synthesizer, so reading stops while the
  // picker is open and continues afterwards.
  const openVoices = () => {
    resumeAfterPicker.current = player.status === 'speaking';
    if (player.status !== 'idle') player.stop();
    setPicking(true);
  };
  const closeVoices = () => {
    setPicking(false);
    if (resumeAfterPicker.current) player.toggle();
    resumeAfterPicker.current = false;
  };

  const entry = player.entry;
  const sample = entry
    ? entry.text.slice(...currentSentence(player.sentences, player.highlight?.start ?? entry.position)).trim()
    : '';

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
            dispatch({ type: 'remove', id: target.id });
          }}
        />
      )}
      <VoicePicker
        visible={picking}
        engine={engine}
        voices={voices}
        language={player.language}
        selectedId={player.voice?.id}
        sample={sample || 'This is how I sound.'}
        speed={library.settings.speed}
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

function currentSentence(sentences: { start: number; end: number }[], offset: number): [number, number] {
  const s = sentences.find(r => r.end > offset) ?? sentences[0];
  return s ? [s.start, s.end] : [0, 0];
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
        <Root />
      </Suspense>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
});

export default App;
