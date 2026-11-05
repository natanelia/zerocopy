import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EDITS = 1024;
const makeCase = (name, size, kind, type = 'number') => ({ name, role: kind === 'get' ? 'unchanged read control' : 'declared target', repetitions: 16, size, kind, type, edits: EDITS });
export const study = {
  id: 'vector-copy-words',
  baseline: '0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e',
  changedSources: ['persistent-core.as.ts'],
  changedWasm: ['persistent-core.wasm', 'shared-map.wasm', 'shared-list.wasm', 'linked-list.wasm', 'singly-linked-list.wasm', 'doubly-linked-list.wasm', 'ordered-map.wasm', 'sorted-tree.wasm', 'priority-queue.wasm'],
  aaCases: ['tree-32768', 'tail-32', 'get-control'],
  pilotCases: ['tree-1024', 'tree-32768', 'tail-32', 'get-control'],
  cases: [
    makeCase('tree-64', 64, 'tree'),
    makeCase('tree-1024', 1024, 'tree'),
    makeCase('tree-32768', 32768, 'tree'),
    makeCase('tail-1', 1, 'tail'),
    makeCase('tail-17', 17, 'tail'),
    makeCase('tail-32', 32, 'tail'),
    makeCase('boolean-tree-1024', 1024, 'tree', 'boolean'),
    makeCase('string-tree-1024', 1024, 'tree', 'string'),
    makeCase('get-control', 1024, 'get'),
  ],
};

export async function createWorkload(directory, spec) {
  const { SharedList, resetSharedList, getWorkerData } = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  const original = Array.from({ length: spec.size }, (_, i) => spec.type === 'number' ? i + 0.25 : spec.type === 'boolean' ? !!(i & 1) : `value-${i}`);
  const tailStart = (spec.size - 1) & ~31;
  const indices = Array.from({ length: spec.edits }, (_, i) => spec.kind === 'tail'
    ? tailStart + ((i * 17) % (spec.size - tailStart))
    : (Math.imul(i + 1, 2654435761) >>> 0) % (spec.kind === 'get' ? spec.size : tailStart));
  const values = Array.from({ length: spec.edits }, (_, i) => spec.type === 'number' ? -i - 0.75 : spec.type === 'boolean' ? !(i & 1) : `edited-${i}`);
  const expected = original.slice();
  if (spec.kind !== 'get') for (let i = 0; i < indices.length; i++) expected[indices[i]] = values[i];
  const expectedRead = indices.reduce((sum, index) => sum + original[index], 0);
  let base, baselineBytes, baselineUsed, calls = 0;
  function setup() {
    resetSharedList();
    base = new SharedList(spec.type).pushMany(original);
    const descriptor = getWorkerData({ base }, { copy: false }).arenas[0];
    baselineUsed = descriptor.used;
    baselineBytes = new Uint8Array(descriptor.memory.buffer, 65536, baselineUsed - 65536).slice();
    calls = 0;
  }
  setup();
  return {
    operation() {
      calls++;
      if (spec.kind === 'get') {
        let sum = 0;
        for (let i = 0; i < indices.length; i++) sum += base.get(indices[i]);
        return sum;
      }
      let result = base;
      for (let i = 0; i < indices.length; i++) result = result.set(indices[i], values[i]);
      return result;
    },
    verify(result) {
      if (spec.kind === 'get') assert.equal(result, expectedRead);
      else {
        assert.ok(Object.isFrozen(result));
        assert.equal(result.size, spec.size);
        assert.deepEqual(result.toArray(), expected);
      }
    },
    checkInvariant() {
      assert.deepEqual(base.toArray(), original);
      const descriptor = getWorkerData({ base }, { copy: false }).arenas[0];
      assert.deepEqual(new Uint8Array(descriptor.memory.buffer, 65536, baselineUsed - 65536), baselineBytes);
      if (spec.kind === 'get') assert.equal(descriptor.used, baselineUsed);
      else if (spec.type !== 'string') {
        const perEdit = spec.kind === 'tail' ? (spec.size - tailStart) * 8 : 256 + base.depth * 128;
        assert.equal(descriptor.used - baselineUsed, calls * spec.edits * perEdit);
      }
      setup();
    },
    expectedDigest: createHash('sha256').update(JSON.stringify(spec.kind === 'get' ? expectedRead : expected)).digest('hex'),
    fixture: { size: spec.size, edits: spec.edits, type: spec.type, treeDepth: base.depth, tailStart, operation: spec.kind === 'get' ? '1024 public get() calls with sum' : '1024 public set() calls, retaining the final immutable snapshot', resetBetweenBatches: true },
  };
}
