import React, { useMemo, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LibraryEntry, ReaderDocument } from '../domain/types';
import { documentFromPaste, importDocument } from '../features/import/DocumentImporter';
import { isFinished, recentEntries } from '../features/library/library';
import { formatMinutesLeft, minutesFor } from '../features/reader/estimate';
import type { Player } from '../features/reader/usePlayer';
import { PauseIcon, PlayIcon, PlusIcon, SearchIcon } from './icons';
import { colors, formatTile } from './theme';

interface Props {
  entries: LibraryEntry[];
  player: Player;
  speed: number;
  onAdd: (doc: ReaderDocument) => void;
  onOpen: (entry: LibraryEntry) => void;
  onDelete: (entry: LibraryEntry) => void;
}

export function LibraryScreen({ entries, player, speed, onAdd, onOpen, onDelete }: Props) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [pasting, setPasting] = useState(false);

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const recent = recentEntries(entries);
    return q ? recent.filter(e => e.title.toLocaleLowerCase().includes(q)) : recent;
  }, [entries, query]);

  const importFile = async () => {
    try {
      const doc = await importDocument();
      if (doc) onAdd(doc);
    } catch (e) {
      Alert.alert('Could not import', e instanceof Error ? e.message : String(e));
    }
  };

  const showAddMenu = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'Add to library',
        options: ['Paste text', 'Open a file (EPUB, PDF, Word, TXT)', 'Cancel'],
        cancelButtonIndex: 2,
      },
      index => {
        if (index === 0) setPasting(true);
        else if (index === 1) importFile();
      },
    );

  const showEntryMenu = (entry: LibraryEntry) =>
    ActionSheetIOS.showActionSheetWithOptions(
      { title: entry.title, options: ['Delete', 'Cancel'], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
      index => index === 0 && onDelete(entry),
    );

  const current = player.entry;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.top}>
        <Text style={styles.h1}>Library</Text>
        <Pressable
          testID="library-add"
          accessibilityLabel="Add document"
          style={styles.add}
          onPress={showAddMenu}>
          <PlusIcon color={colors.onAccent} />
        </Pressable>
      </View>

      <View style={styles.search}>
        <SearchIcon color={colors.muted} />
        <TextInput
          testID="library-search"
          style={styles.searchInput}
          placeholder="Search documents"
          placeholderTextColor={colors.muted}
          value={query}
          onChangeText={setQuery}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
      </View>

      <FlatList
        data={shown}
        keyExtractor={e => e.id}
        contentContainerStyle={[styles.list, { paddingBottom: current ? 120 : insets.bottom + 24 }]}
        keyboardDismissMode="on-drag"
        ListHeaderComponent={shown.length ? <Text style={styles.section}>Continue</Text> : undefined}
        ListEmptyComponent={
          <View style={styles.hint}>
            <Text style={styles.hintText}>
              {query ? (
                'No documents match.'
              ) : (
                <>
                  <Text style={styles.hintBold}>Nothing here yet. </Text>
                  Tap + to paste text, or open an EPUB, PDF, Word or text file.
                </>
              )}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <DocumentRow
            entry={item}
            speed={speed}
            onPress={() => onOpen(item)}
            onLongPress={() => showEntryMenu(item)}
          />
        )}
      />

      {current ? (
        <MiniPlayer player={player} entry={current} speed={speed} onOpen={() => onOpen(current)} bottom={insets.bottom} />
      ) : null}

      <PasteSheet
        visible={pasting}
        onCancel={() => setPasting(false)}
        onDone={text => {
          setPasting(false);
          onAdd(documentFromPaste(text));
        }}
      />
    </View>
  );
}

function progressLabel(entry: LibraryEntry, speed: number) {
  if (isFinished(entry)) return 'Finished';
  return formatMinutesLeft(minutesFor(entry.text.length - entry.position, speed));
}

