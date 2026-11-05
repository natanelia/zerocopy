import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const CASES = Object.freeze([
  { name: 'map-unicode-short', collection: 'SharedMap', type: 'number', count: 1024, keys: 'short' },
  { name: 'map-unicode-medium', collection: 'SharedMap', type: 'number', count: 256, keys: 'medium' },
  { name: 'map-unicode-one', collection: 'SharedMap', type: 'number', count: 1, keys: 'short' },
  { name: 'map-unicode-replace', collection: 'SharedMap', type: 'number', count: 1024, keys: 'short', replace: true },
  { name: 'ordered-unicode-short', collection: 'SharedOrderedMap', type: 'number', count: 1024, keys: 'short' },
  { name: 'sorted-unicode-short', collection: 'SharedSortedMap', type: 'number', count: 1024, keys: 'short' },
  { name: 'map-ascii-control', collection: 'SharedMap', type: 'number', count: 1024, keys: 'ascii' },
  { name: 'map-long-fitting-control', collection: 'SharedMap', type: 'number', count: 16, keys: 'long-fitting' },
  { name: 'map-oversized-control', collection: 'SharedMap', type: 'number', count: 8, keys: 'oversized' },
  { name: 'map-json-control', collection: 'SharedMap', type: 'object', count: 256, keys: 'short' },
]);
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const reset = { SharedMap: 'resetMap', SharedOrderedMap: 'resetOrderedMap', SharedSortedMap: 'resetSortedMap' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected) => typeof expected === 'number' ? Object.is(actual, expected) : JSON.stringify(actual) === JSON.stringify(expected);

export function makeFixture(api, spec) {
  const keys = Array.from({ length: spec.count }, (_, i) => {
    const suffix = `${(i * 4051) % 4099}`.padStart(4, '0');
    if (spec.keys === 'ascii') return `road/${suffix}/position`;
    if (spec.keys === 'medium') return `界${suffix}/` + '路é'.repeat(128) + '/🙂';
    if (spec.keys === 'long-fitting') return `é${suffix}/` + 'é'.repeat(16382);
    if (spec.keys === 'oversized') return `界${suffix}/` + '界'.repeat(16385);
    return `路/${suffix}/café🙂`;
  });
  const normalized = keys.map(key => decoder.decode(encoder.encode(key)));
  assert.equal(new Set(normalized).size, spec.count);
  const keyBytes = keys.map(key => encoder.encode(key));
  if (spec.keys === 'long-fitting') assert.ok(keys.every((key, i) => key.length > 16381 && keyBytes[i].length <= 49144));
  else if (spec.keys === 'oversized') assert.ok(keys.every((key, i) => key.length <= 49144 && keyBytes[i].length > 49144));
  else assert.ok(keys.every(key => key.length <= 16381));
  const values = keys.map((_, i) => spec.type === 'object'
    ? { id: i, label: `value/${i}/界🙂`, active: i % 2 === 0, nested: [i * .25, -i, null] }
    : i + .25);
  const oldValues = keys.map((_, i) => -i - .5);
  const middleIndex = spec.count >>> 1;
  const model = new Map(normalized.map((key, i) => [key, values[i]]));
  const baseModel = new Map(spec.replace ? normalized.map((key, i) => [key, oldValues[i]]) : []);
  const middleModel = new Map(baseModel);
  for (let i = 0; i <= middleIndex; i++) middleModel.set(normalized[i], values[i]);
  const sortedKeys = [...model.keys()].sort((a, b) => Buffer.compare(encoder.encode(a), encoder.encode(b)));
  const sortedMiddle = [...middleModel.keys()].sort((a, b) => Buffer.compare(encoder.encode(a), encoder.encode(b)));
  const expectedDigest = sha(JSON.stringify({ model: [...model], base: [...baseModel], middle: [...middleModel], sortedKeys }));
  const estimatedAllocationBytes = keyBytes.reduce((sum, bytes, i) => sum + bytes.length + 512
    + (spec.type === 'number' ? 8 : encoder.encode(JSON.stringify(values[i])).length), 0);
  let base, before, prefixDigest;
  const state = snapshot => {
    const payload = api.getWorkerData({ snapshot }, { copy: false });
    assert.equal(payload.arenas.length, 1);
    const arena = payload.arenas[0];
    return { memory: arena.memory, used: arena.used, capacity: arena.memory.buffer.byteLength };
  };
  const verifyMap = (map, expected, order) => {
    check(Object.isFrozen(map) && map.size === expected.size, `${spec.name}: snapshot/size`);
    let count = 0; const seen = new Set();
    for (const [key, value] of map.entries()) {
      check(expected.has(key) && !seen.has(key), `${spec.name}: extra/duplicate key`);
      check(equal(value, expected.get(key)), `${spec.name}: wrong value`);
      if (order) check(key === order[count], `${spec.name}: wrong iteration order`);
      seen.add(key); count++;
    }
    check(count === expected.size, `${spec.name}: incomplete output`);
    return count;
  };
  return {
    spec, expectedDigest, estimatedAllocationBytes,
    outputElements: model.size + middleModel.size,
    baseElements: baseModel.size,
    keyUnits: { min: Math.min(...keys.map(key => key.length)), max: Math.max(...keys.map(key => key.length)) },
    keyBytes: { min: Math.min(...keyBytes.map(bytes => bytes.length)), max: Math.max(...keyBytes.map(bytes => bytes.length)) },
    setup() {
      api[reset[spec.collection]](); base = new api[spec.collection](spec.type);
      if (spec.replace) for (let i = 0; i < keys.length; i++) base = base.set(keys[i], oldValues[i]);
      before = state(base); prefixDigest = sha(new Uint8Array(before.memory.buffer, 65536, before.used - 65536));
    },
    run() {
      let result = base, middle;
      for (let i = 0; i < keys.length; i++) {
        result = result.set(keys[i], values[i]);
        if (i === middleIndex) middle = result;
      }
      return { result, middle };
    },
    verify({ result, middle }) {
      const ordered = spec.collection === 'SharedOrderedMap', sorted = spec.collection === 'SharedSortedMap';
      const finalOrder = ordered ? normalized : sorted ? sortedKeys : undefined;
      const middleOrder = ordered ? [...middleModel.keys()] : sorted ? sortedMiddle : undefined;
      return verifyMap(result, model, finalOrder) + verifyMap(middle, middleModel, middleOrder);
    },
    finish(outputs) {
      verifyMap(base, baseModel, spec.collection === 'SharedOrderedMap' ? [...baseModel.keys()] : undefined);
      const after = state(outputs.at(-1).result);
      assert.equal(after.memory, before.memory);
      assert.equal(sha(new Uint8Array(after.memory.buffer, 65536, before.used - 65536)), prefixDigest, 'Published base bytes changed');
      const descriptors = outputs.map(({ result, middle }) => [result.toWorkerData(), middle.toWorkerData()]);
      return { usedBefore: before.used, usedAfter: after.used, allocatedBytes: after.used - before.used,
        capacityBefore: before.capacity, capacityAfter: after.capacity, prefixSha256: prefixDigest,
        payloadSha256: sha(new Uint8Array(after.memory.buffer, 65536, after.used - 65536)),
        descriptorSha256: sha(JSON.stringify(descriptors)), verifiedBaseElements: baseModel.size };
    },
  };
}
