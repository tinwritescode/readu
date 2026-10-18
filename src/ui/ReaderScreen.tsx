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
import {
  ArrowDownIcon,
  ChevronIcon,
  ClockIcon,
  MoreIcon,
  PauseIcon,
  PlayIcon,
  SkipIcon,
} from './icons';
import { colors, readingFont } from './theme';

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const FONT_SIZES = [16, 18, 20, 23, 26];
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

export function ReaderScreen({
  entry,
  player,
  speed,
  fontSize,
  onFontSize,
  onBack,
  onOpenVoices,
}: Props) {
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

  const lineHeight = Math.round(fontSize * 1.68);
  const remaining = minutesFor(entry.text.length - (highlight?.start ?? entry.position), speed);

  const cycleFontSize = () => {
    const nextIdx = (FONT_SIZES.indexOf(fontSize) + 1) % FONT_SIZES.length;
    onFontSize(FONT_SIZES[nextIdx]);
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {/* Top Navigation Bar */}
      <View style={styles.nav}>
        <Pressable
          testID="reader-back"
          accessibilityLabel="Back to library"
          style={({ pressed }) => [styles.navButton, pressed && styles.navButtonPressed]}
          onPress={onBack}>
          <ChevronIcon direction="left" size={13} color={colors.text} />
        </Pressable>

        <View style={styles.navTitle}>
          <Text style={styles.navTitleText} numberOfLines={1}>
            {entry.title}
          </Text>
          <View style={styles.metaBadge}>
            <ClockIcon size={11} color={colors.muted} />
            <Text style={styles.navSub}>{formatMinutesLeft(remaining)}</Text>
          </View>
        </View>

        <Pressable
          testID="font-size"
          accessibilityLabel="Text size"
          style={({ pressed }) => [styles.navButton, pressed && styles.navButtonPressed]}
          onPress={cycleFontSize}>
          <Text style={styles.aa}>Aa</Text>
        </Pressable>
      </View>

      {/* Reading Canvas */}
      <FlatList
        ref={list}
        testID="reader-text"
        data={blocks}
        extraData={`${current}:${highlight?.start}:${highlight?.end}:${fontSize}`}
        keyExtractor={b => String(b.start)}
        contentContainerStyle={[styles.page, { paddingBottom: 220 + insets.bottom }]}
        onScrollBeginDrag={() => setFollowing(false)}
        onScrollToIndexFailed={info => {
          list.current?.scrollToOffset({
            offset: info.averageItemLength * info.index,
            animated: false,
          });
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

      {/* Floating "Back to current" pill */}
      {playing && !following ? (
        <Pressable
          testID="back-to-current"
          style={[styles.followPill, { bottom: 180 + insets.bottom }]}
          onPress={() => {
            setFollowing(true);
            scrollToCurrent(true);
          }}>
          <ArrowDownIcon size={12} color={colors.accent} />
          <Text style={styles.followPillText}>Follow along</Text>
        </Pressable>
      ) : null}

      {player.error ? <Text style={styles.error}>{player.error}</Text> : null}

      {/* Floating Island Player Dock */}
      <View
        style={[
          styles.playerDock,
          {
            bottom: Math.max(insets.bottom, 12),
          },
        ]}>
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
          <Pressable
            testID="skip-back"
            accessibilityLabel="Previous sentence"
            style={({ pressed }) => [styles.skipButton, pressed && styles.skipButtonPressed]}
            onPress={() => player.skip(-1)}>
            <SkipIcon direction={-1} size={20} color={colors.text} />
          </Pressable>

          <Pressable
            testID="play-pause"
            accessibilityLabel={player.status === 'speaking' ? 'Pause' : 'Play'}
            disabled={!player.voice}
            style={({ pressed }) => [
              styles.heroPlayButton,
              !player.voice && styles.disabled,
              pressed && styles.heroPlayButtonPressed,
            ]}
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

          <Pressable
            testID="skip-forward"
            accessibilityLabel="Next sentence"
            style={({ pressed }) => [styles.skipButton, pressed && styles.skipButtonPressed]}
            onPress={() => player.skip(1)}>
            <SkipIcon direction={1} size={20} color={colors.text} />
          </Pressable>
        </View>

        {/* Secondary controls row */}
        <View style={styles.controlsRow}>
          <Pressable
            testID="speed"
            accessibilityLabel={`Speed ${speed}×, tap to change`}
            style={({ pressed }) => [
              styles.chip,
              styles.speedChip,
              pressed && styles.chipPressed,
            ]}
            onPress={() => player.setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}>
            <Text style={styles.chipText}>{speed}×</Text>
          </Pressable>

          <Pressable
            testID="voice-open"
            style={({ pressed }) => [
              styles.chip,
              styles.voiceChip,
              pressed && styles.chipPressed,
            ]}
            onPress={onOpenVoices}>
            <Text style={styles.chipText} numberOfLines={1}>
              {player.voice ? player.voice.name : 'Choose voice'}
              {player.voice ? (
                <Text style={styles.chipMuted}> · {QUALITY_LABEL[player.voice.quality]}</Text>
              ) : null}
            </Text>
          </Pressable>

          <SleepChip player={player} />

          <Pressable
            testID="more"
            accessibilityLabel="More options"
            style={({ pressed }) => [styles.chip, styles.moreChip, pressed && styles.chipPressed]}
            onPress={showMoreMenu}>
            <MoreIcon size={16} color={colors.text} />
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
        <Text
          key={i}
          style={current >= 0 && i < current ? styles.read : undefined}
          onPress={onPress}>
          {text.slice(s.start, s.end)}
        </Text>,
      );
    }
  }

  return <Text style={[styles.body, props.style]}>{parts}</Text>;
}

