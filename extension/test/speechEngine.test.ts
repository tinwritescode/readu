import { describe, expect, it } from 'vitest';
import { chooseEngine } from '../src/domain/speechEngine';

const fast = { installed: true, downloadBytes: 0, realtime: 3 };
const slow = { installed: true, downloadBytes: 0, realtime: 1.1 };
const missing = { installed: false, downloadBytes: 390e6 };

describe('chooseEngine', () => {
  it('follows an explicit choice', () => {
    expect(chooseEngine('device', missing, true)).toBe('device');
    expect(chooseEngine('server', fast, true)).toBe('server');
  });
  it('reads on this computer when it is installed and fast enough, or offline', () => {
    expect(chooseEngine('auto', fast, true)).toBe('device');
    expect(chooseEngine('auto', slow, true)).toBe('server');
    expect(chooseEngine('auto', slow, false)).toBe('device');
    expect(chooseEngine('auto', { installed: true, downloadBytes: 0 }, true)).toBe('server');
    expect(chooseEngine('auto', missing, false)).toBe('server');
  });
});

describe('chooseEngine with a VieNeu voice', () => {
  it('reads on this computer whatever the setting, since the server has only Kokoro', () => {
    const missing = { installed: false, downloadBytes: 1 };
    expect(chooseEngine('server', missing, true, 'vieneu')).toBe('device');
    expect(chooseEngine('auto', missing, true, 'vieneu')).toBe('device');
  });
});
