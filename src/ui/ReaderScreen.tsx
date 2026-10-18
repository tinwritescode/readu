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
import { formatClock, minutesFor } from '../features/reader/estimate';
import { sentenceIndexAt, textBlocks } from '../features/reader/textRanges';
import type { Player } from '../features/reader/usePlayer';
import { ArrowDownIcon, ChevronIcon, MoreIcon, PauseIcon, PlayIcon, SkipIcon } from './icons';
import { colors, fonts, labelText } from './theme';

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const FONT_SIZES = [16, 18, 20, 23, 26];
const SLEEP_MINUTES = [15, 30, 45, 60];

interface Props {
  entry: LibraryEntry;
  player: Player;
  speed: number;
  fontSize: number;
  onFontSize: (size: number) => void;
  onBack: () => void;
  onOpenVoices: () => void;
  onLogout: () => void;
}

export function ReaderScreen({ entry, player, speed, fontSize, onFontSize, onBack, onOpenVoices, onLogout }: Props) {
  const insets = useSafeAreaInsets();
  const list = useRef<FlatList<TextRange>>(null);
  const [following, setFollowing] = useState(true);

  const { sentences, highlight } = player;
  const blocks = useMemo(() => textBlocks(entry.text, sentences), [entry.text, sentences]);
  const current = highlight ? sentenceIndexAt(sentences, highlight.start) : -1;
  const currentBlock = highlight && blocks.length ? sentenceIndexAt(blocks, highlight.start) : -1;
  const playing = player.status !== 'idle';

  const scrollToCurrent = (animated = true) => {
    if (currentBlock >= 0) {
      list.current?.scrollToIndex({ index: currentBlock, viewPosition: 0.3, animated });
    }
  };

  useEffect(() => {
    if (following) scrollToCurrent();
  }, [currentBlock, following]); // eslint-disable-line react-hooks/exhaustive-deps

  const lineHeight = Math.round(fontSize * 1.65);
  const cycleFontSize = () => onFontSize(FONT_SIZES[(FONT_SIZES.indexOf(fontSize) + 1) % FONT_SIZES.length]);

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.nav}>
        <Pressable
          testID="reader-back"
          accessibilityLabel="Back to library"
          hitSlop={8}
          style={({ pressed }) => [styles.navSide, pressed && styles.pressed]}
          onPress={onBack}>
          <ChevronIcon direction="left" size={10} color={colors.muted} />
          <Text style={labelText}>Library</Text>
        </Pressable>
        <Text style={styles.navTitle} numberOfLines={1}>
          {entry.title}
        </Text>
        <Pressable
          testID="font-size"
          accessibilityLabel="Text size"
          hitSlop={8}
          style={({ pressed }) => [styles.navSide, styles.navRight, pressed && styles.pressed]}
          onPress={cycleFontSize}>
          <Text style={styles.aa}>Aa</Text>
        </Pressable>
      </View>

      <FlatList
        ref={list}
        testID="reader-text"
        style={styles.flex}
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
            style={{ fontSize, lineHeight }}
            onSentence={offset => {
              setFollowing(true);
              player.playFrom(offset);
            }}
          />
        )}
      />

      {player.error ? <Text style={styles.error}>{player.error}</Text> : null}

      <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, 12) + 4 }]}>
        {playing && !following ? (
          <Pressable
            testID="back-to-current"
            style={styles.followPill}
            onPress={() => {
              setFollowing(true);
              scrollToCurrent(true);
            }}>
            <ArrowDownIcon size={11} color={colors.accent} />
            <Text style={[labelText, styles.accentText]}>Follow along</Text>
          </Pressable>
        ) : null}

        <Scrubber
          entry={entry}
          at={highlight?.start ?? entry.position}
          speed={speed}
          snap={fraction => {
            const sentence = sentences[sentenceIndexAt(sentences, Math.floor(fraction * entry.text.length))];
            return sentence ? sentence.start / entry.text.length : fraction;
          }}
          onSeek={fraction => {
            const index = sentenceIndexAt(sentences, Math.floor(fraction * entry.text.length));
            setFollowing(true);
            player.seek(sentences[index]?.start ?? 0);
          }}
        />

        <View style={styles.controls}>
          <View style={styles.side}>
            <Pressable
              testID="speed"
              accessibilityLabel={`Speed ${speed}×, tap to change`}
              hitSlop={10}
              onPress={() => player.setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}>
              <Text style={[labelText, styles.ink]}>{speed}×</Text>
            </Pressable>
            <SleepLabel player={player} />
          </View>

          <View style={styles.transport}>
            <Pressable
              testID="skip-back"
              accessibilityLabel="Previous sentence"
              hitSlop={10}
              style={({ pressed }) => pressed && styles.pressed}
              onPress={() => player.skip(-1)}>
              <SkipIcon direction={-1} size={17} color={colors.text} />
            </Pressable>
            <Pressable
              testID="play-pause"
              accessibilityLabel={player.status === 'speaking' ? 'Pause' : 'Play'}
              style={({ pressed }) => [styles.play, pressed && styles.pressed]}
              onPress={() => {
                setFollowing(true);
                player.toggle();
              }}>
              {player.status === 'speaking' ? (
                <PauseIcon size={18} color={colors.background} />
              ) : (
                <PlayIcon size={18} color={colors.background} />
              )}
            </Pressable>
            <Pressable
              testID="skip-forward"
              accessibilityLabel="Next sentence"
              hitSlop={10}
              style={({ pressed }) => pressed && styles.pressed}
              onPress={() => player.skip(1)}>
              <SkipIcon direction={1} size={17} color={colors.text} />
            </Pressable>
          </View>

          <View style={[styles.side, styles.sideRight]}>
            <Pressable testID="voice-open" hitSlop={10} style={styles.voice} onPress={onOpenVoices}>
              <Text style={[labelText, styles.ink]} numberOfLines={1}>
                {player.voice ? player.voice.name : 'Voice'}
              </Text>
            </Pressable>
            <Pressable testID="more" accessibilityLabel="More options" hitSlop={10} onPress={() => showMoreMenu(onLogout)}>
              <MoreIcon size={14} color={colors.text} />
            </Pressable>
          </View>
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
  style: { fontSize: number; lineHeight: number };
  onSentence: (offset: number) => void;
}) {
  const { text, block, sentences, current } = props;
  const first = sentenceIndexAt(sentences, block.start);
  const last = sentenceIndexAt(sentences, block.end - 1);
  const parts: React.ReactNode[] = [];

  for (let i = first; i <= last; i++) {
    const s = sentences[i];
    if (i > first) parts.push(text.slice(sentences[i - 1].end, s.start));
    const onPress = () => props.onSentence(s.start);
    const style = i === current ? styles.sentence : current >= 0 && i < current ? styles.read : undefined;
    parts.push(
      <Text key={i} style={style} onPress={onPress}>
        {text.slice(s.start, s.end)}
      </Text>,
    );
  }

  return <Text style={[styles.body, props.style]}>{parts}</Text>;
}

