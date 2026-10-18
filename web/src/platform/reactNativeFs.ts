/**
 * `react-native-fs` for the shared code. The web keeps audio in the Cache API
 * (see audioCache.ts here); this stub only lets shared helpers such as
 * `cacheName` load. Any call into it is a bug, so each one throws.
 */
const unavailable = new Proxy(
  {},
  {
    get(_target, key) {
      return () => {
        throw new Error(`react-native-fs.${String(key)} is not available on the web`);
      };
    },
  },
);

export default unavailable as Record<string, never>;
