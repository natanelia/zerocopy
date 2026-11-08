import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const study = {
  id: 'list-set-many-20261108',
  baseline: 'a4265a0608ec25eec5719496225212db6b251989',
  changedSources: ['persistent-core.as.ts', 'shared-list.ts'],
  pilotCases: ['batch-number-clustered-256', 'batch-number-scattered-256', 'batch-number-repeated-256', 'scalar-set-control'],
  aaCases: ['batch-number-clustered-256', 'batch-number-scattered-256', 'scalar-set-control'],
  cases: [
    { name: 'batch-number-clustered-256', role: 'target', mode: 'batch', type: 'number', count: 32768, edits: 256, shape: 'clustered', repetitions: 256 },
    { name: 'batch-number-scattered-256', role: 'target', mode: 'batch', type: 'number', count: 32768, edits: 256, shape: 'scattered', repetitions: 64 },
    { name: 'batch-number-scattered-1024', role: 'target', mode: 'batch', type: 'number', count: 65536, edits: 1024, shape: 'scattered', repetitions: 32 },
    { name: 'batch-number-repeated-256', role: 'target', mode: 'batch', type: 'number', count: 32768, edits: 256, shape: 'repeated', repetitions: 1024 },
    { name: 'batch-boolean-clustered-256', role: 'type', mode: 'batch', type: 'boolean', count: 32768, edits: 256, shape: 'clustered', repetitions: 256 },
    { name: 'batch-string-clustered-128', role: 'type', mode: 'batch', type: 'string', count: 4096, edits: 128, shape: 'clustered', repetitions: 64 },
    { name: 'batch-number-tree-tail-64', role: 'boundary', mode: 'batch', type: 'number', count: 1057, edits: 64, shape: 'mixed', repetitions: 128 },
    { name: 'batch-number-small-4', role: 'small-batch', mode: 'batch', type: 'number', count: 32768, edits: 4, shape: 'scattered', repetitions: 2048 },
    { name: 'scalar-set-control', role: 'control', mode: 'scalar', type: 'number', count: 32768, edits: 256, shape: 'scattered', repetitions: 64 },
    { name: 'get-number-control', role: 'control', mode: 'get', type: 'number', count: 32768, edits: 4096, shape: 'scattered', repetitions: 64 },
  ],
};

const HEAP_START = 65536;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Both versions and the library comparison use these exact primitive values.
// The source and final result stay retained; intermediate scalar versions do
// not, matching the final-snapshot contract exposed by setMany.
export function makeFixture(spec) {
  const input = Array.from({ length: spec.count }, (_, i) => spec.type === 'boolean' ? i % 3 === 1
    : spec.type === 'string' ? `lane/é/界/🙂/${i}` : i + 0.25);
  let state = 0x42c0ffee;
  const indexes = [], seen = new Set();
  for (let i = 0; i < spec.edits; i++) {
    let index;
    if (spec.shape === 'clustered') index = Math.min(4090, spec.count - spec.edits) + ((i * 73) % spec.edits);
    else if (spec.shape === 'repeated') index = 4000 + (i % 16);
    else if (spec.shape === 'mixed' && i < 4) index = [0, 31, 32, spec.count - 1][i];
    else {
      do {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        index = state % spec.count;
      } while (seen.has(index));
    }
    indexes.push(index); seen.add(index);
  }
  const entries = indexes.map((index, i) => [index, spec.type === 'boolean' ? !input[index]
    : spec.type === 'string' ? `replacement/${i}/é/🙂` : -i - 0.125]);
  return { input, entries };
}

