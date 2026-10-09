import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const bytesDigest = value => createHash('sha256').update(value).digest('hex');
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', {ignoreBOM: true});
export const normalize = key => decoder.decode(encoder.encode(key));
const key = i => `key-ascii-${i.toString().padStart(5, '0')}`;
const value = i => i * 0.25 - 512;
const freezeEntries = rows => Object.freeze(rows.map(row => Object.freeze(row)));

export function fixture(spec) {
  let entries = Array.from({length: spec.size}, (_, i) => [key(i), value(i)]);
  let seed = [];
  if (spec.shape === 'half-replace') {
    seed = entries;
    entries = Array.from({length: 4096}, (_, i) => { const index = i < 2048 ? i : i + 2048; return [key(index), value(index) + 10000]; });
  } else if (spec.shape === 'mixed') {
    entries = Array.from({length: 4096}, (_, i) => [
      `${i % 4 === 0 ? 'key-é-界-🙂-' : 'key-ascii-'}${i.toString().padStart(5, '0')}`,
      `${i % 4 === 1 ? 'value-é-界-🙂-' : 'value-ascii-'}${i.toString().padStart(5, '0')}`,
    ]);
  } else if (spec.operation === 'compact') seed = entries;
  entries = freezeEntries(entries); seed = freezeEntries(seed);
  const expected = new Map(seed.map(([k, v]) => [normalize(k), v]));
  if (spec.operation === 'setMany') for (const [k, v] of entries) expected.set(normalize(k), v);
  assert.equal(expected.size, spec.resultSize);
  const canonical = [...expected.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return {entries, seed, expected, inputDigest: digest([entries, seed]), expectedDigest: digest(canonical)};
}

export function setup(api, spec, input) {
  let root = spec.shape === 'sorted' ? new api.SharedSortedMap('number') : new api.SharedMap(spec.type);
  if (spec.shape === 'sorted') for (const [k, v] of input.seed) root = root.set(k, v);
  else if (input.seed.length) root = root.setMany(input.seed);
  assert.equal(root.size, input.seed.length);
  return root;
}

export function runBody(api, spec, root, input, operations) {
  let output = root, checksum = 0;
  if (spec.operation === 'setMany') {
    for (let i = 0; i < operations; i++) { output = root.setMany(input.entries); checksum += output.size; }
  } else {
    for (let i = 0; i < operations; i++) { output = api.compact(root); checksum += output.size; }
  }
  return {output, checksum};
}

export function validateMap(map, expected) {
  assert.equal(map.size, expected.size);
  const rows = [...map.entries()];
  assert.equal(rows.length, expected.size); assert.deepEqual(new Map(rows), expected);
  assert.deepEqual([...map.keys()], rows.map(([k]) => k));
  assert.deepEqual([...map.values()], rows.map(([, v]) => v));
  for (const [k, v] of expected) { assert.equal(map.has(k), true); assert.equal(map.get(k), v); }
  assert.equal(map.has('missing-fixture-key'), false); assert.equal(map.get('missing-fixture-key'), undefined);
  return digest(rows);
}

export function semanticState(root, output, retainedUsed) {
  return {
    sourceDescriptor: root.toWorkerData(), outputDescriptor: output.toWorkerData(),
    sourceUsed: root.arena.used, sourceCapacity: root.arena.memory.buffer.byteLength,
    sourceOldPrefix: bytesDigest(root.arena.buf.subarray(65536, retainedUsed)),
    outputUsed: output.arena.used, outputCapacity: output.arena.memory.buffer.byteLength,
    outputPayload: bytesDigest(output.arena.buf.subarray(65536, output.arena.used)),
    outputSharesSourceArena: output.arena === root.arena,
  };
}
