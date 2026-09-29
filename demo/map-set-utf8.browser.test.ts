import { expect, test } from 'vitest';
import { SharedMap, getWorkerData, resetMap } from '../dist/shared.js';

test('direct shared UTF-8 writes preserve old versions and match independent worker reads', async () => {
  resetMap(); const before = new SharedMap('string').set('路', '初');
  expect(before.get('路')).toBe('初');
  const large = '🙂'.repeat(12289);
  const after = before.set('路', '🙂界').set('alias', '\ud800').set('large', large);
  expect(after.get('alias')).toBe('\ufffd');
  const worker = new Worker(new URL('./map-set-utf8-worker.ts', import.meta.url), { type: 'module' });
  try {
    const result = await new Promise<any>((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage(getWorkerData({ before, after }, { copy: false }));
    });
    expect(result).toEqual({ before: '初', after: '🙂界', replacement: '\ufffd', large, frozen: true });
    expect(before.get('路')).toBe('初');
  } finally { worker.terminate(); }
}, 20000);
