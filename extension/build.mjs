// Bundles each extension entry into dist/ and copies the static files next to them.
// Load dist/ in chrome://extensions with "Load unpacked".
import * as esbuild from 'esbuild';
import { copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('static', 'dist', { recursive: true });
// WebAssembly the offscreen document loads at run time: onnxruntime-web's threaded WebGPU/WASM runtime and sea-g2p.
mkdirSync('dist/ort', { recursive: true });
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) copyFileSync(`node_modules/onnxruntime-web/dist/${f}`, `dist/ort/${f}`);
copyFileSync('vendor/sea-g2p/sea_g2p_rs_bg.wasm', 'dist/sea_g2p_rs_bg.wasm');

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

// The offscreen document is an extension page, so it can be a module, which onnxruntime-web expects.
const offscreen = { ...options, entryPoints: { offscreen: 'src/offscreen.ts' }, format: 'esm' };

if (watch) {
  for (const o of [options, offscreen]) await (await esbuild.context(o)).watch();
} else {
  await Promise.all([esbuild.build(options), esbuild.build(offscreen)]);
}