/** While dragging, the thumb sits on the sentence the release will jump to. */
function Scrubber(props: {
  entry: LibraryEntry;
  at: number;
  speed: number;
  snap: (fraction: number) => number;
  onSeek: (fraction: number) => void;
}) {
  const width = useRef(1);
  const [drag, setDrag] = useState<number | null>(null);
  const length = props.entry.text.length || 1;
  const fraction = drag === null ? props.at / length : props.snap(drag);
  const total = minutesFor(length, props.speed);
  const toFraction = (x: number) => Math.max(0, Math.min(1, x / width.current));

  return (
    <View>
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
      <View style={styles.times}>
        <Text style={styles.time}>{formatClock(total * fraction)}</Text>
        <Text style={styles.time}>{formatClock(total * (1 - fraction))} LEFT</Text>
      </View>
    </View>
  );
}

function SleepLabel({ player }: { player: Player }) {
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
        if (index < SLEEP_MINUTES.length) {
          player.setSleepAt(Date.now() + SLEEP_MINUTES[index] * 60_000);
        } else if (index === SLEEP_MINUTES.length) {
          player.setSleepAt(null);
        }
      },
    );

  return (
    <Pressable
      testID="sleep"
      accessibilityLabel={left ? `Sleep timer, ${left} minutes left` : 'Sleep timer'}
      hitSlop={10}
      onPress={choose}>
      <Text style={[labelText, left !== null ? styles.accentText : styles.ink]}>
        {left !== null ? `Sleep ${left}m` : 'Sleep'}
      </Text>
    </Pressable>
  );
}

