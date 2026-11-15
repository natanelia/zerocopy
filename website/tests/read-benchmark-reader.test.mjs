import test from 'node:test';
import assert from 'node:assert/strict';
import { READ_CASES } from '../assets/catalog-read-workloads.mjs';
import { readReference, verifyReadAnswer } from '../assets/catalog-read-reference.mjs';
import { entriesFor, editsFor, queryIds } from '../assets/catalog-core.mjs';
import { publicationFor } from '../assets/catalog-benchmark-core.mjs';
import { RPC } from '../assets/feature-core.mjs';
import { createStorage } from '../_site/investigation-benchmark/assets/feature-storage.mjs';

test('actual read actors measure cold and repeat before verifying captured source contracts', async () => {
  const originalSelf = globalThis.self;
  try {
    for (const definition of READ_CASES) {
      const count = 1000, ids = queryIds(count), storage = await createStorage(definition.kind);
      const initial = storage.build(entriesFor(count));
      let sequence = 0, response;
      globalThis.self = { postMessage: value => { response = value; } };
      await import(`../_site/investigation-benchmark/assets/read-benchmark-reader.mjs?case=${definition.id}`);
      const receive = globalThis.self.onmessage;
      async function request(type, body = {}) {
        response = undefined;
        await receive({ data: structuredClone({ protocol: RPC, type, id: ++sequence, ...body }) });
        assert.equal(response?.id, sequence);
        if (response.error) throw new Error(response.error);
        return response.value;
      }
      await request('prepare', { caseId: definition.id });
      const load = publicationFor(storage, initial, { initial: true });
      assert.equal(await request(load.type, load.body), count);
      await assert.rejects(request('verify-contract'), /cold and repeat/);
      const first = await request('read', { ids, slot: 'first' });
      await assert.rejects(request('verify-contract'), /cold and repeat/);
      const repeat = await request('read', { ids, slot: 'repeat' });
      // Both timings have completed before inspecting any returned value.
      const expected = readReference(count, 0, ids, definition);
      verifyReadAnswer(first.answer, expected); verifyReadAnswer(repeat.answer, expected);
      assert.ok(Number.isFinite(first.localMs) && first.localMs >= 0);
      assert.ok(Number.isFinite(repeat.localMs) && repeat.localMs >= 0);
      const initialChecks = await request('verify-contract');
      assert.deepEqual(Object.keys(initialChecks), ['first', 'repeat']);
      assert.equal(initialChecks.first.passed, true); assert.equal(initialChecks.repeat.passed, true);
      if (definition.workload !== 'selective-fields') assert.equal(initialChecks.first.checkedObjects, 910 * 4);
      await assert.rejects(request('read', { ids, slot: 'first' }), /measured once/);

      const changes = editsFor(count, 1), current = storage.update(initial, changes, initial);
      const publication = publicationFor(storage, current, { changes });
      assert.equal(await request(publication.type, publication.body), count);
      const updated = await request('read', { ids, slot: 'updated' });
      const retained = await request('read', { ids, slot: 'retained' });
      verifyReadAnswer(updated.answer, readReference(count, 1, ids, definition));
      verifyReadAnswer(retained.answer, expected);
      const checks = await request('verify-contract');
      assert.deepEqual(Object.keys(checks), ['first', 'repeat', 'updated', 'retained']);
      assert.ok(Object.values(checks).every(check => check.passed));
      await request('stop');
      await assert.rejects(request('read', { ids, slot: 'first' }), /Snapshot is missing/);
    }
  } finally {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  }
});

test('reader protocol rejects a query over the fixed reply bound before reading', async () => {
  const originalSelf = globalThis.self;
  try {
    let response;
    globalThis.self = { postMessage: value => { response = value; } };
    await import('../_site/investigation-benchmark/assets/read-benchmark-reader.mjs?bounds');
    await globalThis.self.onmessage({ data: { protocol: RPC, type: 'read', id: 1, slot: 'first', ids: Array(1001).fill('product/000000') } });
    assert.match(response.error, /at most 1000/);
  } finally {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  }
});
