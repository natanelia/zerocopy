import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const study = {
  id: 'map-foreach-20261108',
  baseline: '0ac8a005268335a6116f025e75f670b5cee6843e',
  changedSources: ['shared-map.ts'],
  cases: [
    { name: 'number-4096', role: 'target', type: 'number', size: 4096, repetitions: 64 },
    { name: 'number-65536', role: 'target', type: 'number', size: 65536, repetitions: 8 },
    { name: 'number-overlay-4096', role: 'target', type: 'number', size: 4096, repetitions: 64, overlay: true },
    { name: 'number-64', role: 'small-map control', type: 'number', size: 64, repetitions: 2048 },
    { name: 'boolean-4096', role: 'type control', type: 'boolean', size: 4096, repetitions: 64 },
    { name: 'string-1024', role: 'type control', type: 'string', size: 1024, repetitions: 128 },
    { name: 'json-256', role: 'type control', type: 'object', size: 256, repetitions: 256 },
    { name: 'unicode-4096', role: 'key control', type: 'number', size: 4096, repetitions: 64, unicode: true },
    { name: 'entries-4096', role: 'unchanged-method control', type: 'number', size: 4096, repetitions: 64, operation: 'entries' },
    { name: 'get-4096', role: 'unchanged-method control', type: 'number', size: 4096, repetitions: 128, operation: 'get' },
  ],
  pilotCases: ['number-4096', 'number-overlay-4096', 'number-64', 'string-1024', 'entries-4096', 'get-4096'],
  aaCases: ['number-4096', 'string-1024', 'entries-4096', 'get-4096'],
  timing: 'Complete public scan with a reusable callback consuming every key length and value. Full key/value/order verification and unchanged published bytes are checked outside timing after every batch.',
};

export async function createWorkload(root, spec) {
  const { SharedMap, resetMap, getWorkerData } = await import(pathToFileURL(join(root, 'dist', 'shared.js')));
  resetMap();
  const native = new Map(), entries = [];
  for (let i = 0; i < spec.size; i++) {
    const id = (i * 17) % spec.size;
    const key = spec.unicode ? `道路/🙂/${id}` : `row/${String(id).padStart(6, '0')}`;
    const value = spec.type === 'number' ? id * 0.5 : spec.type === 'boolean' ? !!(id % 2)
      : spec.type === 'string' ? `name/${id}/🙂` : { id, label: `record-${id}`, child: { value: id * 3 } };
    entries.push([key, value]); native.set(key, value);
  }
  let map = new SharedMap(spec.type).setMany(entries);
  if (spec.overlay) {
    for (let i = 0; i < 113; i++) {
      const key = entries[(i * 37) % entries.length][0];
      map = map.set(key, -i - 1); native.set(key, -i - 1);
    }
    map = map.delete(entries[191][0]); native.delete(entries[191][0]);
    map = map.set('added', 12345); native.set('added', 12345);
  }
  const expected = [...map.entries()];
  assert.equal(expected.length, native.size);
  assert.deepEqual(new Map(expected), native);
  const payload = getWorkerData({ map }, { copy: false });
  const source = payload.arenas[0], beforeBytes = Buffer.from(new Uint8Array(source.memory.buffer, 65536, source.used - 65536));
  const magnitude = spec.type === 'number' ? value => value : spec.type === 'boolean' ? value => +value
    : spec.type === 'string' ? value => value.length : value => value.id;
  const expectedSum = expected.reduce((sum, [key, value]) => sum + magnitude(value) + key.length, 0);
  const keys = expected.map(([key]) => key);
  let sum = 0, count = 0;
  const visit = spec.type === 'number' ? (value, key) => { count++; sum += value + key.length; }
    : spec.type === 'boolean' ? (value, key) => { count++; sum += +value + key.length; }
    : spec.type === 'string' ? (value, key) => { count++; sum += value.length + key.length; }
    : (value, key) => { count++; sum += value.id + key.length; };
  const scan = spec.operation === 'entries' ? () => { for (const [key, value] of map.entries()) visit(value, key); }
    : spec.operation === 'get' ? () => { for (const key of keys) visit(map.get(key), key); }
    : () => map.forEach(visit);
  function collect() { const output = []; map.forEach((value, key) => output.push([key, value])); return output; }
  function checkInvariant() {
    assert.deepEqual(collect(), expected);
    assert.deepEqual([...map.entries()], expected);
    const now = getWorkerData({ map }, { copy: false }).arenas[0];
    assert.equal(now.used, source.used);
    assert.ok(Buffer.from(now.memory.buffer, 65536, now.used - 65536).equals(beforeBytes));
  }
  checkInvariant();
  return {
    operation() { sum = 0; count = 0; scan(); return sum + count; },
    verify(result) { assert.equal(result, expectedSum + expected.length); },
    checkInvariant,
    expectedDigest: createHash('sha256').update(JSON.stringify(expected)).digest('hex'),
    fixture: { size: map.size, type: spec.type, operation: spec.operation ?? 'forEach', overlay: !!spec.overlay, unicode: !!spec.unicode },
  };
}
