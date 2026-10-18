import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  FlatList,
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LibraryEntry, TextRange } from '../domain/types';
import { formatClock, formatMinutesLeft, minutesFor } from '../features/reader/estimate';
import { sentenceIndexAt, textBlocks } from '../features/reader/textRanges';
import type { Player } from '../features/reader/usePlayer';
import { ArrowDownIcon, ChevronIcon, MoreIcon, PauseIcon, PlayIcon, SkipIcon } from './icons';
import { colors, readingFont } from './theme';

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const FONT_SIZES = [17, 19, 22, 25];
const SLEEP_MINUTES = [15, 30, 45, 60];

const QUALITY_LABEL = { premium: 'Premium', enhanced: 'Enhanced', default: 'Default' } as const;

interface Props {
  entry: LibraryEntry;
  player: Player;
  speed: number;
  fontSize: number;
  onFontSize: (size: number) => void;
  onBack: () => void;
  onOpenVoices: () => void;
}

export function ReaderScreen({ entry, player, speed, fontSize, onFontSize, onBack, onOpenVoices }: Props) {
  const insets = useSafeAreaInsets();
  const list = useRef<FlatList<TextRange>>(null);
  const [following, setFollowing] = useState(true);

  const { sentences, highlight } = player;
  const blocks = useMemo(() => textBlocks(entry.text, sentences), [entry.text, sentences]);
  const current = highlight ? sentenceIndexAt(sentences, highlight.start) : -1;
  const currentBlock = highlight && blocks.length ? sentenceIndexAt(blocks, highlight.start) : -1;
  const playing = player.status !== 'idle';

  const scrollToCurrent = (animated = true) => {
    if (currentBlock >= 0) list.current?.scrollToIndex({ index: currentBlock, viewPosition: 0.3, animated });
  };

  useEffect(() => {
    if (following) scrollToCurrent();
  }, [currentBlock, following]); // eslint-disable-line react-hooks/exhaustive-deps

  const lineHeight = Math.round(fontSize * 1.62);
  const remaining = minutesFor(entry.text.length - (highlight?.start ?? entry.position), speed);

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.nav}>
        <Pressable testID="reader-back" accessibilityLabel="Back to library" style={styles.icon} onPress={onBack}>
          <ChevronIcon direction="left" color={colors.text} />
        </Pressable>
        <View style={styles.navTitle}>
          <Text style={styles.navTitleText} numberOfLines={1}>
            {entry.title}
          </Text>
          <Text style={styles.navSub}>{formatMinutesLeft(remaining)}</Text>
        </View>
        <Pressable
          testID="font-size"
          accessibilityLabel="Text size"
          style={styles.icon}
          onPress={() => onFontSize(FONT_SIZES[(FONT_SIZES.indexOf(fontSize) + 1) % FONT_SIZES.length])}>
          <Text style={styles.aa}>Aa</Text>
        </Pressable>
      </View>

      <FlatList
        ref={list}
        testID="reader-text"
        data={blocks}
        extraData={`${current}:${highlight?.start}:${highlight?.end}:${fontSize}`}
        keyExtractor={b => String(b.start)}
        contentContainerStyle={styles.page}
        onScrollBeginDrag={() => setFollowing(false)}
        onScrollToIndexFailed={info => {
          list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
          requestAnimationFrame(() => scrollToCurrent(false));
        }}
        renderItem={({ item }) => (
          <Block
            text={entry.text}
            block={item}
            sentences={sentences}
            current={current}
            highlight={highlight}
            style={{ fontSize, lineHeight }}
            onSentence={offset => {
              setFollowing(true);
              player.playFrom(offset);
            }}
          />
        )}
      />

      {playing && !following ? (
        <Pressable
          testID="back-to-current"
          style={[styles.pill, { bottom: 236 + insets.bottom }]}
          onPress={() => setFollowing(true)}>
          <ArrowDownIcon color={colors.accent} />
          <Text style={styles.pillText}>Back to current</Text>
        </Pressable>
      ) : null}

      {player.error ? <Text style={styles.error}>{player.error}</Text> : null}

      <View style={[styles.player, { paddingBottom: insets.bottom + 10 }]}>
        <Scrubber
          entry={entry}
          at={highlight?.start ?? entry.position}
          speed={speed}
          onSeek={fraction => {
            const index = sentenceIndexAt(sentences, Math.floor(fraction * entry.text.length));
            setFollowing(true);
            player.seek(sentences[index]?.start ?? 0);
          }}
        />
        <View style={styles.transport}>
          <Pressable testID="skip-back" accessibilityLabel="Previous sentence" style={styles.skip} onPress={() => player.skip(-1)}>
            <SkipIcon direction={-1} color={colors.text} />
          </Pressable>
          <Pressable
            testID="play-pause"
            accessibilityLabel={player.status === 'speaking' ? 'Pause' : 'Play'}
            disabled={!player.voice}
            style={[styles.big, !player.voice && styles.disabled]}
            onPress={() => {
              setFollowing(true);
              player.toggle();
            }}>
            {player.status === 'speaking' ? (
              <PauseIcon size={24} color={colors.onAccent} />
            ) : (
              <PlayIcon size={24} color={colors.onAccent} />
            )}
          </Pressable>
          <Pressable testID="skip-forward" accessibilityLabel="Next sentence" style={styles.skip} onPress={() => player.skip(1)}>
            <SkipIcon direction={1} color={colors.text} />
          </Pressable>
        </View>
        <View style={styles.row}>
          <Pressable
            testID="speed"
            accessibilityLabel={`Speed ${speed}×, tap to change`}
            style={[styles.chip, styles.speedChip]}
            onPress={() => player.setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}>
            <Text style={styles.chipText}>{speed}×</Text>
          </Pressable>
          <Pressable testID="voice-open" style={[styles.chip, styles.voiceChip]} onPress={onOpenVoices}>
            <Text style={styles.chipText} numberOfLines={1}>
              {player.voice ? player.voice.name : 'No voice'}
              {player.voice ? <Text style={styles.chipMuted}> · {QUALITY_LABEL[player.voice.quality]}</Text> : null}
            </Text>
          </Pressable>
          <SleepChip player={player} />
          <Pressable testID="more" accessibilityLabel="More" style={styles.chip} onPress={showMoreMenu}>
            <MoreIcon color={colors.text} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function Block(props: {
  text: string;
  block: TextRange;
  sentences: TextRange[];
  current: number;
  highlight: TextRange | null;
  style: { fontSize: number; lineHeight: number };
  onSentence: (offset: number) => void;
}) {
  const { text, block, sentences, current, highlight } = props;
  const first = sentenceIndexAt(sentences, block.start);
  const last = sentenceIndexAt(sentences, block.end - 1);
  const parts: React.ReactNode[] = [];
  for (let i = first; i <= last; i++) {
    const s = sentences[i];
    if (i > first) parts.push(text.slice(sentences[i - 1].end, s.start));
    const onPress = () => props.onSentence(s.start);
    if (i === current && highlight) {
      const w0 = Math.max(s.start, Math.min(highlight.start, s.end));
      const w1 = Math.max(w0, Math.min(highlight.end, s.end));
      parts.push(
        <Text key={i} style={styles.sentence} onPress={onPress}>
          {text.slice(s.start, w0)}
          {w1 > w0 ? (
            <Text style={styles.word} testID="reader-current-word">
              {text.slice(w0, w1)}
            </Text>
          ) : null}
          {text.slice(w1, s.end)}
        </Text>,
      );
    } else {
      parts.push(
        <Text key={i} style={current >= 0 && i < current ? styles.read : undefined} onPress={onPress}>
          {text.slice(s.start, s.end)}
        </Text>,
      );
    }
  }
  return <Text style={[styles.body, props.style]}>{parts}</Text>;
}

