import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const kinds = ['set', 'ordered', 'sorted'];
const primary = kind => `${kind}-mixed-8192`;
export const study = {
  id: 'set-foreach-20261105',
  baseline: '0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e',
  changedSources: ['shared-set.ts', 'shared-ordered-set.ts', 'shared-sorted-set.ts'],
  pilotCases: [...kinds.map(primary), 'set-small-4', 'ordered-override-1024', 'sorted-values-1024'],
  aaCases: [...kinds.map(primary), 'set-small-4', 'ordered-override-1024', 'sorted-values-1024'],
  cases: kinds.flatMap(kind => [
    ...['strings', 'mixed'].flatMap(pattern => [1024, 8192].map(size => ({
      name: `${kind}-${pattern}-${size}`,
      role: pattern === 'mixed' && size === 8192 ? 'primary complete forEach target' : 'secondary complete forEach target',
      kind, pattern, size, operation: 'forEach', repetitions: size === 8192 ? 8 : 32,
    }))),
    { name: `${kind}-small-4`, role: 'small callback control', kind, pattern: 'mixed', size: 4, operation: 'forEach', repetitions: 4096 },
    { name: `${kind}-empty-0`, role: 'empty callback control', kind, pattern: 'mixed', size: 0, operation: 'forEach', repetitions: 16384 },
    { name: `${kind}-values-1024`, role: 'unchanged values iterator control', kind, pattern: 'mixed', size: 1024, operation: 'values', repetitions: 32 },
    { name: `${kind}-override-1024`, role: 'custom values override control', kind, pattern: 'mixed', size: 1024, operation: 'override', repetitions: 32 },
  ]),
};
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => (typeof value === 'number' ? 'n:' : 's:') + String(value);
const keyOrder = (a, b) => encode(a) < encode(b) ? -1 : encode(a) > encode(b) ? 1 : 0;

function fixture(S, spec, values) {
  const SetClass = { set: S.SharedSet, ordered: S.SharedOrderedSet, sorted: S.SharedSortedSet }[spec.kind];
  if (spec.operation !== 'override') {
    let result = new SetClass();
    for (const value of values) result = result.add(value);
    return result;
  }
  // Constructors accept their underlying map. This creates a genuine subclass
  // instance without modifying the frozen snapshot or any global prototype.
  const MapClass = { set: S.SharedMap, ordered: S.SharedOrderedMap, sorted: S.SharedSortedMap }[spec.kind];
  let map = new MapClass('number');
  for (const value of values) map = map.set(encode(value), 0);
  class CustomValuesSet extends SetClass { *values() { yield* super.values(); } }
  return spec.kind === 'sorted' ? new CustomValuesSet(undefined, map) : new CustomValuesSet(map);
}

export async function createWorkload(directory, spec) {
  const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  const input = Array.from({ length: spec.size }, (_, index) => {
    const value = index * 131 % spec.size;
    return spec.pattern === 'mixed' && value % 2 ? value : `value-${String(value).padStart(6, '0')}`;
  });
  const independent = [...new Set(input)], snapshot = fixture(S, spec, input);
  const expected = Object.freeze([...snapshot.values()]);
  assert.equal(snapshot.size, independent.length);
  assert.deepEqual([...expected].sort(keyOrder), [...independent].sort(keyOrder));
  // The unchanged public values() iterator supplies exact HAMT traversal order.
  // Ordered/radix fixtures also have an independent input/sorted order oracle.
  if (spec.kind === 'ordered') assert.deepEqual(expected, independent);
  if (spec.kind === 'sorted') assert.deepEqual(expected, [...independent].sort(keyOrder));
  const descriptor = snapshot.toWorkerData(), original = S.getWorkerData({ snapshot }, { copy: false });
  assert.equal(original.arenas.length, 1);
  const arena = original.arenas[0], bytes = new Uint8Array(arena.memory.buffer, 0, arena.used).slice();
  return {
    operation: spec.operation === 'values'
      ? () => [...snapshot.values()]
      : () => { const output = []; snapshot.forEach(value => output.push(value)); return output; },
    verify(output) {
      assert.ok(Array.isArray(output));
      assert.deepEqual(output, expected);
    },
    checkInvariant() {
      assert.ok(Object.isFrozen(snapshot)); assert.equal(snapshot.size, independent.length);
      assert.deepEqual(snapshot.toWorkerData(), descriptor);
      assert.deepEqual(new Uint8Array(arena.memory.buffer, 0, arena.used), bytes);
      const current = S.getWorkerData({ snapshot }, { copy: false });
      assert.equal(current.arenas.length, 1); assert.equal(current.arenas[0].id, arena.id);
      assert.equal(current.arenas[0].memory, arena.memory); assert.equal(current.arenas[0].used, arena.used);
    },
    expectedDigest: hash(JSON.stringify(expected)),
    fixture: {
      kind: spec.kind, pattern: spec.pattern, size: spec.size, operation: spec.operation,
      nativeBytes: arena.used, originalBytesDigest: hash(bytes), descriptor,
      inputDigest: hash(JSON.stringify(input)),
      callback: 'append every visited value into a new array; retain and verify the complete array after each timed batch',
      oracle: 'native Set membership/types; unchanged values() exact order; independent insertion/radix order where applicable',
      construction: 'public add calls, or public map constructor/set plus set subclass constructor for the override control',
    },
  };
}
