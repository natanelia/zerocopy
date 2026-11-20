import { describe, expect, test } from 'vitest';
import { Arena, arenaOf } from './arena';
import { structureRegistry } from './codec';
import { SharedMap, SharedOrderedMap, SharedSortedMap, SharedList, getWorkerData, initWorker } from './shared';

describe('bounded object key reads', () => {
  for (const copy of [false, true]) for (const kind of ['map', 'ordered', 'sorted']) {
    test(`${kind}: preserves values, identity, history and read-only bytes (copy=${copy})`, async () => {
      const owner = new Arena();
      let source: any = kind === 'map' ? new SharedMap('object', 0, 0, owner)
        : kind === 'ordered' ? new SharedOrderedMap('object', 0, 0, 0, 0, owner)
        : new SharedSortedMap('object', undefined, 0, 0, owner);
      const input = { nested: { values: [1, '界🙂', null] } };
      const values: any[] = [input, null, false, 0, '', 'text', [1, { x: 2 }]];
      for (let i = 0; i < values.length; i++) source = source.set(`key${i}`, values[i]);
      source = source.set('\ud800', { replacement: true }).set('界🙂', input);
      const changed = source.set('key0', { changed: true }).set('new', { value: 1 });
      const before = owner.buf.slice();
      const { old, current } = await initWorker(getWorkerData({ old: source, current: changed }, { copy }));
      for (let i = 0; i < values.length; i++) {
        expect(old.has(`key${i}`)).toBe(true);
        const value = old.get(`key${i}`);
        expect(value).toEqual(values[i]); expect(old.get(`key${i}`)).toBe(value);
      }
      const first: any = old.get('key0');
      expect(Object.isFrozen(first.nested.values)).toBe(true);
      expect(() => { first.nested.values[0] = 9; }).toThrow(TypeError);
      expect(current.get('key0')).toEqual({ changed: true });
      expect(current.get('key6')).toBe(old.get('key6'));
      expect(old.get('key0')).toBe(first); expect(old.get('new')).toBeUndefined();
      expect(old.get('\ud800')).toBe(old.get('\ufffd'));
      expect(old.has('\ud800')).toBe(true); expect(old.get('\ufffd')).toEqual({ replacement: true });
      expect(old.get('界🙂')).toEqual(input);
      expect(() => old.set('forbidden', {})).toThrow(/read-only/);
      expect(owner.buf).toEqual(before);
    });
  }

  test('does not retain objects beyond the existing address-cache entry or byte limits', async () => {
    const source = new SharedMap('object', 0, 0, new Arena()).setMany(
      Array.from({ length: 2050 }, (_, i) => [`key${i}`, { i }] as const));
    const { map } = await initWorker(getWorkerData({ map: source }, { copy: false }));
    const reader: any = arenaOf(map);
    // Presence entries must not become another unbounded object cache.
    for (let i = 0; i < 2050; i++) expect(map.has(`key${i}`)).toBe(true);
    for (let i = 0; i < 2050; i++) expect(map.get(`key${i}`)).toEqual({ i });
    expect(reader.objects.size).toBe(2048); expect(reader.objectBytes).toBeLessThanOrEqual(2097152);
    expect(reader.valueMap.size).toBe(2050); expect(reader.valueMapBytes).toBe(2050 * 8);
    expect(reader.objectKeys.size).toBe(2048);
    expect(reader.objectKeyChars).toBe(Array.from({ length: 2048 }, (_, i) => `key${i}`.length).reduce((a, b) => a + b, 0));
    expect(reader.reads).toBeUndefined();
    expect([...reader.objectKeys.values()].every(value => value !== null && typeof value === 'object')).toBe(true);
    expect([...reader.valueMap.values()].some(value => value !== null && typeof value === 'object')).toBe(false);
    expect(map.get('key2047')).toBe(map.get('key2047'));
    expect(map.get('key2048')).not.toBe(map.get('key2048'));

    const large = new SharedMap('object', 0, 0, new Arena()).set('large', { text: 'x'.repeat(2097152) });
    const { map: bytes } = await initWorker(getWorkerData({ map: large }, { copy: false }));
    expect(bytes.has('large')).toBe(true);
    const first = bytes.get('large'); expect(first).toEqual(bytes.get('large'));
    expect(first).not.toBe(bytes.get('large'));
    const byteReader: any = arenaOf(bytes);
    expect(byteReader.objects.size).toBe(0); expect(byteReader.objectBytes).toBe(0);
    expect(byteReader.objectKeys.size).toBe(0); expect(byteReader.objectKeyChars).toBe(0);
  });

  test.each([false, true])('reuses immutable JSON from an explicit previous attachment (copy=%s)', async copy => {
    const owner = new Arena(), base = new SharedMap('object', 0, 0, owner);
    const old = base.setMany([['same', { list: [1] }], ['changed', { n: 0 }]]);
    const attach = (map: SharedMap<'object'>) => structuredClone(getWorkerData({ map }, { copy }));
    const first = await initWorker(attach(old));
    const saved = first.map.get('same');
    expect(first.map.get('changed')).toEqual({ n: 0 });
    const next = old.set('changed', { n: 1 }).set('large', { pad: 'x'.repeat(200000) });
    const updated = await initWorker(attach(next), { previous: first });
    expect(updated.map.get('same')).toBe(saved);
    expect(updated.map.get('changed')).toEqual({ n: 1 });
    expect(first.map.get('changed')).toEqual({ n: 0 });
    const fork = await initWorker(attach(old.set('changed', { n: 2 })), { previous: updated });
    expect(fork.map.get('same')).toBe(saved);
    expect(fork.map.get('changed')).toEqual({ n: 2 });
    expect((await initWorker(attach(next))).map.get('same')).not.toBe(saved);
    expect(Object.isFrozen((saved as { list: number[] }).list)).toBe(true);
  });

  test('a reused arena ID and offset cannot substitute different bytes or lengths', async () => {
    const publish = (value: object) => getWorkerData({ map: new SharedMap('object', 0, 0,
      new Arena({ id: 'same-wire-id' })).set('key', value) }, { copy: false });
    const first = await initWorker(publish({ text: 'a'.repeat(20) }));
    const before = first.map.get('key');
    for (let i = 0; i < 20; i++) {
      const value = { text: 'a'.repeat(i) + 'b' + 'a'.repeat(19 - i) };
      const next = await initWorker(publish(value), { previous: first });
      expect(next.map.get('key')).toEqual(value);
      expect(next.map.get('key')).not.toBe(before);
    }
    const short = await initWorker(publish({ text: '' }), { previous: first });
    expect(short.map.get('key')).toEqual({ text: '' });
    expect(first.map.get('key')).toBe(before);
  });

  test('nested handles resolve against the current attachment even when descriptor bytes match', async () => {
    const publish = (number: number) => {
      const list = new SharedList('number', 0, 0, 0, new Arena({ id: 'nested-values' })).push(number);
      const parent = new SharedMap('SharedList<number>', 0, 0, new Arena({ id: 'nested-parent' })).set('list', list);
      return getWorkerData({ parent }, { copy: false });
    };
    const first = await initWorker(publish(1));
    const oldList = first.parent.get('list')!;
    const next = await initWorker(publish(2), { previous: first });
    const newList = next.parent.get('list')!;
    expect(newList).not.toBe(oldList);
    expect(newList.get(0)).toBe(2);
    expect(oldList.get(0)).toBe(1);
  });

  test('object reads do not claim the primitive fast path in a shared arena', async () => {
    const owner = new Arena();
    const metadata = new SharedMap('object', 0, 0, owner).set('item', { title: 'metadata' });
    const prices = new SharedMap('number', 0, 0, owner).set('item', 42);
    const { a, b } = await initWorker(getWorkerData({ a: metadata, b: prices }, { copy: false }));
    const reader: any = arenaOf(a);
    expect(reader.valueRoot).toBe(0);
    const object = a.get('item'); expect(object).toEqual({ title: 'metadata' });
    expect(reader.valueRoot).toBe(0); expect(reader.valueMap).toBeUndefined();
    expect(b.get('item')).toBe(42);
    expect(reader.valueRoot).toBe(b.root); expect(reader.valueMap.get('item')).toBe(42);
    expect(a.get('item')).toBe(object); expect(b.get('item')).toBe(42);
    expect(reader.reads).toBeUndefined();
  });

  test('keeps object and primitive views of the same root separate', async () => {
    const owner = new Arena(), text = new SharedMap('string', 0, 0, owner).set('key', '{"value":1}');
    const object = new SharedMap('object', text.root, text.size, owner);
    const { a, b } = await initWorker(getWorkerData({ a: object, b: text }, { copy: false }));
    expect(a.has('key')).toBe(true);
    const value = a.get('key'); expect(value).toEqual({ value: 1 });
    expect(b.get('key')).toBe('{"value":1}'); expect(a.get('key')).toBe(value);
    expect(b.has('key')).toBe(true); expect(a.get('key')).toBe(value);
  });

  test('nested reconstruction may replace the active cache without corrupting either view', () => {
    const owner = new Arena(), child = new SharedList('number').push(42);
    const source = new SharedMap('SharedList<number>', 0, 0, owner).set('child', child);
    const numbers = new SharedMap('number', 0, 0, owner);
    const factory = structureRegistry.SharedList, original = factory.fromWorkerData;
    let changed: SharedMap<'number'>, calls = 0;
    factory.fromWorkerData = (data, arena) => {
      calls++;
      changed = numbers.set('number', 7);
      expect(changed.get('number')).toBe(7);
      owner.alloc(owner.memory.buffer.byteLength * 2);
      return original(data, arena);
    };
    try {
      const decoded = source.get('child')!;
      expect(decoded.get(0)).toBe(42); expect(source.get('child')).toBe(decoded);
      expect(changed!.get('number')).toBe(7); expect(calls).toBe(1);
      expect(source.has('number')).toBe(false);
    } finally { factory.fromWorkerData = original; }
  });

  test('reentrant presence checks do not duplicate object key accounting', () => {
    const owner = new Arena(), child = new SharedList('number').push(42);
    const source = new SharedMap('SharedList<number>', 0, 0, owner).set('child', child);
    const factory = structureRegistry.SharedList, original = factory.fromWorkerData;
    factory.fromWorkerData = (data, arena) => {
      expect(source.has('child')).toBe(true);
      return original(data, arena);
    };
    try {
      const decoded = source.get('child')!;
      expect(decoded.get(0)).toBe(42); expect(source.get('child')).toBe(decoded);
      const cache: any = owner;
      expect(cache.objectKeys.size).toBe(1); expect(cache.objectKeyChars).toBe('child'.length);
      expect(cache.valueMap.size).toBe(1); expect(cache.valueMapBytes).toBe(8);
      expect(cache.valueMapChars).toBe('child'.length);
    } finally { factory.fromWorkerData = original; }
  });
});
