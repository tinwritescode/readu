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
import {
  BookOpenIcon,
  CheckIcon,
  ClockIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
} from './icons';
import { colors, formatTile } from './theme';

interface Props {
  entries: LibraryEntry[];
  player: Player;
  speed: number;
  onAdd: (doc: ReaderDocument) => void;
  onOpen: (entry: LibraryEntry) => void;
  onDelete: (entry: LibraryEntry) => void;
}

export function LibraryScreen({
  entries,
  player,
  speed,
  onAdd,
  onOpen,
  onDelete,
}: Props) {
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
        title: 'Add to Library',
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
      {
        title: entry.title,
        options: ['Delete', 'Cancel'],
        destructiveButtonIndex: 0,
        cancelButtonIndex: 1,
      },
      index => index === 0 && onDelete(entry),
    );

  const current = player.entry;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.top}>
        <View>
          <Text style={styles.h1}>Library</Text>
          <Text style={styles.subheading}>
            {entries.length === 0
              ? 'Your reading shelf'
              : `${entries.length} ${entries.length === 1 ? 'document' : 'documents'}`}
          </Text>
        </View>

        <Pressable
          testID="library-add"
          accessibilityLabel="Add document"
          style={({ pressed }) => [styles.addButton, pressed && styles.addButtonPressed]}
          onPress={showAddMenu}>
          <PlusIcon size={18} color={colors.onAccent} />
        </Pressable>
      </View>

      {/* Search Bar */}
      <View style={styles.search}>
        <SearchIcon size={16} color={colors.muted} />
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

      {/* Document List */}
      <FlatList
        data={shown}
        keyExtractor={e => e.id}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: current ? 130 : insets.bottom + 32 },
        ]}
        keyboardDismissMode="on-drag"
        ListHeaderComponent={
          shown.length ? <Text style={styles.section}>Recent Documents</Text> : undefined
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIconCircle}>
              <BookOpenIcon size={28} color={colors.muted} />
            </View>
            <Text style={styles.emptyTitle}>
              {query ? 'No matching documents' : 'Your library is empty'}
            </Text>
            <Text style={styles.emptySubtitle}>
              {query
                ? 'Try searching with another keyword.'
                : 'Import an EPUB, PDF, Word doc, or paste text to start listening.'}
            </Text>

            {!query ? (
              <View style={styles.emptyActions}>
                <Pressable
                  style={styles.emptyButton}
                  onPress={() => setPasting(true)}>
                  <Text style={styles.emptyButtonText}>Paste text</Text>
                </Pressable>
                <Pressable
                  style={[styles.emptyButton, styles.emptyButtonPrimary]}
                  onPress={importFile}>
                  <Text style={[styles.emptyButtonText, styles.emptyButtonPrimaryText]}>
                    Import file
                  </Text>
                </Pressable>
              </View>
            ) : null}
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

      {/* Persistent Mini Player */}
      {current ? (
        <MiniPlayer
          player={player}
          entry={current}
          speed={speed}
          onOpen={() => onOpen(current)}
          bottom={insets.bottom}
        />
      ) : null}

      {/* Paste Modal */}
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
  const finished = isFinished(entry);

  return (
    <Pressable
      testID={`doc-${entry.id}`}
      style={({ pressed }) => [styles.docCard, pressed && styles.docCardPressed]}
      onPress={props.onPress}
      onLongPress={props.onLongPress}>
      {/* Book Cover Tile */}
      <View style={[styles.cover, { backgroundColor: tile.tint }]}>
        <View style={styles.coverSpine} />
        <Text style={[styles.coverLabel, { color: tile.ink }]}>{tile.label}</Text>
      </View>

      {/* Content Meta */}
      <View style={styles.meta}>
        <Text style={styles.title} numberOfLines={2}>
          {entry.title}
        </Text>

        <View style={styles.metaFooter}>
          <View
            style={[
              styles.statusChip,
              finished && styles.statusChipFinished,
            ]}>
            {finished ? (
              <CheckIcon size={12} color={colors.success} />
            ) : (
              <ClockIcon size={11} color={colors.muted} />
            )}
            <Text
              style={[
                styles.statusText,
                finished && styles.statusTextFinished,
              ]}>
              {progressLabel(entry, props.speed)}
            </Text>
          </View>
        </View>

        {/* Micro Progress Bar */}
        <View style={styles.progressBar}>
          <View
            style={[
              styles.progressBarFill,
              { width: `${Math.round(progress * 100)}%` },
              finished && styles.progressBarFinished,
            ]}
          />
        </View>
      </View>
    </Pressable>
  );
}

