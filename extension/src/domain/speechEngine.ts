// Where a dub is made: on this computer (Chrome's own translator and Kokoro in the browser, no Readu server)
// or on the Readu server (better translation, timed to the speaker, but it needs the network and an account).
import type { LocalEngine, ReadOn } from './types';

/** This computer must read at least this many times faster than speech: there is a translation to make too,
 *  and the computer is doing other work. */
export const MIN_REALTIME = 1.5;

export type Engine = 'device' | 'server';

/**
 * The engine for a dub. "auto" reads on this computer once the voice is downloaded and the computer has
 * proved fast enough, and always when offline; otherwise on the server.
 */
export function chooseEngine(readOn: ReadOn, local: LocalEngine, online: boolean): Engine {
  if (readOn !== 'auto') return readOn;
  if (!local.installed) return 'server';
  if (!online) return 'device';
  return local.realtime !== undefined && local.realtime >= MIN_REALTIME ? 'device' : 'server';
}