function Scrubber(props: {
  entry: LibraryEntry;
  at: number;
  speed: number;
  onSeek: (fraction: number) => void;
}) {
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
        <View
          style={[
            styles.thumb,
            { left: `${fraction * 100}%` },
            drag !== null && styles.thumbActive,
          ]}
        />
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

  const left =
    player.sleepAt === null
      ? null
      : Math.max(1, Math.ceil((player.sleepAt - Date.now()) / 60_000));

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
      style={({ pressed }) => [
        styles.chip,
        styles.sleepChip,
        left !== null && styles.chipActive,
        pressed && styles.chipPressed,
      ]}
      onPress={choose}>
      <Text style={[styles.chipText, left !== null && styles.chipActiveText]}>
        {left !== null ? `${left}m` : 'Sleep'}
      </Text>
    </Pressable>
  );
}

const COMING_LATER = [
  { label: 'Export audio (M4A)', module: 'features/export/AudioExporter.ts' },
  { label: 'On-device translation', module: 'adapters/translation/Translator.ts' },
  { label: 'Pronunciation dictionary', module: 'features/pronunciation/PronunciationDictionary.ts' },
];

function showMoreMenu() {
  ActionSheetIOS.showActionSheetWithOptions(
    {
      options: [...COMING_LATER.map(c => `${c.label} (coming soon)`), 'Cancel'],
      cancelButtonIndex: COMING_LATER.length,
    },
    index => {
      const item = COMING_LATER[index];
      if (item) Alert.alert(item.label, `Under construction. See src/${item.module}.`);
    },
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 10,
  },
  navButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#191816',
    shadowOpacity: 0.04,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  navButtonPressed: {
    backgroundColor: colors.chip,
  },
  navTitle: {
    flex: 1,
    alignItems: 'center',
    minWidth: 0,
  },
  navTitleText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    letterSpacing: -0.2,
  },
  metaBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  navSub: {
    fontSize: 12,
    color: colors.muted,
    fontVariant: ['tabular-nums'],
  },
  aa: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
  page: {
    paddingHorizontal: 24,
    paddingTop: 16,
  },
  body: {
    fontFamily: readingFont,
    color: colors.reading,
    marginBottom: 20,
    letterSpacing: 0.1,
  },
  read: {
    color: colors.read,
  },
  sentence: {
    backgroundColor: colors.sentenceHighlight,
    color: colors.text,
    borderRadius: 6,
  },
  word: {
    backgroundColor: colors.wordHighlight,
    color: colors.wordHighlightText,
    borderRadius: 4,
    overflow: 'hidden',
    paddingHorizontal: 2,
    fontWeight: '600',
  },
  followPill: {
    position: 'absolute',
    alignSelf: 'center',
    height: 38,
    paddingHorizontal: 16,
    borderRadius: 19,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    shadowColor: '#191816',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  followPillText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent,
  },
  error: {
    color: colors.danger,
    paddingHorizontal: 20,
    paddingVertical: 6,
    textAlign: 'center',
  },
  playerDock: {
    position: 'absolute',
    left: 16,
    right: 16,
    backgroundColor: colors.surface,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingTop: 14,
    paddingBottom: 14,
    paddingHorizontal: 18,
    shadowColor: '#191816',
    shadowOpacity: 0.09,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  scrub: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  time: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.muted,
    fontVariant: ['tabular-nums'],
    minWidth: 42,
    textAlign: 'center',
  },
  trackHit: {
    flex: 1,
    height: 28,
    justifyContent: 'center',
  },
  track: {
    height: 5,
    borderRadius: 2.5,
    backgroundColor: colors.track,
    overflow: 'hidden',
  },
  trackFill: {
    height: 5,
    backgroundColor: colors.accent,
    borderRadius: 2.5,
  },
  thumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    marginLeft: -7,
    backgroundColor: colors.accent,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  thumbActive: {
    width: 22,
    height: 22,
    borderRadius: 11,
    marginLeft: -11,
  },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 28,
    marginTop: 8,
    marginBottom: 14,
  },
  skipButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.chip,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipButtonPressed: {
    opacity: 0.7,
  },
  heroPlayButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.accent,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  heroPlayButtonPressed: {
    transform: [{ scale: 0.96 }],
  },
  disabled: {
    opacity: 0.35,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  chip: {
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.chip,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipPressed: {
    opacity: 0.7,
  },
  speedChip: {
    minWidth: 54,
  },
  voiceChip: {
    flex: 1,
    alignItems: 'flex-start',
  },
  sleepChip: {
    minWidth: 52,
  },
  moreChip: {
    width: 40,
    paddingHorizontal: 0,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  chipMuted: {
    fontWeight: '500',
    color: colors.muted,
  },
  chipActive: {
    backgroundColor: colors.accentSoft,
  },
  chipActiveText: {
    color: colors.accent,
  },
});
