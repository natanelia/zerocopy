import { expect, it } from 'vitest';
import { SharedMap, compact } from '../dist/shared.js';
import { createSharedState } from '../dist/worker.js';
function result(worker: Worker, version: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Missing browser version ${version}`)), 10000);
    const onMessage = (event: MessageEvent) => { if (event.data.result && event.data.version === version) finish(undefined, event.data); };
    const onError = (event: ErrorEvent) => finish(new Error(event.message));
    const finish = (error?: Error, value?: any) => {
      clearTimeout(timer); worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError);
      error ? reject(error) : resolve(value);
    };
    worker.addEventListener('message', onMessage); worker.addEventListener('error', onError);
  });
}
it('auto-publishes to an isolated browser module worker without resending known memory', async () => {
  expect(crossOriginIsolated).toBe(true);
  const worker = new Worker(new URL('./session-worker.ts', import.meta.url), { type: 'module' });
  const state = createSharedState({ map: new SharedMap('number').set('seed', 1) }, { channel: 'browser-proof', copy: false });
  try {
    const initial = result(worker, 0); await state.connect(worker);
    expect((await initial).memoryHandles).toBeGreaterThan(0);
    const next = result(worker, 1);
    state.update('map', map => map.setMany(Array.from({ length: 10000 }, (_, i) => [`n${i}`, i])));
    state.update('map', map => map.set('seed', 2));
    expect(await next).toMatchObject({ seed: 2, oldSeed: 1, last: 9999, memoryHandles: 0, readOnly: true, isolated: true });
    const moved = result(worker, 2); state.update('map', map => compact(map));
    expect(await moved).toMatchObject({ seed: 2, oldSeed: 1, last: 9999, memoryHandles: 1, readOnly: true });
  } finally { state.dispose(); worker.terminate(); }
}, 20000);
