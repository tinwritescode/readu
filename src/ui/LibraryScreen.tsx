import React, { useMemo, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Image,
  Modal,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LibraryEntry, ReaderDocument } from '../domain/types';
import { coverUri, documentFromPaste, importDocument } from '../features/import/DocumentImporter';
import { isFinished, recentEntries } from '../features/library/library';
import { formatMinutesLeft, minutesFor } from '../features/reader/estimate';
import type { Player } from '../features/reader/usePlayer';
import { CheckIcon, PauseIcon, PlayIcon, PlusIcon, ProgressRing, SearchIcon } from './icons';
import { colors, fonts } from './theme';

interface Props {
  entries: LibraryEntry[];
  player: Player;
  speed: number;
  onAdd: (doc: ReaderDocument) => void;
  onOpen: (entry: LibraryEntry) => void;
  onDelete: (entry: LibraryEntry) => void;
}

const FORMAT_LABEL = { paste: 'Text', txt: 'Text', epub: 'EPUB', pdf: 'PDF', docx: 'Word' } as const;

interface Section {
  key: 'continue' | 'all';
  title: string;
  data: LibraryEntry[];
}

const started = (e: LibraryEntry) => e.position > 0 && !isFinished(e);

/** The most recently opened document, if it is part-way through, sits apart under Continue. */
function librarySections(entries: LibraryEntry[], query: string): Section[] {
  const q = query.trim().toLocaleLowerCase();
  const recent = recentEntries(entries).filter(e => !q || e.title.toLocaleLowerCase().includes(q));
  const [first, ...rest] = recent;
  const sections: Section[] = [];
  if (first && started(first) && !q) {
    sections.push({ key: 'continue', title: 'Continue', data: [first] });
    if (rest.length) sections.push({ key: 'all', title: 'All documents', data: rest });
  } else if (recent.length) {
    sections.push({ key: 'all', title: q ? 'Results' : 'All documents', data: recent });
  }
  return sections;
}

