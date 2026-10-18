import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Voice } from '../domain/types';
import type { SpeechEngine, SpeechSession } from '../adapters/speech/SpeechEngine';
import { groupByLanguage, voicesFor } from '../features/voices/voices';
import { CheckIcon, ChevronIcon, PlayIcon, StopIcon } from './icons';
import { colors } from './theme';

interface Props {
  visible: boolean;
  engine: SpeechEngine;
  voices: Voice[];
  /** Base language of the open document. */
  language: string;
  selectedId?: string;
  /** Spoken when previewing a voice; the sentence the reader is on. */
  sample: string;
  speed: number;
  onSelect: (voice: Voice) => void;
  onClose: () => void;
}

const BADGE = {
  premium: {
    label: 'PREMIUM',
    style: { backgroundColor: colors.inverse },
    text: { color: colors.onInverse },
  },
  enhanced: {
    label: 'ENHANCED',
    style: { backgroundColor: colors.accentSoft },
    text: { color: colors.accent },
  },
  default: {
    label: 'DEFAULT',
    style: { backgroundColor: colors.chip },
    text: { color: colors.muted },
  },
} as const;

export function VoicePicker(props: Props) {
  const { voices, language, selectedId } = props;
  const [expanded, setExpanded] = useState<string | null>(null);
  const preview = usePreview(props.engine);

  const own = useMemo(() => voicesFor(voices, language), [voices, language]);
  const others = useMemo(
    () => groupByLanguage(voices).filter(g => g.language !== language),
    [voices, language],
  );
  const languageName = own[0]?.languageName ?? language;

  const close = () => {
    preview.stop();
    setExpanded(null);
    props.onClose();
  };

  const row = (voice: Voice) => (
    <VoiceRow
      key={voice.id}
      voice={voice}
      selected={voice.id === selectedId}
      previewing={preview.voiceId === voice.id}
      onPreview={() => preview.toggle(voice, props.sample, props.speed)}
      onSelect={() => {
        preview.stop();
        props.onSelect(voice);
      }}
    />
  );

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}>
      <SafeAreaView style={styles.sheet} edges={['bottom']}>
        {/* iOS sheet grab indicator */}
        <View style={styles.handleContainer}>
          <View style={styles.handle} />
        </View>

        <View style={styles.head}>
          <View>
            <Text style={styles.h2}>Voice</Text>
            <Text style={styles.detected}>Document language: {languageName}</Text>
          </View>
          <Pressable
            testID="voice-picker-close"
            style={styles.done}
            onPress={close}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.label}>{languageName}</Text>
          {own.length ? (
            <View style={styles.group}>{own.map(row)}</View>
          ) : (
            <Text style={styles.none}>
              No {languageName} voices found on this device. You can download voices in iOS
              Settings below.
            </Text>
          )}

          {others.length ? <Text style={styles.label}>Other languages</Text> : null}
          <View style={styles.group}>
            {others.map(group => {
              const open = expanded === group.language;
              return (
                <View key={group.language}>
                  <Pressable
                    testID={`language-${group.language}`}
                    style={styles.other}
                    onPress={() => setExpanded(open ? null : group.language)}>
                    <Text style={styles.otherName}>{group.label}</Text>
                    <View style={styles.otherCount}>
                      <Text style={styles.muted}>
                        {group.voices.length} {group.voices.length === 1 ? 'voice' : 'voices'}
                      </Text>
                      <View style={open ? styles.chevronOpen : undefined}>
                        <ChevronIcon size={9} direction="right" color={colors.muted} />
                      </View>
                    </View>
                  </Pressable>
                  {open ? <View style={styles.nested}>{group.voices.map(row)}</View> : null}
                </View>
              );
            })}
          </View>

          <View style={styles.more}>
            <Text style={styles.moreTitle}>Upgrade voice quality</Text>
            <Text style={styles.moreText}>
              Download high-fidelity Enhanced and Premium voices for free in{' '}
              <Text style={styles.boldText}>Settings › Accessibility › Spoken Content › Voices</Text>.
              They will appear here automatically.
            </Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function VoiceRow(props: {
  voice: Voice;
  selected: boolean;
  previewing: boolean;
  onPreview: () => void;
  onSelect: () => void;
}) {
  const { voice } = props;
  const badge = BADGE[voice.quality];
  return (
    <Pressable
      testID={`voice-${voice.id}`}
      accessibilityState={{ selected: props.selected }}
      style={({ pressed }) => [
        styles.row,
        props.selected && styles.rowSelected,
        pressed && styles.pressed,
      ]}
      onPress={props.onSelect}>
      <Pressable
        testID={`preview-${voice.id}`}
        accessibilityLabel={
          props.previewing ? `Stop preview of ${voice.name}` : `Preview ${voice.name}`
        }
        style={[styles.preview, props.previewing && styles.previewOn]}
        onPress={props.onPreview}>
        {props.previewing ? (
          <StopIcon size={12} color={colors.accent} />
        ) : (
          <PlayIcon size={13} color={colors.accent} />
        )}
      </Pressable>
      <View style={styles.meta}>
        <Text style={[styles.name, props.selected && styles.nameSelected]}>
          {voice.name}
        </Text>
        <View style={styles.sub}>
          <View style={[styles.badge, badge.style]}>
            <Text style={[styles.badgeText, badge.text]}>{badge.label}</Text>
          </View>
          <Text style={styles.muted}>{voice.regionName}</Text>
        </View>
      </View>
      <View style={styles.check}>
        {props.selected ? <CheckIcon size={16} color={colors.accent} /> : null}
      </View>
    </Pressable>
  );
}

