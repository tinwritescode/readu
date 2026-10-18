// What both speech models share in the offscreen document: onnxruntime-web's WebAssembly runtime, set up once,
// and one sea-g2p instance, which keeps its 63 MB dictionary in memory for the life of the page.
import * as ort from 'onnxruntime-web/webgpu';
import initSeaG2p, { SeaG2p } from '../../../vendor/sea-g2p/sea_g2p_rs.js';

/** onnxruntime-web reads this when it first starts. VieNeu runs many small graphs, which more threads slow down. */
export function setUpOrt() {
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency, 6) : 1;
}

let g2p: Promise<SeaG2p> | null = null;

/** The shared sea-g2p, built from the dictionary the first time. */
export function seaG2p(dict: () => Promise<ArrayBuffer>): Promise<SeaG2p> {
  g2p ??= (async () => {
    const [bytes] = await Promise.all([dict(), initSeaG2p({ module_or_path: chrome.runtime.getURL('sea_g2p_rs_bg.wasm') })]);
    return new SeaG2p(new Uint8Array(bytes));
  })().catch(e => {
    g2p = null;
    throw e;
  });
  return g2p;
}
