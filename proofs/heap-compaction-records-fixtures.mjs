import assert from 'node:assert/strict';

// Prospective first screen: four targets and four controls. Backing ceilings are
// proven outside timing; they are bounds on backing created between cleanups,
// not measurements or promises about RSS, reserved address space, or GC behavior.
export const cases = Object.freeze({
  'heap-number4096': { role: 'target', kind: 'ordinary', backingCeiling: 262144 },
  'heap-spine4096': { role: 'target', kind: 'spine', backingCeiling: 262144 },
  'heap-shared4096': { role: 'target', kind: 'shared', backingCeiling: 262144 },
  'heap-nested128x512': { role: 'target', kind: 'nested', backingCeiling: 524288, nestedDescriptorCopies: 128 },
  'heap-empty': { role: 'control', kind: 'empty', backingCeiling: 131072 },
  'heap-object1': { role: 'control', kind: 'singleton', backingCeiling: 131072 },
  'list-number4096': { role: 'control', kind: 'list', backingCeiling: 262144 },
  'map-string4096': { role: 'control', kind: 'map', backingCeiling: 524288 },
});
export const limits = Object.freeze({
  chunkBackingBytes: 8 * 1024 * 1024, chunkCompactions: 64, batchChunks: 16,
  pilotWarmChunks: 64, processArenaCounterDigits: 6,
  initialArenaBytes: 131072, maximumArenaBytes: 256 * 1024 * 1024,
});
export function chunkCompactions(name) {
  assert(cases[name]);
  return Math.min(limits.chunkCompactions, Math.floor(limits.chunkBackingBytes / cases[name].backingCeiling));
}
export function makeFixture(api, name) {
  const spec = cases[name]; assert(spec, name);
  // All construction precedes measurement. There is no memory-limit tuning.
  api.resetPriorityQueue();
  let heap = new api.SharedPriorityQueue(spec.kind === 'singleton' ? 'object' : spec.kind === 'shared' ? 'string' : 'number');
  if (spec.kind === 'ordinary' || spec.kind === 'spine' || spec.kind === 'shared') {
    for (let i = 0; i < 4096; i++) heap = heap.enqueue(spec.kind === 'shared' ? `value-${i % 64}` : i, spec.kind === 'spine' ? -i : (i * 37) % 4093);
    if (spec.kind === 'shared') return { heap, first: heap.enqueue('first', -1), second: heap.enqueue('second', -2), again: heap };
    return { heap };
  }
  if (spec.kind === 'nested') {
    const children = Array.from({ length: 8 }, (_, child) => {
      let inner = new api.SharedPriorityQueue('string');
      for (let i = 0; i < 512; i++) inner = inner.enqueue(`child-${child}-${i % 64}`, (i * 37) % 509);
      return inner;
    });
    let outer = new api.SharedPriorityQueue('SharedPriorityQueue<string>');
    for (let i = 0; i < 128; i++) outer = outer.enqueue(children[i % 8], (i * 7) % 127);
    return { outer, child0: children[0], child7: children[7], again: outer };
  }
  if (spec.kind === 'singleton') return { heap: heap.enqueue({ index: 0, nested: [0] }, 0) };
  if (spec.kind === 'empty') return { heap };
  if (spec.kind === 'list') { api.resetSharedList(); return { list: new api.SharedList('number').pushMany(Array.from({ length: 4096 }, (_, i) => i)) }; }
  api.resetMap(); return { map: new api.SharedMap('string').setMany(Array.from({ length: 4096 }, (_, i) => [`key-${i}`, `value-${i % 64}`])) };
}
export function inspect(api, value) {
  if (value instanceof api.SharedPriorityQueue) return [...value.entries()].map(([v, p]) => [inspect(api, v), p]);
  if (value instanceof api.SharedList) return value.toArray().map(v => inspect(api, v));
  if (value instanceof api.SharedMap) return [...value.entries()].map(([k, v]) => [k, inspect(api, v)]);
  return value;
}
export function logical(api, group) { return Object.fromEntries(Object.entries(group).map(([k, v]) => [k, inspect(api, v)])); }
export function checkAliases(group, name) {
  if (cases[name].kind === 'shared') assert.equal(group.heap, group.again);
  if (cases[name].kind === 'nested') {
    assert.equal(group.outer, group.again);
    const children = [...group.outer.entries()].map(([v]) => v);
    assert.equal(new Set(children.map(v => v.root)).size, 8);
    assert(children.some(v => v.root === group.child0.root));
    assert(children.some(v => v.root === group.child7.root));
  }
}
export function backingBound(initialUsed, name) {
  const spec = cases[name];
  // Counter width can grow to six digits. Each nested raw descriptor can grow
  // by at most six bytes plus seven bytes of allocator alignment. No production
  // ID is normalized. A full extra page is reserved beyond that calculation.
  const reserve = spec.nestedDescriptorCopies ? spec.nestedDescriptorCopies * (limits.processArenaCounterDigits + 7) + 65536 : 0;
  const bounded = Math.max(limits.initialArenaBytes, Math.ceil((initialUsed + reserve) / 65536) * 65536);
  assert(bounded <= spec.backingCeiling, `${name}: conservative backing bound ${bounded} exceeds ${spec.backingCeiling}`);
  return { initialUsed, nestedIdAndAlignmentReserve: reserve, bounded, ceiling: spec.backingCeiling, chunkCompactions: chunkCompactions(name), chunkBackingCeiling: chunkCompactions(name) * spec.backingCeiling };
}
