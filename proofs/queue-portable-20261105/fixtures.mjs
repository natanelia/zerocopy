import assert from 'node:assert/strict';

export const CASES = Object.freeze([
  { name: 'queue-empty', kind: 'queue', type: 'number', created: 0, offset: 0, operation: 'encode', role: 'control' },
  { name: 'queue-one', kind: 'queue', type: 'number', created: 1, offset: 0, operation: 'encode', role: 'control' },
  { name: 'queue-tail31', kind: 'queue', type: 'number', created: 31, offset: 0, operation: 'encode', role: 'control' },
  { name: 'queue-offset34', kind: 'queue', type: 'number', created: 65, offset: 31, operation: 'encode', role: 'boundary' },
  { name: 'queue-number4096', kind: 'queue', type: 'number', created: 4096, offset: 0, operation: 'encode', role: 'target' },
  { name: 'queue-stringify4096', kind: 'queue', type: 'number', created: 4096, offset: 0, operation: 'stringify', role: 'target' },
  { name: 'queue-unicode1024', kind: 'queue', type: 'string', created: 1024, offset: 0, operation: 'encode', role: 'warm-decode' },
  { name: 'queue-json256', kind: 'queue', type: 'object', created: 256, offset: 0, operation: 'encode', role: 'warm-decode' },
  { name: 'stack-number4096-control', kind: 'stack', type: 'number', created: 4096, offset: 0, operation: 'encode', role: 'control' },
  { name: 'plain-array4096-control', kind: 'plain', type: 'number', created: 4096, offset: 0, operation: 'encode', role: 'control' },
].map(Object.freeze));

export function numberValue(i) {
  return i % 64 === 17 ? NaN : i % 64 === 29 ? Infinity : i % 64 === 43 ? -Infinity : i % 64 === 57 ? -0 : i + .25;
}
export function inputValues(workload) {
  return Array.from({ length: workload.created }, (_, i) => workload.type === 'string'
    ? `row-${i}-Résumé-界🙂-${i % 3 ? 'suffix' : '\ufeff\0'}`
    : workload.type === 'object' ? { i, text: `row-${i}-界🙂`, active: !!(i & 1), detail: { points: [[i, -i], [i + .5, i + 1]], labels: ['a', 'b'] } }
    : numberValue(i));
}
// Independent input-model encoder for this fixed matrix. No shared collection
// is traversed to build its expected output or to prime another read path.
export function logical(value) {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['n', 'NaN'];
    if (!Number.isFinite(value)) return ['n', value > 0 ? 'Infinity' : '-Infinity'];
    if (Object.is(value, -0)) return ['n', '-0'];
  }
  if (value === undefined) return ['u'];
  if (Array.isArray(value)) return ['a', value.map(logical)];
  if (value !== null && typeof value === 'object') return ['o', Object.keys(value).map(key => [key, logical(value[key])])];
  return value;
}
export function expectedEnvelope(kind, type, values) {
  return { $zerocopyRedux: 1, value: kind === 'plain' ? logical(values)
    : ['c', kind === 'stack' ? 'SharedStack' : 'SharedQueue', type, null, values.map(logical)] };
}
function compare(actual, expected) {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual)); assert.equal(actual.length, expected.length);
    for (let i = 0; i < expected.length; i++) { assert.ok(Object.hasOwn(actual, i)); compare(actual[i], expected[i]); }
  } else if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object' && !Array.isArray(actual));
    const keys = Object.keys(expected); assert.equal(Object.keys(actual).length, keys.length);
    for (const key of keys) { assert.ok(Object.hasOwn(actual, key)); compare(actual[key], expected[key]); }
  } else assert.ok(Object.is(actual, expected));
}
function slots(value) {
  if (Array.isArray(value)) return value.length + value.reduce((sum, child) => sum + slots(child), 0);
  if (value !== null && typeof value === 'object') return Object.values(value).reduce((sum, child) => sum + 1 + slots(child), 0);
  return 0;
}

export function makeFixture(api, redux, workload) {
  const values = inputValues(workload), Arena = new api.SharedQueue('number').arena.constructor;
  let input, arena, expectedValues;
  if (workload.kind === 'plain') { input = values; expectedValues = values; }
  else {
    arena = new Arena();
    if (workload.kind === 'stack') {
      input = new api.SharedStack(workload.type, 0, 0, undefined, arena);
      for (const value of values) input = input.push(value);
      expectedValues = [...values].reverse();
    } else {
      input = new api.SharedQueue(workload.type, 0, 0, 0, undefined, arena);
      for (const value of values) input = input.enqueue(value);
      for (let i = 0; i < workload.offset; i++) input = input.dequeue();
      expectedValues = values.slice(workload.offset);
    }
  }
  if (workload.type === 'object') expectedValues = JSON.parse(JSON.stringify(expectedValues));
  const encoded = expectedEnvelope(workload.kind, workload.type, expectedValues);
  const expected = workload.operation === 'stringify' ? JSON.stringify(encoded) : encoded;
  const codec = redux.createZerocopyCodec(), materializedSlots = Math.max(1, slots(encoded));
  const materialize = () => workload.operation === 'stringify' ? codec.stringify(input) : codec.encode(input);
  const verify = actual => { compare(actual, expected); if (workload.operation === 'encode') assert.ok(Object.isFrozen(actual)); };
  const state = () => arena ? { used: arena.used, bytes: arena.memory.buffer.byteLength,
    memory: new Uint8Array(arena.memory.buffer, 0, arena.used) } : undefined;
  return { expected, materialize, verify, state, input,
    outputElements: expectedValues.length, materializedSlots,
    maxRepeat: Math.min(65536, Math.max(1, Math.floor(1048576 / materializedSlots))) };
}
