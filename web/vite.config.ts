import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const shared = fileURLToPath(new URL('../src', import.meta.url));
const platform = fileURLToPath(new URL('./src/platform', import.meta.url));

/** The mobile backend URL; in dev the browser reaches it through the proxy below until the server sends CORS headers. */
const BACKEND_URL = 'https://api.readu.tyvn.online';

/**
 * The shared code in ../src was written for React Native. Its native imports
 * resolve to browser versions here, the way `.web.ts` files would under
 * react-native-web: `react-native` and `react-native-fs` to stubs (the shared
 * modules fall back when a native module is missing), and the
 * track-player-based Reader to one built on an <audio> element.
 */
function webPlatform(): Plugin {
  const swaps: Record<string, string> = {
    [`${shared}/adapters/speech/playback.ts`]: `${platform}/playback.ts`,
  };
  return {
    name: 'readu-web-platform',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source === 'react-native') return `${platform}/reactNative.ts`;
      if (source === 'react-native-fs') return `${platform}/reactNativeFs.ts`;
      if (!importer?.startsWith(shared)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved && swaps[resolved.id] ? swaps[resolved.id] : null;
    },
  };
}

export default defineConfig({
  plugins: [webPlatform(), react()],
  resolve: {
    alias: { '@shared': shared },
    // The shared files sit outside web/, so without this they would pick up the mobile app's React.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: BACKEND_URL, changeOrigin: true, rewrite: path => path.replace(/^\/api/, '') },
    },
  },
  define: { __BACKEND_URL__: JSON.stringify(BACKEND_URL) },
});
