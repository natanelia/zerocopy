import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../_site/compare/assets/feature-storage.mjs';
import { KINDS, entriesFor, editsFor, queryIds, calculate } from '../assets/catalog-core.mjs';
import { reference, verifyAnswer } from '../assets/catalog-reference.mjs';

test('four map adapters preserve initial catalog values and publish sparse product deltas', async () => {
  for (const kind of KINDS) {
    const storage = await createStorage(kind), initial = storage.build(entriesFor(1000)), ids = queryIds(1000);
    const readerInitial = await storage.attach(structuredClone(storage.payload(initial)));
    let current = initial, readerCurrent = readerInitial;
    for (let revision = 1; revision <= 3; revision++) {
      const changes = editsFor(1000, revision), previous = current;
      current = storage.update(current, changes, initial);
      readerCurrent = kind === 'shared' ? await storage.attach(structuredClone(storage.payload(current))) : storage.update(readerCurrent, structuredClone(changes), readerInitial);
      if (kind === 'native') assert.equal(current === previous, revision > 1, 'Native copies only while current is retained');
      for (const map of [current, readerCurrent]) {
        verifyAnswer(calculate(map, ids), reference(1000, revision, ids));
        assert.equal(map.get('product/000000').attributes.priceCents, 2500);
        assert.equal(map.get('product/000000').attributes.stock, revision % 2 ? 0 : 5);
        assert.equal(map.get('product/000000').status, revision % 2 ? 'unavailable' : 'available');
      }
      for (const map of [initial, readerInitial]) {
        verifyAnswer(calculate(map, ids), reference(1000, 0, ids));
        assert.equal(map.get('product/000000').attributes.priceCents, 0);
        assert.equal(map.get('product/000000').status, 'available');
      }
      assert.throws(() => { readerCurrent.get('product/000000').attributes.priceCents = 8; }, TypeError);
      assert.throws(() => { readerCurrent.get('product/000000').metadata.tags.push('changed'); }, TypeError);
      if (kind === 'shared') {
        const arenas = storage.arenas(readerCurrent, readerInitial);
        assert.equal(arenas.length, 1); assert.equal(arenas[0].usedBytes, storage.arenas(current)[0].usedBytes);
      }
    }
    const released = storage.update(current, editsFor(1000, 4), undefined);
    if (kind === 'native') assert.equal(released, current);
    verifyAnswer(calculate(released, ids), reference(1000, 4, ids));
  }
});