function Scrubber(props: { entry: LibraryEntry; at: number; speed: number; onSeek: (fraction: number) => void }) {
  const width = useRef(1);
  const [drag, setDrag] = useState<number | null>(null);
  const length = props.entry.text.length || 1;
  const fraction = drag ?? props.at / length;
  const total = minutesFor(length, props.speed);
  const toFraction = (x: number) => Math.max(0, Math.min(1, x / width.current));
  return (
    <View style={styles.scrub}>
      <Text style={styles.time}>{formatClock(total * fraction)}</Text>
      <View
        testID="scrubber"
        style={styles.trackHit}
        onLayout={(e: LayoutChangeEvent) => (width.current = e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={e => setDrag(toFraction(e.nativeEvent.locationX))}
        onResponderMove={e => setDrag(toFraction(e.nativeEvent.locationX))}
        onResponderRelease={() => {
          if (drag !== null) props.onSeek(drag);
          setDrag(null);
        }}
        onResponderTerminate={() => setDrag(null)}>
        <View style={styles.track}>
          <View style={[styles.trackFill, { width: `${fraction * 100}%` }]} />
        </View>
        <View style={[styles.thumb, { left: `${fraction * 100}%` }, drag !== null && styles.thumbActive]} />
      </View>
      <Text style={styles.time}>-{formatClock(total * (1 - fraction))}</Text>
    </View>
  );
}

function SleepChip({ player }: { player: Player }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (player.sleepAt === null) return;
    const id = setInterval(() => tick(n => n + 1), 30_000);
    return () => clearInterval(id);
  }, [player.sleepAt]);
  const left = player.sleepAt === null ? null : Math.max(1, Math.ceil((player.sleepAt - Date.now()) / 60_000));
  const choose = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'Pause reading after',
        options: [...SLEEP_MINUTES.map(m => `${m} minutes`), 'Off', 'Cancel'],
        cancelButtonIndex: SLEEP_MINUTES.length + 1,
      },
      index => {
        if (index < SLEEP_MINUTES.length) player.setSleepAt(Date.now() + SLEEP_MINUTES[index] * 60_000);
        else if (index === SLEEP_MINUTES.length) player.setSleepAt(null);
      },
    );
  return (
    <Pressable
      testID="sleep"
      accessibilityLabel={left ? `Sleep timer, ${left} minutes left` : 'Sleep timer'}
      style={[styles.chip, left !== null && styles.chipActive]}
      onPress={choose}>
      <Text style={[styles.chipText, left !== null && styles.chipActiveText]}>{left !== null ? `${left}m` : 'Sleep'}</Text>
    </Pressable>
  );
}

