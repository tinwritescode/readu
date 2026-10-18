// The service worker's side of the offscreen document (offscreen.ts), which reads Vietnamese on this computer.
import type { Request } from './messages';

export const OFFSCREEN = 'readu-offscreen';
export type OffscreenRequest = Extract<Request, { type: 'localEngine' | 'localInstall' | 'localBenchmark' | 'localSpeak' }>;

let creating: Promise<void> | null = null;

async function ensureDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Runs the Kokoro and VieNeu speech models with WebAssembly and WebGPU to read Vietnamese on this computer.',
    })
    .finally(() => (creating = null));
  await creating;
}

/** Sends a request to the offscreen document, opening it first, and returns its data or throws its error. */
export async function toOffscreen(req: OffscreenRequest): Promise<unknown> {
  await ensureDocument();
  const reply = (await chrome.runtime.sendMessage({ target: OFFSCREEN, req })) as { ok: boolean; data?: unknown; error?: string };
  if (!reply?.ok) throw new Error(reply?.error ?? 'no reply from the offscreen document');
  return reply.data;
}