const COMING_LATER = [
  { label: 'Export audio (M4A)', module: 'features/export/AudioExporter.ts' },
  { label: 'On-device translation', module: 'adapters/translation/Translator.ts' },
  { label: 'Pronunciation dictionary', module: 'features/pronunciation/PronunciationDictionary.ts' },
];

function showMoreMenu(onLogout: () => void) {
  const options = [...COMING_LATER.map(c => `${c.label} (coming soon)`), 'Log out', 'Cancel'];
  ActionSheetIOS.showActionSheetWithOptions(
    {
      options,
      cancelButtonIndex: options.length - 1,
      destructiveButtonIndex: options.length - 2,
    },
    index => {
      if (index === COMING_LATER.length) return onLogout();
      const item = COMING_LATER[index];
      if (item) Alert.alert(item.label, `Under construction. See src/${item.module}.`);
    },
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  pressed: { opacity: 0.5 },
  disabled: { opacity: 0.35 },
  ink: { color: colors.text },
  accentText: { color: colors.accent },
  nav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, height: 44, gap: 12 },
  navSide: { flexDirection: 'row', alignItems: 'center', gap: 5, minWidth: 72 },
  navRight: { justifyContent: 'flex-end' },
  navTitle: { flex: 1, textAlign: 'center', fontFamily: fonts.readItalic, fontSize: 15, color: colors.text },
  aa: { fontFamily: fonts.read, fontSize: 17, color: colors.text },
  page: { paddingHorizontal: 24, paddingTop: 18, paddingBottom: 48 },
  body: { fontFamily: fonts.read, color: colors.reading, marginBottom: 18 },
  read: { color: colors.read },
  sentence: { backgroundColor: colors.sentenceHighlight },
  error: { color: colors.danger, paddingHorizontal: 20, paddingVertical: 6, textAlign: 'center' },
  dock: {
    borderTopWidth: 1.5,
    borderTopColor: colors.text,
    backgroundColor: colors.background,
    paddingTop: 12,
    paddingHorizontal: 20,
    gap: 10,
  },
  followPill: {
    position: 'absolute',
    alignSelf: 'center',
    top: -48,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  trackHit: { height: 20, justifyContent: 'center' },
  track: { height: 2, backgroundColor: colors.border },
  trackFill: { height: 2, backgroundColor: colors.text },
  thumb: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    marginLeft: -5,
    backgroundColor: colors.text,
  },
  thumbActive: { width: 18, height: 18, borderRadius: 9, marginLeft: -9 },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  time: {
    fontFamily: fonts.label,
    fontSize: 11,
    letterSpacing: 0.6,
    color: colors.muted,
    fontVariant: ['tabular-nums'],
  },
  controls: { flexDirection: 'row', alignItems: 'center', minHeight: 52 },
  side: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 16 },
  sideRight: { justifyContent: 'flex-end' },
  voice: { flexShrink: 1 },
  transport: { flexDirection: 'row', alignItems: 'center', gap: 22 },
  play: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