const COMING_LATER = [
  { label: 'Export audio', module: 'features/export/AudioExporter.ts' },
  { label: 'Translate', module: 'adapters/translation/Translator.ts' },
  { label: 'Pronunciation', module: 'features/pronunciation/PronunciationDictionary.ts' },
];

function showMoreMenu() {
  ActionSheetIOS.showActionSheetWithOptions(
    { options: [...COMING_LATER.map(c => `${c.label} (coming later)`), 'Cancel'], cancelButtonIndex: COMING_LATER.length },
    index => {
      const item = COMING_LATER[index];
      if (item) Alert.alert(item.label, `Not built yet. See src/${item.module}.`);
    },
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  nav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 4 },
  icon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  navTitle: { flex: 1, alignItems: 'center', minWidth: 0 },
  navTitleText: { fontSize: 15, fontWeight: '600', color: colors.text },
  navSub: { fontSize: 12, color: colors.muted, marginTop: 1 },
  aa: { fontSize: 17, fontWeight: '600', color: colors.text },
  page: { paddingHorizontal: 24, paddingTop: 10, paddingBottom: 40 },
  body: { fontFamily: readingFont, color: colors.reading, marginBottom: 18 },
  read: { color: colors.read },
  sentence: { backgroundColor: colors.sentenceHighlight, color: colors.text },
  word: { backgroundColor: colors.wordHighlight, color: colors.onAccent },
  pill: {
    position: 'absolute',
    alignSelf: 'center',
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    shadowColor: '#1C1B19',
    shadowOpacity: 0.14,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  pillText: { fontSize: 14, fontWeight: '600', color: colors.accent },
  error: { color: colors.danger, paddingHorizontal: 20, paddingVertical: 6 },
  player: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 12,
    paddingHorizontal: 20,
    shadowColor: '#1C1B19',
    shadowOpacity: 0.06,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: -1 },
  },
  scrub: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  time: { fontSize: 12, color: colors.muted, fontVariant: ['tabular-nums'], minWidth: 40, textAlign: 'center' },
  trackHit: { flex: 1, height: 32, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.track, overflow: 'hidden' },
  trackFill: { height: 4, backgroundColor: colors.accent },
  thumb: { position: 'absolute', width: 14, height: 14, borderRadius: 7, marginLeft: -7, backgroundColor: colors.accent },
  thumbActive: { width: 20, height: 20, borderRadius: 10, marginLeft: -10 },
  transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 28, marginTop: 6, marginBottom: 12 },
  skip: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  big: { width: 68, height: 68, borderRadius: 34, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.35 },
  row: { flexDirection: 'row', gap: 8 },
  chip: { height: 44, minWidth: 44, borderRadius: 12, backgroundColor: colors.chip, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  speedChip: { minWidth: 60 },
  voiceChip: { flex: 1, alignItems: 'flex-start' },
  chipText: { fontSize: 14, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] },
  chipMuted: { fontWeight: '500', color: colors.muted },
  chipActive: { backgroundColor: colors.accentSoft },
  chipActiveText: { color: colors.accent },
});
