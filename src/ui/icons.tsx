import React from 'react';
import { StyleSheet, View } from 'react-native';

/* eslint-disable react-native/no-inline-styles -- every icon style is computed from its size prop. */
// Drawn with pure Views and borders so the app needs no SVG or icon-font dependency.

interface IconProps {
  size?: number;
  color: string;
}

export function PlayIcon({ size = 20, color }: IconProps) {
  return (
    <View
      style={{
        marginLeft: size * 0.15,
        borderTopWidth: size / 2,
        borderBottomWidth: size / 2,
        borderLeftWidth: size * 0.85,
        borderTopColor: 'transparent',
        borderBottomColor: 'transparent',
        borderLeftColor: color,
      }}
    />
  );
}

export function PauseIcon({ size = 20, color }: IconProps) {
  const bar = { width: size * 0.3, height: size, borderRadius: size * 0.08, backgroundColor: color };
  return (
    <View style={[styles.row, { gap: size * 0.25 }]}>
      <View style={bar} />
      <View style={bar} />
    </View>
  );
}

export function StopIcon({ size = 14, color }: IconProps) {
  return <View style={{ width: size, height: size, borderRadius: size * 0.18, backgroundColor: color }} />;
}

export function SkipIcon({ size = 22, color, direction }: IconProps & { direction: -1 | 1 }) {
  const triangle = {
    borderTopWidth: size / 2,
    borderBottomWidth: size / 2,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    ...(direction === 1
      ? { borderLeftWidth: size * 0.7, borderLeftColor: color }
      : { borderRightWidth: size * 0.7, borderRightColor: color }),
  };
  const bar = { width: size * 0.14, height: size, borderRadius: 1.5, backgroundColor: color };
  return (
    <View style={[styles.row, { gap: size * 0.08 }]}>
      {direction === -1 ? <View style={bar} /> : null}
      <View style={triangle} />
      {direction === 1 ? <View style={bar} /> : null}
    </View>
  );
}

export function PlusIcon({ size = 18, color }: IconProps) {
  const t = Math.max(2.2, size * 0.14);
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={[
          styles.abs,
          {
            top: (size - t) / 2,
            left: 0,
            width: size,
            height: t,
            backgroundColor: color,
            borderRadius: t / 2,
          },
        ]}
      />
      <View
        style={[
          styles.abs,
          {
            left: (size - t) / 2,
            top: 0,
            height: size,
            width: t,
            backgroundColor: color,
            borderRadius: t / 2,
          },
        ]}
      />
    </View>
  );
}

export function ChevronIcon({
  size = 12,
  color,
  direction,
}: IconProps & { direction: 'left' | 'right' | 'up' | 'down' }) {
  const rotation =
    direction === 'left'
      ? '45deg'
      : direction === 'right'
      ? '-135deg'
      : direction === 'up'
      ? '135deg'
      : '-45deg';
  return (
    <View
      style={{
        width: size,
        height: size,
        borderLeftWidth: 2.2,
        borderBottomWidth: 2.2,
        borderColor: color,
        transform: [{ rotate: rotation }],
        marginLeft: direction === 'left' ? size * 0.35 : 0,
        marginRight: direction === 'right' ? size * 0.35 : 0,
        marginTop: direction === 'up' ? size * 0.25 : 0,
        marginBottom: direction === 'down' ? size * 0.25 : 0,
      }}
    />
  );
}

export function CheckIcon({ size = 16, color }: IconProps) {
  return (
    <View
      style={{
        width: size,
        height: size * 0.55,
        borderLeftWidth: 2.5,
        borderBottomWidth: 2.5,
        borderColor: color,
        transform: [{ rotate: '-45deg' }],
        marginBottom: size * 0.2,
      }}
    />
  );
}

export function SearchIcon({ size = 16, color }: IconProps) {
  const ring = size * 0.72;
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={[
          styles.abs,
          {
            width: ring,
            height: ring,
            borderRadius: ring / 2,
            borderWidth: 2,
            borderColor: color,
          },
        ]}
      />
      <View
        style={[
          styles.abs,
          {
            width: size * 0.38,
            height: 2,
            backgroundColor: color,
            right: -size * 0.04,
            bottom: size * 0.12,
            transform: [{ rotate: '45deg' }],
          },
        ]}
      />
    </View>
  );
}

export function MoreIcon({ size = 18, color }: IconProps) {
  const dot = { width: size * 0.22, height: size * 0.22, borderRadius: size, backgroundColor: color };
  return (
    <View style={[styles.row, { gap: size * 0.2 }]}>
      <View style={dot} />
      <View style={dot} />
      <View style={dot} />
    </View>
  );
}

export function ArrowDownIcon({ size = 12, color }: IconProps) {
  return (
    <View style={{ alignItems: 'center', width: size, height: size }}>
      <View style={{ width: 2, height: size * 0.8, backgroundColor: color, borderRadius: 1 }} />
      <View
        style={[
          styles.abs,
          {
            bottom: size * 0.1,
            width: size * 0.55,
            height: size * 0.55,
            borderRightWidth: 2,
            borderBottomWidth: 2,
            borderColor: color,
            transform: [{ rotate: '45deg' }],
          },
        ]}
      />
    </View>
  );
}

export function ClockIcon({ size = 14, color }: IconProps) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 1.6,
        borderColor: color,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <View
        style={[
          styles.abs,
          {
            width: 1.5,
            height: size * 0.35,
            backgroundColor: color,
            top: size * 0.18,
            borderRadius: 1,
          },
        ]}
      />
      <View
        style={[
          styles.abs,
          {
            width: size * 0.25,
            height: 1.5,
            backgroundColor: color,
            top: size * 0.44,
            left: size * 0.42,
            borderRadius: 1,
          },
        ]}
      />
    </View>
  );
}

export function BookOpenIcon({ size = 20, color }: IconProps) {
  const half = size * 0.45;
  return (
    <View style={[styles.row, { gap: 2, alignItems: 'center' }]}>
      <View
        style={{
          width: half,
          height: size * 0.7,
          borderWidth: 1.8,
          borderColor: color,
          borderTopRightRadius: 2,
          borderBottomRightRadius: 2,
          borderLeftWidth: 2.2,
        }}
      />
      <View
        style={{
          width: half,
          height: size * 0.7,
          borderWidth: 1.8,
          borderColor: color,
          borderTopLeftRadius: 2,
          borderBottomLeftRadius: 2,
          borderRightWidth: 2.2,
        }}
      />
    </View>
  );
}

export function CloseIcon({ size = 16, color }: IconProps) {
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={[
          styles.abs,
          {
            width: size,
            height: 2,
            backgroundColor: color,
            transform: [{ rotate: '45deg' }],
            borderRadius: 1,
          },
        ]}
      />
      <View
        style={[
          styles.abs,
          {
            width: size,
            height: 2,
            backgroundColor: color,
            transform: [{ rotate: '-45deg' }],
            borderRadius: 1,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  abs: { position: 'absolute' },
});
