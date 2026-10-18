// Bundles each extension entry into dist/ and copies the static files next to them.
// Load dist/ in chrome://extensions with "Load unpacked".
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('static', 'dist', { recursive: true });

const options = {
  entryPoints: {
    background: 'src/background.ts',
    content: 'src/content.ts',
    'main-world': 'src/mainWorld.ts',
    popup: 'src/popup.ts',
  },
  bundle: true,
  // Content scripts cannot import modules, so every entry is one self-contained file.
  format: 'iife',
  target: 'chrome120',
  outdir: 'dist',
  tsconfig: 'tsconfig.json',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
