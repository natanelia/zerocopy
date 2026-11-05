import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const study = {
  id: 'redux-sequence-reads-20261105',
  baseline: 'b07bffe073a7f7d60f1dd7731358c16d1075eb45',
  changedSources: ['arena.ts', 'shared-stack.ts', 'shared-queue.ts', 'redux-codec.ts', 'redux-sequence-codec.ts'],
  // One predeclared diagnostic A/A study for adverse pilot fallback signals.
  // Its ratios are reported separately, never used to adjust the A/B result.
  aaCases: ['stack-256-object-control', 'queue-256-string-control'],
  cases: [
    { name: 'stack-4096-number-encode', role: 'target', kind: 'SharedStack', type: 'number', count: 4096, drop: 0, method: 'encode', repetitions: 64 },
    { name: 'stack-65537-number-encode', role: 'target', kind: 'SharedStack', type: 'number', count: 65537, drop: 0, method: 'encode', repetitions: 8 },
    { name: 'queue-4096-number-offset37', role: 'target', kind: 'SharedQueue', type: 'number', count: 4096, drop: 37, method: 'encode', repetitions: 64 },
    { name: 'queue-4096-boolean-offset1057', role: 'target', kind: 'SharedQueue', type: 'boolean', count: 4096, drop: 1057, method: 'encode', repetitions: 64 },
    { name: 'stack-4096-number-stringify', role: 'target', kind: 'SharedStack', type: 'number', count: 4096, drop: 0, method: 'stringify', repetitions: 32 },
    { name: 'queue-8-number-control', role: 'small fallback control', kind: 'SharedQueue', type: 'number', count: 8, drop: 0, method: 'encode', repetitions: 2048 },
    { name: 'stack-empty-control', role: 'empty fallback control', kind: 'SharedStack', type: 'number', count: 0, drop: 0, method: 'encode', repetitions: 8192 },
    { name: 'stack-256-object-control', role: 'object fallback control', kind: 'SharedStack', type: 'object', count: 256, drop: 0, method: 'encode', repetitions: 16 },
    { name: 'queue-256-string-control', role: 'string fallback control', kind: 'SharedQueue', type: 'string', count: 256, drop: 37, method: 'encode', repetitions: 64 },
    { name: 'shared-map-1024-control', role: 'unchanged control', kind: 'SharedMap', type: 'number', count: 1024, drop: 0, method: 'encode', repetitions: 64 },
  ],
};

// Independent wire-format oracle. It does not call any implementation encoder.
function encoded(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['n', 'NaN'];
    if (!Number.isFinite(value)) return ['n', value > 0 ? 'Infinity' : '-Infinity'];
    return Object.is(value, -0) ? ['n', '-0'] : value;
  }
  if (Array.isArray(value)) return ['a', value.map(encoded)];
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  return ['o', Object.keys(value).map(key => [key, encoded(value[key])])];
}
function valueAt(type, index) {
  if (type === 'number') return index * 0.25 - 100;
  if (type === 'boolean') return index % 3 === 0;
  if (type === 'string') return `value/${index}/é/🙂/\0`;
  return { id: index, child: [index % 3 === 0, { text: `row/${index}/🙂` }] };
}

export async function createWorkload(directory, spec) {
  const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  const R = await import(pathToFileURL(join(directory, 'dist/redux.js')));
  const codec = R.createZerocopyCodec(), total = spec.count + spec.drop;
  const input = Array.from({ length: total }, (_, i) => valueAt(spec.type, i));
  let source = new S[spec.kind](spec.type), items;
  if (spec.kind === 'SharedMap') {
    const valuesByKey = new Map(input.map((value, i) => [`key/${i}`, value]));
    source = source.setMany([...valuesByKey]);
    // Map traversal order is deliberately unspecified. Obtain only its order
    // through the public key iterator; each value still comes from the oracle.
    const keys = [...source.keys()];
    assert.equal(keys.length, valuesByKey.size); assert.equal(new Set(keys).size, valuesByKey.size);
    for (const key of keys) assert.ok(valuesByKey.has(key));
    items = keys.map(key => [key, encoded(valuesByKey.get(key))]);
  } else {
    for (const value of input) source = spec.kind === 'SharedStack' ? source.push(value) : source.enqueue(value);
    for (let i = 0; i < spec.drop; i++) source = spec.kind === 'SharedStack' ? source.pop() : source.dequeue();
    const ordered = (spec.kind === 'SharedStack' ? [...input].reverse() : input).slice(spec.drop);
    items = ordered.map(encoded);
  }
  assert.equal(source.size, spec.count); assert.ok(Object.isFrozen(source));
  const envelope = { $zerocopyRedux: 1, value: ['c', spec.kind, spec.type, null, items] };
  const expectedText = JSON.stringify(envelope), expected = spec.method === 'stringify' ? expectedText : envelope;
  const originalPacket = S.getWorkerData({ source }, { copy: true });
  assert.equal(originalPacket.arenas.length, 1);
  const originalArena = originalPacket.arenas[0], descriptor = source.toWorkerData();
  const memory = S.getWorkerData({ source }, { copy: false }).arenas[0].memory;
  assert.ok(memory instanceof WebAssembly.Memory);
  const sharedBytes = new Uint8Array(memory.buffer, 0, originalArena.used);
  return {
    operation: () => codec[spec.method](source),
    verify(result) {
      assert.deepEqual(result, expected);
      if (spec.method === 'encode') assert.ok(Object.isFrozen(result));
    },
    expectedDigest: createHash('sha256').update(expectedText).digest('hex'),
    checkInvariant() {
      assert.equal(source.size, spec.count); assert.ok(Object.isFrozen(source));
      assert.deepEqual(source.toWorkerData(), descriptor);
      assert.equal(S.getWorkerData({ source }, { copy: false }).arenas[0].used, originalArena.used);
      assert.deepEqual(sharedBytes, originalArena.copy);
    },
    fixture: { kind: spec.kind, type: spec.type, count: spec.count, dropped: spec.drop, originalCount: total,
      method: spec.method, bytes: originalArena.used,
      values: spec.type === 'object' || spec.type === 'string' ? 'decoded caches warmed by normal public calls' : 'primitive',
      oracle: spec.kind === 'SharedMap' ? 'native values with public key order' : 'independent ordered wire values' },
  };
}
