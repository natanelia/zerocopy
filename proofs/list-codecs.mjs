import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import(process.env.QUERY_PROOF_ENTRY ?? new URL('../dist/shared.js', import.meta.url).href);
const { SharedList, SharedMap, getWorkerData, initWorker, resetSharedList } = api;
test('cached leaves preserve boolean, JSON, and nested codecs in shared and copied views', async () => {
  resetSharedList();
  const flags = new SharedList('boolean').pushMany(Array.from({ length: 65 }, (_, i) => i % 2 === 0));
  const input = { label: 'example', values: [1, 2] };
  const objects = new SharedList('object').pushMany(Array(65).fill(input));
  const map = new SharedMap('number').set('answer', 42);
  const nested = new SharedList('SharedMap<number>').pushMany(Array(65).fill(map));
  for (const copy of [false, true]) {
    const restored = await initWorker(getWorkerData({ flags, objects, nested }, { copy }));
    for (let index = 0; index < 65; index++) {
      assert.equal(restored.flags.get(index), index % 2 === 0);
      assert.deepEqual(restored.objects.get(index), input);
      assert.ok(Object.isFrozen(restored.objects.get(index).values));
      assert.equal(restored.nested.get(index).get('answer'), 42);
    }
    assert.ok(!Object.isFrozen(input));
  }
});
