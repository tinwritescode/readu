/**
 * `react-native` for the shared code. It only reaches for NativeModules, and
 * every shared module treats a missing native module as "not on this device".
 */
export const NativeModules: Record<string, undefined> = {};