/** Speaks a short sample in one voice at a time; starting a new preview replaces the old one. */
function usePreview(engine: SpeechEngine) {
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const session = useRef<SpeechSession | null>(null);
  const run = useRef(0);

  const stop = () => {
    run.current++;
    session.current?.stop();
    session.current = null;
    setVoiceId(null);
  };

  const toggle = async (voice: Voice, sample: string, speed: number) => {
    if (voiceId === voice.id) return stop();
    const id = ++run.current;
    const done = () => id === run.current && setVoiceId(null);
    setVoiceId(voice.id);
    try {
      session.current = await engine.speak(
        sample,
        { voiceId: voice.id, speed },
        { onFinish: done, onCancel: done },
      );
    } catch {
      done();
    }
  };

  useEffect(() => () => session.current?.stop(), []);

  return { voiceId, toggle, stop };
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.background },
  handleContainer: {
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 4,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  h2: { fontSize: 24, fontWeight: '800', color: colors.text, letterSpacing: -0.4 },
  done: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneText: { fontSize: 15, fontWeight: '700', color: colors.accent },
  detected: { fontSize: 13, color: colors.muted, marginTop: 2 },
  body: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 36 },
  label: {
    paddingTop: 18,
    paddingBottom: 8,
    paddingHorizontal: 4,
    fontSize: 12,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  none: { paddingHorizontal: 8, fontSize: 14, lineHeight: 20, color: colors.muted },
  group: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.borderLight,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 64,
    paddingLeft: 10,
    paddingRight: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
  },
  rowSelected: {
    backgroundColor: '#FAFCFF',
  },
  pressed: { backgroundColor: colors.chip },
  preview: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.chip,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewOn: { backgroundColor: colors.accentSoft },
  meta: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, fontWeight: '600', color: colors.text, letterSpacing: -0.2 },
  nameSelected: { color: colors.accent, fontWeight: '700' },
  sub: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
  badgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  muted: { fontSize: 13, color: colors.muted },
  check: { width: 24, alignItems: 'center', justifyContent: 'center' },
  other: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
  },
  otherName: { fontSize: 15, fontWeight: '500', color: colors.text },
  otherCount: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chevronOpen: { transform: [{ rotate: '90deg' }] },
  nested: { backgroundColor: colors.background },
  more: {
    marginTop: 20,
    padding: 16,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  moreTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
  moreText: { fontSize: 13, lineHeight: 19, color: colors.muted, marginTop: 4 },
  boldText: { fontWeight: '600', color: colors.text },
});
