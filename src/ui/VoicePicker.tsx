import React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Voice } from '../domain/types';
import { CheckIcon, PlayIcon, StopIcon } from './icons';
import { colors } from './theme';

interface Props {
  visible: boolean;
  /** Empty until the voice list has loaded. */
  voices: Voice[];
  selectedId?: string;
  previewingId: string | null;
  onPreview: (voice: Voice) => void;
  onSelect: (voice: Voice) => void;
  onClose: () => void;
}

const GENDER = { female: 'Female', male: 'Male' } as const;

export function VoicePicker(props: Props) {
  const { voices, selectedId, previewingId } = props;
  const sorted = [...voices].sort((a, b) => a.name.localeCompare(b.name, 'vi'));

  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      <SafeAreaView style={styles.sheet} edges={['bottom']}>
        <View style={styles.handleContainer}>
          <View style={styles.handle} />
        </View>

        <View style={styles.head}>
          <View>
            <Text style={styles.h2}>Voice</Text>
            <Text style={styles.detected}>Vietnamese voices from the server</Text>
          </View>
          <Pressable testID="voice-picker-close" style={styles.done} onPress={props.onClose}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          {sorted.length === 0 ? (
            <View style={styles.loading}>
              <ActivityIndicator />
              <Text style={styles.muted}>Loading voices…</Text>
            </View>
          ) : (
            <View style={styles.group}>
              {sorted.map(voice => (
                <VoiceRow
                  key={voice.id}
                  voice={voice}
                  selected={voice.id === selectedId}
                  previewing={previewingId === voice.id}
                  onPreview={() => props.onPreview(voice)}
                  onSelect={() => props.onSelect(voice)}
                />
              ))}
            </View>
          )}
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
  return (
    <Pressable
      testID={`voice-${voice.id}`}
      accessibilityState={{ selected: props.selected }}
      style={({ pressed }) => [styles.row, props.selected && styles.rowSelected, pressed && styles.pressed]}
      onPress={props.onSelect}>
      <Pressable
        testID={`preview-${voice.id}`}
        accessibilityLabel={props.previewing ? `Stop preview of ${voice.name}` : `Preview ${voice.name}`}
        style={[styles.preview, props.previewing && styles.previewOn]}
        onPress={props.onPreview}>
        {props.previewing ? (
          <StopIcon size={12} color={colors.accent} />
        ) : (
          <PlayIcon size={13} color={colors.accent} />
        )}
      </Pressable>
      <View style={styles.meta}>
        <Text style={[styles.name, props.selected && styles.nameSelected]}>{voice.name}</Text>
        <Text style={styles.muted}>{GENDER[voice.gender as keyof typeof GENDER] ?? voice.gender}</Text>
      </View>
      <View style={styles.check}>{props.selected ? <CheckIcon size={16} color={colors.accent} /> : null}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.background },
  handleContainer: { alignItems: 'center', paddingTop: 8, paddingBottom: 4 },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border },
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
  loading: { alignItems: 'center', gap: 10, paddingTop: 40 },
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
  rowSelected: { backgroundColor: '#FAFCFF' },
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
  muted: { fontSize: 13, color: colors.muted, marginTop: 3 },
  check: { width: 24, alignItems: 'center', justifyContent: 'center' },
});
