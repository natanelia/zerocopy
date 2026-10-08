import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/** Public-package deterministic storage accounting, with no throughput measurements. */
export async function checkNoopSequenceInvariants(moduleURL, reuse) {
  const S = await import(moduleURL), rows = [];
  function storage(list) {
    const data = S.getWorkerData({ list }, { copy: false });
    const arena = data.arenas.find(a => a.id === data.structures.list.arena);
    return { arena, descriptor: data.structures.list.data };
  }
  const indices = size => [...new Set([0, 31, 32, 1024, size - 1].filter(i => i < size))];
  for (const size of [1, 32, 33, 65, 1057, 32769, 32801]) for (const type of ['number', 'boolean', 'string']) {
    S.resetSharedList();
    const values = Array.from({ length: size }, (_, i) => type === 'number' ? i : type === 'boolean' ? !!(i & 1) : `v${i & 7}`);
    const original = new S.SharedList(type).pushMany(values);
    for (const index of indices(size)) {
      const before = storage(original), bytes = new Uint8Array(before.arena.memory.buffer, 65536, before.arena.used - 65536).slice();
      const next = original.set(index, values[index]), after = storage(next);
      const start = (size - 1) & ~31, region = index >= start ? 'tail' : 'tree';
      const ordinaryBytes = region === 'tail' ? (size - start) * 8 : 256 + original.depth * 128;
      const reused = reuse && region === 'tree';
      const allocated = after.arena.used - before.arena.used;
      assert.equal(allocated, reused ? 0 : ordinaryBytes);
      assert.notEqual(next, original);
      assert.equal(Object.isFrozen(next), true);
      assert.equal(next.get(index), values[index]);
      assert.deepEqual(new Uint8Array(before.arena.memory.buffer, 65536, bytes.length), bytes);
      if (reused) assert.deepEqual(after.descriptor, before.descriptor);
      else assert.notDeepEqual(after.descriptor, before.descriptor);
      rows.push({ type, size, index, depth: original.depth, region, ordinaryBytes, allocated });
    }
    assert.deepEqual(original.toArray(), values);
    const same = original.set(0, values[0]), compacted = S.compactMany({ original, same });
    assert.notEqual(same, original);
    assert.equal(compacted.original === compacted.same, reuse && size > 32,
      'compactMany retains its existing descriptor-based identity rule');
    assert.deepEqual(compacted.same.toArray(), values);
  }
  return { reuse, reuseScope: reuse ? 'vector-only' : 'none', rows, assertions: 'exact arena deltas, old payload bytes, fresh frozen handles, logical values, tree descriptor sharing, fresh tail descriptors and compaction identity' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const moduleURL = pathToFileURL(resolve(process.argv[2] ?? 'dist/shared.js')).href;
  assert.ok(['baseline', 'vector-only'].includes(process.argv[3]), 'Choose baseline or vector-only explicitly');
  console.log(JSON.stringify(await checkNoopSequenceInvariants(moduleURL, process.argv[3] === 'vector-only'), null, 2));
}
