import RNFS from 'react-native-fs';
import { AudioCache, cacheName, SentenceAudio } from '../src/adapters/speech/audioCache';

jest.mock('react-native-fs', () => ({
  CachesDirectoryPath: '/caches',
  mkdir: jest.fn(async () => undefined),
  readDir: jest.fn(async () => []),
  writeFile: jest.fn(async () => undefined),
  unlink: jest.fn(async () => undefined),
}));

beforeEach(() => jest.clearAllMocks());

test('evicts the least recently used audio once over the limit', async () => {
  const cache = new AudioCache('/caches/speech', 100);
  await cache.put('a.mp3', new Uint8Array(40));
  await cache.put('b.mp3', new Uint8Array(40));
  expect(await cache.get('a.mp3')).toBe('/caches/speech/a.mp3');
  await cache.put('c.mp3', new Uint8Array(40));

  expect(RNFS.unlink).toHaveBeenCalledWith('/caches/speech/b.mp3');
  expect(await cache.get('b.mp3')).toBeNull();
  expect(await cache.get('a.mp3')).not.toBeNull();
  expect(await cache.get('c.mp3')).not.toBeNull();
});

test('keeps the newest file even when it alone is over the limit', async () => {
  const cache = new AudioCache('/caches/speech', 10);
  await cache.put('big.mp3', new Uint8Array(50));
  expect(RNFS.unlink).not.toHaveBeenCalled();
  expect(await cache.get('big.mp3')).not.toBeNull();
});

test('a sentence is synthesized once, then served from the cache', async () => {
  const cache = new AudioCache('/caches/speech', 1000);
  const synthesize = jest.fn(async () => new Uint8Array([1, 2, 3]).buffer);
  const audio = new SentenceAudio(cache, synthesize);

  const first = await audio.path('Xin chào.', 'voice', 1);
  const second = await audio.path('Xin chào.', 'voice', 1);
  expect(first).toBe(second);
  expect(synthesize).toHaveBeenCalledTimes(1);
});

test('cache names differ by voice, speed and text', () => {
  const names = new Set([
    cacheName('a', '1.00', 'hello'),
    cacheName('b', '1.00', 'hello'),
    cacheName('a', '1.50', 'hello'),
    cacheName('a', '1.00', 'hallo'),
  ]);
  expect(names.size).toBe(4);
});