function MiniPlayer(props: {
  player: Player;
  entry: LibraryEntry;
  speed: number;
  onOpen: () => void;
  bottom: number;
}) {
  const { player, entry } = props;
  const speaking = player.status === 'speaking';
  const progress = entry.text.length ? entry.position / entry.text.length : 0;

  return (
    <Pressable
      testID="mini-player"
      style={({ pressed }) => [
        styles.miniIsland,
        { bottom: Math.max(props.bottom, 10) + 6 },
        pressed && styles.miniIslandPressed,
      ]}
      onPress={props.onOpen}>
      <View style={styles.miniMeta}>
        <Text style={styles.miniTitle} numberOfLines={1}>
          {entry.title}
        </Text>
        <Text style={styles.miniSub} numberOfLines={1}>
          {[player.voice?.name, `${props.speed}×`, progressLabel(entry, props.speed)]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>

      <Pressable
        testID="mini-play-pause"
        accessibilityLabel={speaking ? 'Pause' : 'Play'}
        style={styles.miniPlayButton}
        onPress={() => player.toggle(entry)}>
        {speaking ? (
          <PauseIcon size={16} color={colors.inverse} />
        ) : (
          <PlayIcon size={16} color={colors.inverse} />
        )}
      </Pressable>

      <View style={styles.miniTrack}>
        <View style={[styles.miniFill, { width: `${Math.round(progress * 100)}%` }]} />
      </View>
    </Pressable>
  );
}

function PasteSheet(props: {
  visible: boolean;
  onCancel: () => void;
  onDone: (text: string) => void;
}) {
  const [text, setText] = useState('');

  const close = (done: boolean) => {
    if (done && text.trim()) props.onDone(text);
    else props.onCancel();
    setText('');
  };

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => close(false)}>
      <SafeAreaView style={styles.pasteSheet} edges={['bottom']}>
        <View style={styles.pasteHeader}>
          <Pressable style={styles.textButton} onPress={() => close(false)}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Text style={styles.pasteTitle}>Add Text</Text>
          <Pressable
            testID="paste-done"
            style={styles.textButton}
            disabled={!text.trim()}
            onPress={() => close(true)}>
            <Text
              style={[
                styles.doneText,
                styles.bold,
                !text.trim() && styles.disabled,
              ]}>
              Add
            </Text>
          </Pressable>
        </View>

        <TextInput
          testID="paste-input"
          style={styles.pasteInput}
          multiline
          autoFocus
          placeholder="Paste or type text to read aloud..."
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
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
  },
  h1: {
    fontSize: 34,
    fontWeight: '800',
    color: colors.text,
    letterSpacing: -0.8,
  },
  subheading: {
    fontSize: 13,
    color: colors.muted,
    marginTop: 2,
  },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.accent,
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  addButtonPressed: {
    transform: [{ scale: 0.94 }],
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 20,
    marginTop: 10,
    marginBottom: 6,
    paddingHorizontal: 14,
    height: 42,
    borderRadius: 14,
    backgroundColor: colors.chip,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    color: colors.text,
    height: 42,
  },
  list: {
    paddingHorizontal: 16,
    gap: 12,
  },
  section: {
    paddingTop: 18,
    paddingHorizontal: 6,
    paddingBottom: 8,
    fontSize: 12,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  docCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    borderRadius: 20,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    shadowColor: '#191816',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  docCardPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.99 }],
  },
  cover: {
    width: 52,
    height: 68,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  coverSpine: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  coverLabel: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  meta: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    lineHeight: 22,
    letterSpacing: -0.2,
  },
  metaFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    marginBottom: 8,
  },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: colors.chip,
  },
  statusChipFinished: {
    backgroundColor: '#DCFCE7',
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
    fontVariant: ['tabular-nums'],
  },
  statusTextFinished: {
    color: colors.success,
  },
  progressBar: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.track,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: 4,
    backgroundColor: colors.accent,
    borderRadius: 2,
  },
  progressBarFinished: {
    backgroundColor: colors.success,
  },
  emptyContainer: {
    alignItems: 'center',
    marginTop: 48,
    paddingHorizontal: 24,
  },
  emptyIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.chip,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 6,
  },
  emptySubtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
    textAlign: 'center',
    marginBottom: 20,
  },
  emptyActions: {
    flexDirection: 'row',
    gap: 12,
  },
  emptyButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: colors.chip,
  },
  emptyButtonPrimary: {
    backgroundColor: colors.accent,
  },
  emptyButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  emptyButtonPrimaryText: {
    color: colors.onAccent,
  },
  miniIsland: {
    position: 'absolute',
    left: 16,
    right: 16,
    height: 64,
    borderRadius: 22,
    backgroundColor: colors.inverse,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 18,
    paddingRight: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  miniIslandPressed: {
    opacity: 0.95,
  },
  miniMeta: {
    flex: 1,
    minWidth: 0,
  },
  miniTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.onInverse,
  },
  miniSub: {
    fontSize: 12,
    color: colors.onInverseMuted,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  miniPlayButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.onInverse,
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniTrack: {
    position: 'absolute',
    left: 18,
    right: 18,
    bottom: 0,
    height: 2.5,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  miniFill: {
    height: 2.5,
    backgroundColor: colors.accent,
  },
  pasteSheet: {
    flex: 1,
    backgroundColor: colors.background,
  },
  pasteHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  pasteTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.text,
  },
  textButton: {
    minHeight: 44,
    minWidth: 64,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  cancelText: {
    fontSize: 16,
    color: colors.muted,
  },
  doneText: {
    fontSize: 16,
    color: colors.accent,
    textAlign: 'center',
  },
  bold: {
    fontWeight: '700',
  },
  disabled: {
    opacity: 0.35,
  },
  pasteInput: {
    flex: 1,
    margin: 16,
    padding: 16,
    fontSize: 16,
    lineHeight: 24,
    color: colors.text,
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.borderLight,
    textAlignVertical: 'top',
  },
});