export async function createWorkload(directory, spec) {
  const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  const batched = spec.mode === 'batch' && typeof S.SharedList.prototype.setMany === 'function';
  const fixture = makeFixture(spec), { input, entries } = fixture;
  const finalEdits = new Map(entries), tailStart = (spec.count - 1) & ~31;
  const readChecksum = spec.mode === 'get' ? entries.reduce((sum, [index]) => sum + input[index], 0) : null;
  let source, memory, used, originalHash, descriptor;

  function prepareBatch() {
    S.resetSharedList();
    source = new S.SharedList(spec.type).pushMany(input);
    const packet = S.getWorkerData({ source }, { copy: false });
    assert.equal(packet.arenas.length, 1);
    memory = packet.arenas[0].memory; used = packet.arenas[0].used;
    descriptor = source.toWorkerData();
    originalHash = hash(new Uint8Array(memory.buffer, HEAP_START, used - HEAP_START));
  }

  const operation = spec.mode === 'get' ? () => {
    let checksum = 0;
    for (const [index] of entries) checksum += source.get(index);
    return checksum;
  } : batched ? () => source.setMany(entries) : () => {
    let result = source;
    for (const [index, value] of entries) result = result.set(index, value);
    return result;
  };

  function verify(result) {
    if (spec.mode === 'get') { assert.equal(result, readChecksum); return; }
    assert.ok(result instanceof S.SharedList); assert.ok(Object.isFrozen(result));
    assert.equal(result.type, spec.type); assert.equal(result.size, source.size); assert.equal(result.depth, source.depth);
    for (const [index, value] of finalEdits) assert.ok(Object.is(result.get(index), value));
    const view = new DataView(memory.buffer);
    function leaf(before, after, first, length) {
      assert.ok(after >= HEAP_START && after + length * 8 <= view.byteLength);
      for (let i = 0; i < length; i++) {
        const index = first + i;
        if (!finalEdits.has(index)) assert.ok(Object.is(view.getFloat64(before + i * 8, true), view.getFloat64(after + i * 8, true)));
      }
    }
    function tree(before, after, depth, first) {
      // Source-byte hashing checks every shared subtree. Every expected edit
      // was also checked through the public getter above, including edits
      // accidentally omitted from the new root.
      if (before === after) return;
      if (!depth) { leaf(before, after, first, 32); return; }
      assert.ok(after >= HEAP_START && after + 128 <= view.byteLength);
      const span = 2 ** (depth * 5);
      for (let i = 0; i < 32; i++) {
        const oldChild = view.getUint32(before + i * 4, true), newChild = view.getUint32(after + i * 4, true);
        if (first + i * span >= tailStart) assert.equal(oldChild, newChild);
        else tree(oldChild, newChild, depth - 1, first + i * span);
      }
    }
    if (tailStart) tree(source.root, result.root, source.depth, 0);
    else assert.equal(source.root, result.root);
    leaf(source.tail, result.tail, tailStart, spec.count - tailStart);
  }

  return {
    prepareBatch, operation, verify,
    strategy: spec.mode === 'get' ? 'SharedList.get loop' : batched ? 'one SharedList.setMany call' : 'scalar SharedList.set loop',
    checkInvariant() {
      assert.deepEqual(source.toWorkerData(), descriptor);
      assert.equal(hash(new Uint8Array(memory.buffer, HEAP_START, used - HEAP_START)), originalHash);
      assert.ok(Object.is(source.get(0), input[0])); assert.ok(Object.is(source.get(spec.count - 1), input.at(-1)));
    },
    expectedDigest: hash(JSON.stringify(fixture)),
    fixture: {
      type: spec.type, count: spec.count, mode: spec.mode, edits: spec.edits, distinctEdits: finalEdits.size, shape: spec.shape,
      unit: spec.mode === 'get' ? `${spec.edits} consumed point reads` : `one complete batch of ${spec.edits} point edits`,
      retention: 'original snapshot plus every returned final snapshot; no retained intermediate scalar snapshots',
      updateContract: 'Same size and last value per index; scalar before, additive setMany after, pure primitive inputs',
      excluded: 'reset, source construction, input/index creation, complete value/path verification and original-byte hashing',
      oracle: 'all final edited public values, every unedited slot in changed leaves, unchanged branch pointers and source byte hash',
    },
  };
}
