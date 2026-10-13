import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../_site/compare/assets/feature-storage.mjs';
import { KINDS, entriesFor, editsFor, queryIds, calculate } from '../assets/feature-core.mjs';
import { reference, verifyAnswer } from '../assets/feature-reference.mjs';

test('four map adapters preserve initial values and accept only sparse replica deltas', async () => {
  for (const kind of KINDS) {
    const storage = await createStorage(kind), initial = storage.build(entriesFor(1000)), ids = queryIds(1000);
    const readerInitial = await storage.attach(structuredClone(storage.payload(initial)));
    let current = initial, readerCurrent = readerInitial;
    for (let revision = 1; revision <= 3; revision++) {
      const changes = editsFor(1000, revision), previous = current;
      current = storage.update(current, changes, initial);
      readerCurrent = kind === 'shared' ? await storage.attach(structuredClone(storage.payload(current))) : storage.update(readerCurrent, structuredClone(changes), readerInitial);
      if (kind === 'native') assert.equal(current === previous, revision > 1, 'Native copies only while current is retained');
      for (const map of [current, readerCurrent]) verifyAnswer(calculate(map, ids), reference(1000, revision, ids));
      for (const map of [initial, readerInitial]) verifyAnswer(calculate(map, ids), reference(1000, 0, ids));
      assert.throws(() => { readerCurrent.get('road/000000').attributes.lanes = 8; }, TypeError);
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