export function LibraryScreen({ entries, player, speed, onAdd, onOpen, onDelete }: Props) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [pasting, setPasting] = useState(false);
  const sections = useMemo(() => librarySections(entries, query), [entries, query]);

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
      { title: entry.title, options: ['Delete', 'Cancel'], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
      index => index === 0 && onDelete(entry),
    );

  const current = player.entry;
  const listBottom = { paddingBottom: (current ? 96 : 24) + insets.bottom };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.top}>
        <Text style={styles.h1}>Library</Text>
        <Pressable
          testID="library-add"
          accessibilityLabel="Add document"
          hitSlop={8}
          style={({ pressed }) => [styles.add, pressed && styles.pressed]}
          onPress={showAddMenu}>
          <PlusIcon size={20} color={colors.accent} />
        </Pressable>
      </View>

      <View style={styles.search}>
        <SearchIcon size={15} color={colors.muted} />
        <TextInput
          testID="library-search"
          style={styles.searchInput}
          placeholder="Search"
          placeholderTextColor={colors.muted}
          value={query}
          onChangeText={setQuery}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
      </View>

      <SectionList
        sections={sections}
        keyExtractor={e => e.id}
        contentContainerStyle={[styles.list, listBottom]}
        keyboardDismissMode="on-drag"
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => <Text style={styles.groupTitle}>{section.title}</Text>}
        renderItem={({ item, index, section }) => (
          <DocumentRow
            entry={item}
            speed={speed}
            hero={section.key === 'continue'}
            first={index === 0}
            last={index === section.data.length - 1}
            onPress={() => onOpen(item)}
            onLongPress={() => showEntryMenu(item)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{query ? 'No matching documents' : 'Your library is empty'}</Text>
            <Text style={styles.emptySub}>
              {query
                ? 'Try another word.'
                : 'Open an EPUB, PDF, Word or text file, or paste text, to start listening.'}
            </Text>
            {!query ? (
              <View style={styles.emptyActions}>
                <Pressable style={styles.emptyButton} onPress={() => setPasting(true)}>
                  <Text style={styles.emptyButtonText}>Paste text</Text>
                </Pressable>
                <Pressable style={[styles.emptyButton, styles.emptyPrimary]} onPress={importFile}>
                  <Text style={[styles.emptyButtonText, styles.onAccent]}>Open a file</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        }
      />

      {current ? (
        <MiniPlayer
          player={player}
          entry={current}
          speed={speed}
          onOpen={() => onOpen(current)}
          bottom={insets.bottom}
        />
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

function progressOf(entry: LibraryEntry) {
  return entry.text.length ? entry.position / entry.text.length : 0;
}

function timeLabel(entry: LibraryEntry, speed: number) {
  if (isFinished(entry)) return 'Finished';
  const minutes = minutesFor(entry.text.length - entry.position, speed);
  return entry.position > 0 ? formatMinutesLeft(minutes) : formatMinutesLeft(minutes).replace(/ left$/, '');
}

/** The document's cover, or for a document without one a thin frame with its initial. */
function Cover({ entry, width }: { entry: LibraryEntry; width: number }) {
  const uri = coverUri(entry);
  const size = { width, height: Math.round(width * 1.5) };
  if (uri) return <Image source={{ uri }} style={[styles.cover, size]} resizeMode="cover" />;
  return (
    <View style={[styles.cover, styles.coverBlank, size]}>
      <Text style={[styles.initial, { fontSize: width * 0.45 }]}>
        {entry.title.trim().charAt(0).toLocaleUpperCase() || '·'}
      </Text>
    </View>
  );
}

function DocumentRow(props: {
  entry: LibraryEntry;
  speed: number;
  hero: boolean;
  first: boolean;
  last: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { entry, hero } = props;
  const finished = isFinished(entry);
  const meta = [FORMAT_LABEL[entry.format], timeLabel(entry, props.speed)].join(' · ');

  return (
    <Pressable
      testID={`doc-${entry.id}`}
      style={({ pressed }) => [
        styles.row,
        hero && styles.heroRow,
        props.first && styles.rowFirst,
        props.last && styles.rowLast,
        pressed && styles.rowPressed,
      ]}
      onPress={props.onPress}
      onLongPress={props.onLongPress}>
      {!props.first ? <View style={[styles.separator, hero ? styles.separatorHero : styles.separatorRow]} /> : null}
      <Cover entry={entry} width={hero ? 56 : 32} />
      <View style={styles.rowText}>
        <Text style={[styles.title, hero && styles.heroTitle]} numberOfLines={2}>
          {entry.title}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
        {hero ? (
          <View style={styles.bar}>
            <View style={[styles.barFill, { width: `${Math.round(progressOf(entry) * 100)}%` }]} />
          </View>
        ) : null}
      </View>
      {hero ? null : finished ? (
        <CheckIcon size={16} color={colors.accent} />
      ) : entry.position > 0 ? (
        <ProgressRing size={22} progress={progressOf(entry)} color={colors.accent} track={colors.track} />
      ) : (
        <Text style={styles.meta}>New</Text>
      )}
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

  return (
    <Pressable
      testID="mini-player"
      style={({ pressed }) => [styles.mini, { bottom: Math.max(props.bottom, 10) + 4 }, pressed && styles.pressed]}
      onPress={props.onOpen}>
      <Cover entry={entry} width={26} />
      <View style={styles.rowText}>
        <Text style={styles.miniTitle} numberOfLines={1}>
          {entry.title}
        </Text>
        <Text style={styles.miniSub} numberOfLines={1}>
          {[player.voice?.name, `${props.speed}×`].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <Pressable
        testID="mini-play-pause"
        accessibilityLabel={speaking ? 'Pause' : 'Play'}
        hitSlop={10}
        style={styles.miniButton}
        onPress={() => player.toggle(entry)}>
        {speaking ? <PauseIcon size={18} color={colors.text} /> : <PlayIcon size={18} color={colors.text} />}
      </Pressable>
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
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => close(false)}>
      <SafeAreaView style={styles.sheet} edges={['bottom']}>
        <View style={styles.sheetHeader}>
          <Pressable style={styles.textButton} onPress={() => close(false)}>
            <Text style={styles.sheetAction}>Cancel</Text>
          </Pressable>
          <Text style={styles.sheetTitle}>Paste Text</Text>
          <Pressable
            testID="paste-done"
            style={styles.textButton}
            disabled={!text.trim()}
            onPress={() => close(true)}>
            <Text style={[styles.sheetAction, styles.sheetDone, !text.trim() && styles.disabled]}>Add</Text>
          </Pressable>
        </View>
        <TextInput
          testID="paste-input"
          style={styles.pasteInput}
          multiline
          autoFocus
          placeholder="Paste or type text to read aloud"
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
  pressed: { opacity: 0.6 },
  top: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
  },
  h1: { fontSize: 34, fontWeight: '700', color: colors.text, letterSpacing: 0.37 },
  add: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginBottom: 6,
    paddingHorizontal: 9,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.chip,
  },
  searchInput: { flex: 1, fontSize: 17, color: colors.text, height: 36 },
  list: { paddingHorizontal: 16 },
  groupTitle: {
    marginTop: 22,
    marginBottom: 7,
    marginHorizontal: 16,
    fontSize: 13,
    color: colors.muted,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.surface,
  },
  heroRow: { paddingVertical: 12, alignItems: 'flex-start' },
  rowFirst: { borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  rowLast: { borderBottomLeftRadius: 12, borderBottomRightRadius: 12 },
  rowPressed: { backgroundColor: colors.chip },
  separator: { position: 'absolute', top: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  separatorHero: { left: 82 },
  separatorRow: { left: 58 },
  cover: { borderRadius: 2, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(23,25,26,0.18)' },
  coverBlank: { borderColor: colors.border, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  initial: { fontFamily: fonts.readItalic, color: colors.muted },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontFamily: fonts.readMedium, fontSize: 16, lineHeight: 21, color: colors.text },
  heroTitle: { fontSize: 18, lineHeight: 24, marginTop: 2 },
  meta: { fontSize: 13, color: colors.muted, fontVariant: ['tabular-nums'] },
  bar: { height: 3, borderRadius: 1.5, marginTop: 10, backgroundColor: colors.track, overflow: 'hidden' },
  barFill: { height: 3, backgroundColor: colors.accent },
  empty: { alignItems: 'center', marginTop: 64, paddingHorizontal: 24 },
  emptyTitle: { fontFamily: fonts.readMedium, fontSize: 20, color: colors.text, marginBottom: 6 },
  emptySub: { fontSize: 15, lineHeight: 21, color: colors.muted, textAlign: 'center', marginBottom: 20 },
  emptyActions: { flexDirection: 'row', gap: 12 },
  emptyButton: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: 10, backgroundColor: colors.chip },
  emptyPrimary: { backgroundColor: colors.accent },
  emptyButtonText: { fontSize: 15, fontWeight: '600', color: colors.text },
  onAccent: { color: colors.onAccent },
  mini: {
    position: 'absolute',
    left: 8,
    right: 8,
    height: 60,
    borderRadius: 16,
    backgroundColor: 'rgba(251,251,248,0.97)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 12,
    paddingRight: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(23,25,26,0.1)',
    shadowColor: '#17191A',
    shadowOpacity: 0.16,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
  },
  miniTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  miniSub: { fontSize: 12.5, color: colors.muted },
  miniButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  sheet: { flex: 1, backgroundColor: colors.background },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingTop: 10,
  },
  sheetTitle: { fontSize: 17, fontWeight: '600', color: colors.text },
  textButton: { minHeight: 44, minWidth: 64, paddingHorizontal: 10, justifyContent: 'center' },
  sheetAction: { fontSize: 17, color: colors.accent },
  sheetDone: { fontWeight: '600', textAlign: 'right' },
  disabled: { opacity: 0.35 },
  pasteInput: {
    flex: 1,
    margin: 16,
    padding: 16,
    fontFamily: fonts.read,
    fontSize: 17,
    lineHeight: 26,
    color: colors.text,
    backgroundColor: colors.surface,
    borderRadius: 12,
    textAlignVertical: 'top',
  },
});
