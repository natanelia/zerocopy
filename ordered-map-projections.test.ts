import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it, vi } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { structureRegistry } from './codec';
import { SharedOrderedMap, SharedOrderedSet, SharedList, getWorkerData, initWorker } from './shared';

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const normalized = (key: string) => decoder.decode(encoder.encode(key));
const fresh = <T extends string>(type: T, arena = new Arena()) => new SharedOrderedMap(type, 0, 0, 0, 0, arena);
function sameBytes(actual: Uint8Array, expected: Uint8Array) {
  assert.equal(actual.byteLength, expected.byteLength); assert.equal(Buffer.compare(actual, expected), 0);
}

describe('direct ordered-map projections', () => {
  it('empty projections finish without acquiring a memory view', () => {
    const a = new Arena(), empty = fresh('number', a), removed = empty.set('old', 1).delete('old');
    const view = vi.spyOn(a, 'dv', 'get');
    try {
      for (const map of [empty, removed]) {
        assert.deepEqual([...map.keys()], []);
        assert.deepEqual([...map.values()], []);
      }
      assert.equal(view.mock.calls.length, 0);
    } finally { view.mockRestore(); }
  });

  for (const changed of [false, true]) it(`keys skip legitimate cold JSON values (changed=${changed})`, () => {
    const a = new Arena(); let map = fresh('object', a);
    const expected = new Map<string, unknown>();
    for (let i = 0; i < 96; i++) {
      const value = { i, text: 'Résumé 🙂 '.repeat(16), values: [i, i + 1] };
      map = map.set(`key-${i}`, value); expected.set(`key-${i}`, value);
    }
    if (changed) for (let i = 0; i < 96; i += 3) {
      map = map.delete(`key-${i}`).set(`key-${i}`, { replacement: i });
      expected.delete(`key-${i}`); expected.set(`key-${i}`, { replacement: i });
    }
    assert.equal(map.orderStable, !changed);
    const before = a.buf.slice(0, a.used), values = vi.spyOn(a, 'leafValue');
    try {
      assert.deepEqual([...map.keys()], [...expected.keys()]);
      assert.equal(values.mock.calls.length, 0);
    } finally { values.mockRestore(); }
    sameBytes(a.buf.subarray(0, before.length), before);
  });

  for (const type of ['number', 'boolean', 'string', 'object'] as const) {
    for (const changed of [false, true]) it(`${type} values skip key decoding (changed=${changed})`, () => {
      const a = new Arena(); let map = fresh(type, a);
      const value = (i: number): any => type === 'number' ? [NaN, -0, 0, Infinity, -Infinity, 7.25][i % 6]
        : type === 'boolean' ? !!(i & 1) : type === 'string' ? `\ufeffRésumé界🙂-${i}` : { i, nested: [i, { ok: true }] };
      const keys = Array.from({ length: 24 }, (_, i) => `界🙂-${i}-${'long-key-'.repeat(8)}`), expected = new Map<string, any>();
      for (let i = 0; i < keys.length; i++) { map = map.set(keys[i], value(i)); expected.set(keys[i], value(i)); }
      if (changed) {
        map = map.set(keys[0], value(101)).delete(keys[1]).set(keys[1], value(102));
        expected.set(keys[0], value(101)); expected.delete(keys[1]); expected.set(keys[1], value(102));
      }
      const keyReads = vi.spyOn(a, 'leafKey');
      try {
        const actual = [...map.values()];
        assert.deepEqual(actual, [...expected.values()]);
        assert.equal(keyReads.mock.calls.length, 0);
        if (type === 'object') assert.ok(actual.every(item => Object.isFrozen(item) && Object.isFrozen((item as any).nested)));
      } finally { keyReads.mockRestore(); }
    });
  }

  it('preserves insertion ordinals, Unicode equivalence, hash collisions, forks and empty roots', () => {
    const a = new Arena(); let map = fresh('number', a);
    const model = new Map<string, number>();
    const keys = ['', '\0', 'a', '\ufeff', 'é', '界🙂', '\ud800', '\ufffd', 'costarring', 'liquid'];
    for (let i = 0; i < keys.length; i++) { map = map.set(keys[i], i + 0.25); model.set(normalized(keys[i]), i + 0.25); }
    const original = map, originalModel = new Map(model);
    map = map.set('a', -0).delete('é').set('é', NaN).delete('\ud800').set('\ufffd', Infinity);
    model.set('a', -0); model.delete('é'); model.set('é', NaN); model.delete('\ufffd'); model.set('\ufffd', Infinity);
    for (let i = 0; i < 96; i++) { map = map.set(`extra-${i}`, i); model.set(`extra-${i}`, i); }
    for (let i = 0; i < 96; i += 3) {
      map = map.delete(`extra-${i}`).set(`extra-${i}`, -i); model.delete(`extra-${i}`); model.set(`extra-${i}`, -i);
    }
    const fork = original.delete('costarring').set('fork', -Infinity), forkModel = new Map(originalModel);
    forkModel.delete('costarring'); forkModel.set('fork', -Infinity);
    const { root, head, tail, size, valueType } = original.toWorkerData();
    const legacy = SharedOrderedMap.fromWorkerData({ root, head, tail, size, valueType }, a);
    assert.equal(legacy.orderStable, false);
    for (const [snapshot, expected] of [[original, originalModel], [map, model], [fork, forkModel], [legacy, originalModel]] as const) {
      assert.deepEqual([...snapshot.keys()], [...expected.keys()]);
      assert.deepEqual([...snapshot.values()], [...expected.values()]);
      assert.deepEqual([...snapshot.entries()], [...expected]);
    }
    for (const key of model.keys()) map = map.delete(key);
    assert.equal(map.size, 0); assert.equal(map.head, 0);
    assert.deepEqual([...map.keys()], []); assert.deepEqual([...map.values()], []);
    assert.deepEqual([...original.keys()], [...originalModel.keys()]);
  });

  for (const operation of ['keys', 'values'] as const) it(`${operation} preserve generator laziness and early completion`, () => {
    const a = new Arena(), map = fresh('number', a).set('a', 1).set('b', 2).set('c', 3);
    const method = map[operation], view = vi.spyOn(a, 'dv', 'get'), pending = map[operation]();
    assert.equal(Object.getPrototypeOf(method), Object.getPrototypeOf(function* () {}));
    assert.equal(method.name, operation); assert.equal(method.length, 0);
    assert.equal(Object.getPrototypeOf(pending), method.prototype);
    assert.equal(Object.getPrototypeOf(method.prototype), Object.getPrototypeOf(map.entries.prototype));
    assert.equal(view.mock.calls.length, 0);
    const closed = map[operation](); assert.deepEqual(closed.return('closed'), { value: 'closed', done: true });
    const initialError = new Error('not started');
    assert.throws(() => map[operation]().throw(initialError), error => error === initialError);
    assert.equal(view.mock.calls.length, 0);
    a.alloc(a.memory.buffer.byteLength + 65536);
    const fork = map.delete('a').set('d', 4); view.mockClear();
    assert.deepEqual([...pending], operation === 'keys' ? ['a', 'b', 'c'] : [1, 2, 3]);
    assert.ok(view.mock.calls.length > 0); view.mockRestore();
    assert.deepEqual([...fork.keys()], ['b', 'c', 'd']);
    const keyReads = vi.spyOn(a, 'leafKey'), valueReads = vi.spyOn(a, 'leafValue');
    try {
      for (const completion of ['return', 'throw', 'break'] as const) {
        keyReads.mockClear(); valueReads.mockClear(); const iterator = map[operation]();
        if (completion === 'break') { for (const _ of iterator) break; }
        else {
          assert.equal(iterator.next().done, false);
          if (completion === 'return') assert.deepEqual(iterator.return('closed'), { value: 'closed', done: true });
          else { const error = new Error('consumer'); assert.throws(() => iterator.throw(error), caught => caught === error); }
        }
        assert.equal(keyReads.mock.calls.length, operation === 'keys' ? 1 : 0);
        assert.equal(valueReads.mock.calls.length, operation === 'values' ? 1 : 0);
        assert.deepEqual(iterator.next(), { value: undefined, done: true });
        assert.equal(keyReads.mock.calls.length + valueReads.mock.calls.length, 1);
      }
    } finally { keyReads.mockRestore(); valueReads.mockRestore(); }
  });

  for (const copy of [false, true]) it(`suspended shared/copy projections survive writer growth and forks (copy=${copy})`, async () => {
    const a = new Arena(); let writer = fresh('string', a);
    const expected = new Map<string, string>();
    for (let i = 0; i < 48; i++) { writer = writer.set(`界-${i}`, `value-🙂-${i}`); expected.set(`界-${i}`, `value-🙂-${i}`); }
    writer = writer.set('界-1', 'replacement').delete('界-0').set('界-0', 'reinserted');
    expected.set('界-1', 'replacement'); expected.delete('界-0'); expected.set('界-0', 'reinserted');
    const old = writer, reader = (await initWorker(getWorkerData({ old }, { copy }))).old;
    const iterators = [old.keys(), reader.keys(), old.values(), reader.values()];
    const outputs = iterators.map(iterator => [iterator.next().value]);
    const end = a.used, bytes = a.buf.slice(HEAP_START, end), buffer = a.memory.buffer;
    a.alloc(a.memory.buffer.byteLength + 65536);
    writer = writer.delete('界-1').set('after', 'new value');
    assert.notEqual(a.memory.buffer, buffer);
    for (let i = 0; i < iterators.length; i++) outputs[i].push(...iterators[i]);
    assert.deepEqual(outputs[0], [...expected.keys()]); assert.deepEqual(outputs[1], [...expected.keys()]);
    assert.deepEqual(outputs[2], [...expected.values()]); assert.deepEqual(outputs[3], [...expected.values()]);
    assert.throws(() => reader.set('forbidden', 'value'), /read-only/);
    assert.equal(old.has('after'), false); assert.equal(writer.get('after'), 'new value');
    sameBytes(a.buf.subarray(HEAP_START, end), bytes);
  });

  for (const copy of [false, true]) it(`cold nested keys avoid reconstruction and values retain read-only children (copy=${copy})`, async () => {
    const child = new SharedList('number', 0, 0, 0, new Arena()).pushMany([1, 2, 3]);
    const other = child.set(0, 9), map = fresh('SharedList<number>').set('old', child).set('new', other);
    const reader = (await initWorker(getWorkerData({ map }, { copy }))).map, a = arenaOf(reader);
    const values = vi.spyOn(a, 'leafValue'), factory = vi.spyOn(structureRegistry.SharedList!, 'fromWorkerData');
    try {
      assert.deepEqual([...reader.keys()], ['old', 'new']);
      assert.equal(values.mock.calls.length, 0); assert.equal(factory.mock.calls.length, 0);
    } finally { values.mockRestore(); factory.mockRestore(); }
    const keyReads = vi.spyOn(a, 'leafKey');
    try {
      const children = [...reader.values()];
      assert.equal(keyReads.mock.calls.length, 0);
      assert.deepEqual(children.map(value => value.toArray()), [[1, 2, 3], [9, 2, 3]]);
      for (const value of children) assert.throws(() => value.push(5), /read-only/);
    } finally { keyReads.mockRestore(); }
  });

  it('retains the original value view while nested decoding grows the owning arena', () => {
    const a = new Arena(), child = new SharedList('number', 0, 0, 0, new Arena()).pushMany([4, 5]);
    const map = fresh('SharedList<number>', a).set('a', child).set('b', child).set('c', child);
    const end = a.used, bytes = a.buf.slice(HEAP_START, end), buffer = a.memory.buffer;
    const registry = structureRegistry.SharedList!, original = registry.fromWorkerData;
    let calls = 0, fork: typeof map | undefined;
    registry.fromWorkerData = function (data, source) {
      if (++calls === 1) { a.alloc(a.memory.buffer.byteLength + 65536); fork = map.delete('b').set('fork', child); }
      return original.call(registry, data, source);
    };
    try {
      assert.deepEqual([...map.values()].map(value => value.toArray()), [[4, 5], [4, 5], [4, 5]]);
      assert.equal(calls, 3); assert.notEqual(a.memory.buffer, buffer);
      assert.deepEqual([...fork!.keys()], ['a', 'c', 'fork']);
      assert.deepEqual([...map.keys()], ['a', 'b', 'c']);
      sameBytes(a.buf.subarray(HEAP_START, end), bytes);
    } finally { registry.fromWorkerData = original; }
  });

  it('ordered-set values retain number/string identities and skip dummy payloads', () => {
    const a = new Arena(); let set = new SharedOrderedSet<string | number>(fresh('number', a));
    const input = [0, '0', -0, NaN, 'NaN', Infinity, '界🙂', '\ud800'] as const;
    const expected = new Set<string | number>();
    for (const value of input) { set = set.add(value); expected.add(typeof value === 'string' ? normalized(value) : value); }
    const old = set; set = set.delete('0').add('0').delete(NaN).add(NaN);
    expected.delete('0'); expected.add('0'); expected.delete(NaN); expected.add(NaN);
    const reads = vi.spyOn(a, 'leafValue');
    try { assert.deepEqual([...set.values()], [...expected]); assert.equal(reads.mock.calls.length, 0); }
    finally { reads.mockRestore(); }
    assert.deepEqual([...old.values()], [0, '0', NaN, 'NaN', Infinity, '界🙂', '\ufffd']);
  });
});
