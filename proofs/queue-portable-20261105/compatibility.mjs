import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expectedEnvelope } from './fixtures.mjs';

const root = resolve(process.env.QUEUE_PORTABLE_BUILD ?? fileURLToPath(new URL('../../', import.meta.url)));
const phase = process.argv[2];
if (phase !== 'pre-import' && phase !== 'post-import') {
  for (const when of ['pre-import', 'post-import']) for (const method of ['peek', 'dequeue', 'isEmpty', 'decode']) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), when, method], {
      encoding: 'utf8', env: { ...process.env, QUEUE_PORTABLE_BUILD: root }, timeout: 30000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout || String(child.error));
    process.stdout.write(child.stdout);
  }
} else {
  const api = await import(pathToFileURL(join(root, 'dist/shared.js')).href);
  let redux = phase === 'post-import' ? await import(pathToFileURL(join(root, 'dist/redux.js')).href) : undefined;
  const Arena = new api.SharedQueue('number').arena.constructor;
  let queue = new api.SharedQueue('number', 0, 0, 0, undefined, new Arena());
  const values = Array.from({ length: 65 }, (_, i) => i + .25);
  for (const value of values) queue = queue.enqueue(value);
  const method = process.argv[3], target = method === 'decode' ? Arena.prototype : api.SharedQueue.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(target, method);
  const isEmpty = Object.getOwnPropertyDescriptor(api.SharedQueue.prototype, 'isEmpty');
  let getters = 0, calls = 0;
  if (method === 'decode') {
    const replacement = function (type, raw) {
      calls++;
      Object.defineProperty(api.SharedQueue.prototype, 'isEmpty', { ...isEmpty, get() { return true; } });
      return descriptor.value.call(this, type, raw) + 1000;
    };
    Object.defineProperty(target, method, { configurable: true, get() { getters++; return replacement; } });
  } else if (method === 'isEmpty') Object.defineProperty(target, method, {
    ...descriptor, get() { getters++; return this.size <= 32; },
  });
  else {
    const replacement = function () { calls++; const value = descriptor.value.call(this); return method === 'peek' ? value + 1000 : value; };
    Object.defineProperty(api.SharedQueue.prototype, method, { configurable: true, get() { getters++; return replacement; } });
  }
  try {
    redux ??= await import(pathToFileURL(join(root, 'dist/redux.js')).href);
    const expected = method === 'decode' ? [values[0] + 1000] : method === 'isEmpty' ? values.slice(0, 33) : method === 'peek' ? values.map(value => value + 1000) : values;
    assert.deepEqual(redux.createZerocopyCodec().encode(queue), expectedEnvelope('queue', 'number', expected));
    assert.equal(getters, method === 'decode' ? 1 : method === 'isEmpty' ? 34 : 65);
    assert.equal(calls, method === 'decode' ? 1 : method === 'isEmpty' ? 0 : 65);
    assert.equal('hasDefaultQueueReads' in api, false); assert.equal('hasDefaultQueueReads' in redux, false);
    assert.equal('hasDefaultArenaDecode' in api, false); assert.equal('hasDefaultArenaDecode' in redux, false);
    console.log(JSON.stringify({ ok: true, phase, method, getters, calls, exportedHelper: false }));
  } finally { Object.defineProperty(target, method, descriptor); Object.defineProperty(api.SharedQueue.prototype, 'isEmpty', isEmpty); }
}
