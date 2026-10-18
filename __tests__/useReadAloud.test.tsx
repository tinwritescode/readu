import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import type {
  SpeechCallbacks,
  SpeechEngine,
} from '../src/adapters/speech/SpeechEngine';
import { useReadAloud } from '../src/features/reader/useReadAloud';

function fakeEngine() {
  const calls: Array<{ text: string; callbacks: SpeechCallbacks }> = [];
  const engine: SpeechEngine = {
    id: 'fake',
    listVoices: async () => [],
    speak: async (text, _options, callbacks) => {
      calls.push({ text, callbacks });
      return { pause: jest.fn(), resume: jest.fn(), stop: jest.fn() };
    },
  };
  return { engine, calls };
}

function renderHook(engine: SpeechEngine) {
  const result: { current: ReturnType<typeof useReadAloud> | null } = { current: null };
  function Probe() {
    result.current = useReadAloud(engine);
    return null;
  }
  ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<Probe />);
  });
  return result as { current: ReturnType<typeof useReadAloud> };
}

const text = 'Hello there. General Kenobi.';

test('reports word ranges in offsets of the full text when resuming mid-text', async () => {
  const { engine, calls } = fakeEngine();
  const hook = renderHook(engine);
  const from = text.indexOf('General');

  await ReactTestRenderer.act(() => hook.current.play(text, { speed: 1 }, from));
  expect(calls[0].text).toBe('General Kenobi.');

  ReactTestRenderer.act(() => calls[0].callbacks.onRange?.({ start: 8, end: 14 }));
  expect(text.slice(hook.current.word!.start, hook.current.word!.end)).toBe('Kenobi');
  expect(hook.current.status).toBe('speaking');

  ReactTestRenderer.act(() => calls[0].callbacks.onFinish?.());
  expect(hook.current.status).toBe('idle');
  expect(hook.current.word).toBeNull();
});

test('ignores events from a run that was replaced', async () => {
  const { engine, calls } = fakeEngine();
  const hook = renderHook(engine);

  await ReactTestRenderer.act(() => hook.current.play(text, { speed: 1 }));
  await ReactTestRenderer.act(() => hook.current.play(text, { speed: 2 }, 6));

  ReactTestRenderer.act(() => calls[0].callbacks.onCancel?.());
  expect(hook.current.status).toBe('speaking');

  ReactTestRenderer.act(() => calls[1].callbacks.onRange?.({ start: 0, end: 5 }));
  expect(text.slice(hook.current.word!.start, hook.current.word!.end)).toBe('there');
});