function DocumentRow(props: {
  entry: LibraryEntry;
  speed: number;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { entry } = props;
  const tile = formatTile[entry.format];
  const progress = entry.text.length ? entry.position / entry.text.length : 0;
  return (
    <Pressable
      testID={`doc-${entry.id}`}
      style={({ pressed }) => [styles.doc, pressed && styles.pressed]}
      onPress={props.onPress}
      onLongPress={props.onLongPress}>
      <View style={[styles.cover, { backgroundColor: tile.tint }]}>
        <Text style={[styles.coverLabel, { color: tile.ink }]}>{tile.label}</Text>
      </View>
      <View style={styles.meta}>
        <Text style={styles.title} numberOfLines={1}>
          {entry.title}
        </Text>
        <Text style={styles.sub}>{progressLabel(entry, props.speed)}</Text>
        <View style={styles.bar}>
          <View style={[styles.barFill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
      </View>
    </Pressable>
  );
}

function MiniPlayer(props: { player: Player; entry: LibraryEntry; speed: number; onOpen: () => void; bottom: number }) {
  const { player, entry } = props;
  const speaking = player.status === 'speaking';
  const progress = entry.text.length ? entry.position / entry.text.length : 0;
  return (
    <Pressable
      testID="mini-player"
      style={[styles.mini, { bottom: props.bottom + 8 }]}
      onPress={props.onOpen}>
      <View style={styles.meta}>
        <Text style={styles.miniTitle} numberOfLines={1}>
          {entry.title}
        </Text>
        <Text style={styles.miniSub} numberOfLines={1}>
          {[player.voice?.name, `${props.speed}×`, progressLabel(entry, props.speed)].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <Pressable
        testID="mini-play-pause"
        accessibilityLabel={speaking ? 'Pause' : 'Play'}
        style={styles.miniPlay}
        onPress={() => player.toggle(entry)}>
        {speaking ? <PauseIcon size={16} color={colors.inverse} /> : <PlayIcon size={16} color={colors.inverse} />}
      </Pressable>
      <View style={styles.miniTrack}>
        <View style={[styles.miniFill, { width: `${Math.round(progress * 100)}%` }]} />
      </View>
    </Pressable>
  );
}

function PasteSheet(props: { visible: boolean; onCancel: () => void; onDone: (text: string) => void }) {
  const [text, setText] = useState('');
  const close = (done: boolean) => {
    if (done && text.trim()) props.onDone(text);
    else props.onCancel();
    setText('');
  };
  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => close(false)}>
      <SafeAreaView style={styles.pasteSheet} edges={['bottom']}>
        <View style={styles.pasteHeader}>
          <Pressable style={styles.textButton} onPress={() => close(false)}>
            <Text style={styles.textButtonLabel}>Cancel</Text>
          </Pressable>
          <Text style={styles.pasteTitle}>Paste text</Text>
          <Pressable
            testID="paste-done"
            style={styles.textButton}
            disabled={!text.trim()}
            onPress={() => close(true)}>
            <Text style={[styles.textButtonLabel, styles.bold, !text.trim() && styles.disabled]}>Add</Text>
          </Pressable>
        </View>
        <TextInput
          testID="paste-input"
          style={styles.pasteInput}
          multiline
          autoFocus
          placeholder="Paste or type the text to read aloud"
          placeholderTextColor={colors.muted}
          value={text}
          onChangeText={setText}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  top: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 12 },
  h1: { fontSize: 32, fontWeight: '700', color: colors.text, letterSpacing: -0.6 },
  add: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 20,
    marginTop: 12,
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.track,
  },
  searchInput: { flex: 1, fontSize: 16, color: colors.text, height: 40 },
  list: { paddingHorizontal: 12, gap: 8 },
  section: {
    paddingTop: 14,
    paddingHorizontal: 8,
    paddingBottom: 2,
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  doc: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 12, borderRadius: 16, backgroundColor: colors.surface },
  pressed: { opacity: 0.7 },
  cover: { width: 48, height: 60, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  coverLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  meta: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, fontWeight: '600', color: colors.text },
  sub: { fontSize: 13, color: colors.muted, marginTop: 3 },
  bar: { height: 4, borderRadius: 2, backgroundColor: colors.track, marginTop: 9, overflow: 'hidden' },
  barFill: { height: 4, backgroundColor: colors.accent, borderRadius: 2 },
  hint: { marginTop: 14, marginHorizontal: 8, padding: 14, borderRadius: 16, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.border },
  hintText: { fontSize: 14, lineHeight: 20, color: colors.muted },
  hintBold: { color: colors.text, fontWeight: '600' },
  mini: {
    position: 'absolute',
    left: 12,
    right: 12,
    height: 64,
    borderRadius: 18,
    backgroundColor: colors.inverse,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 16,
    paddingRight: 10,
    overflow: 'hidden',
  },
  miniTitle: { fontSize: 15, fontWeight: '600', color: colors.onInverse },
  miniSub: { fontSize: 13, color: colors.onInverseMuted, marginTop: 2 },
  miniPlay: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.onInverse, alignItems: 'center', justifyContent: 'center' },
  miniTrack: { position: 'absolute', left: 16, right: 16, bottom: 0, height: 2, backgroundColor: 'rgba(246,244,239,0.15)' },
  miniFill: { height: 2, backgroundColor: colors.onInverse },
  pasteSheet: { flex: 1, backgroundColor: colors.background },
  pasteHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, paddingTop: 8 },
  pasteTitle: { fontSize: 17, fontWeight: '600', color: colors.text },
  textButton: { minHeight: 44, minWidth: 64, paddingHorizontal: 12, justifyContent: 'center' },
  textButtonLabel: { fontSize: 17, color: colors.accent, textAlign: 'center' },
  bold: { fontWeight: '600' },
  disabled: { opacity: 0.35 },
  pasteInput: {
    flex: 1,
    margin: 16,
    padding: 14,
    fontSize: 17,
    lineHeight: 26,
    color: colors.text,
    backgroundColor: colors.surface,
    borderRadius: 14,
    textAlignVertical: 'top',
  },
});
