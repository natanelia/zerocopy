import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const { Arena, HEAP_START } = await import(pathToFileURL(root + '/arena.ts'));
const { SharedMap, SharedOrderedMap, SharedSortedMap, SharedList } = await import(pathToFileURL(root + '/shared.ts'));
const factories = [
  ['map', (type, a) => new SharedMap(type, 0, 0, a)],
  ['ordered', (type, a) => new SharedOrderedMap(type, 0, 0, 0, 0, a)],
  ['sorted', (type, a) => new SharedSortedMap(type, undefined, 0, 0, a)],
];
const records = [];
const stableBytes = a => Buffer.from(a.buf.slice(HEAP_START, a.used));
for (const [kind, create] of factories) {
  for (const [type, first, second] of [['number', -0, NaN], ['string', '', 'changed-界🙂'], ['boolean', false, true]]) {
    const a = new Arena({ id: `${kind}-${type}` });
    const empty = create(type, a);
    assert.equal(empty.get('missing'), undefined);
    assert.throws(() => empty.get(1), TypeError);
    const old = empty.set('key', first).set('anchor', first);
    const changed = old.set('key', second);
    const sameLeaf = old.set('new-key', second);
    const deleted = changed.delete('key');
    const restored = deleted.set('key', first);
    const before = stableBytes(a), used = a.used;
    for (let round = 0; round < 4; round++) {
      for (const [map, expected] of [[old, first], [changed, second], [sameLeaf, first], [deleted, undefined], [restored, first]]) {
        assert.ok(Object.is(map.get('key'), expected));
        assert.ok(Object.is(map.get('key'), expected));
        assert.equal(map.get('unknown-missing'), undefined);
      }
    }
    assert.throws(() => old.get(Symbol('bad')), TypeError);
    assert.equal(a.used, used);
    assert.deepEqual(stableBytes(a), before);
    // At least one old-root or sorted read must have used the primitive tail.
    assert.notEqual(a.reads.slot('key'), undefined);
    assert.ok(a.reads.valueBytes <= 1048576);
    records.push(`${kind}/${type}: roots, same leaf, misses, slot zero, immutable bytes`);
  }
  {
    const a = new Arena({ id: kind + '-primitive-byte-budget' });
    const payload = 'x'.repeat(524289);
    const old = create('string', a).set('large', payload).set('anchor', 'small');
    old.set('other', 'new root');
    assert.equal(old.get('large'), payload);
    assert.equal(old.get('large'), payload);
    const slot = a.reads.slot('large');
    assert.notEqual(slot, undefined);
    assert.equal(a.reads.code(slot), 0);
    assert.equal(a.reads.value(slot), undefined);
    assert.equal(a.reads.valueBytes, 0);
    assert.equal(old.get('anchor'), 'small');
    assert.ok(a.reads.valueBytes <= 1048576);
    records.push(`${kind}/string: primitive byte-budget rejection and recovery`);
  }
  {
    const childArena = new Arena({ id: kind + '-exception-child' });
    const child = new SharedList('number', 0, 0, 0, childArena).pushMany([1, 2, 3]);
    const a = new Arena({ id: kind + '-exception-parent' });
    const map = create('SharedList<number>', a).set('child', child);
    const before = stableBytes(a), used = a.used;
    a.dependencies.delete(childArena.id);
    for (let round = 0; round < 2; round++) {
      assert.throws(() => map.get('child'), /Missing nested arena/);
      assert.equal(a.objects.size, 0);
      assert.equal(a.objectBytes, 0);
    }
    a.dependencies.set(childArena.id, childArena);
    const restored = map.get('child');
    assert.deepEqual(restored.toArray(), [1, 2, 3]);
    assert.equal(map.get('child'), restored);
    assert.equal(a.used, used);
    assert.deepEqual(stableBytes(a), before);
    records.push(`${kind}/nested: repeated exception, no cache insertion, recovery and identity`);
  }
}
console.log(JSON.stringify({ passed: records.length, records }, null, 2));
