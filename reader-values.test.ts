import { describe, expect, it, vi } from 'vitest';
import { Arena, arenaOf } from './arena';
import { SharedMap, SharedList, compact, getWorkerData, initWorker, type SharedStructure, type WorkerData } from './shared';
import { attachSessionWorker, retireReaderAttachments, type ReaderAttachments } from './worker-attachment';
import { DecodedValues, ReaderValues } from './reader-values';

type Shape<T> = Record<keyof T, SharedStructure> & Record<Extract<keyof T, symbol>, never>;
function reader() {
  let current: ReaderAttachments = new Map();
  return {
    get current() { return current; },
    clear() { retireReaderAttachments(current); current.clear(); },
    async attach<T extends Shape<T>>(data: WorkerData<T>): Promise<Readonly<T>> {
      const next: ReaderAttachments = new Map();
      const values = await attachSessionWorker(data, current, next);
      retireReaderAttachments(current, next);
      current = next;
      return values as Readonly<T>;
    },
  };
}

const jsonMap = (value: unknown, arena = new Arena()) => new SharedMap('object', 0, 0, arena).set('value', value as any);
const wire = <T extends Shape<T>>(value: T, copy = false) => getWorkerData(value, { copy });

describe('session-only decoded values', () => {
  it('reuses unchanged plain JSON while preserving old roots, local state, and used prefixes', async () => {
    const source = jsonMap({ nested: [1, 2] }), stream = reader();
    const old = (await stream.attach(wire({ map: source }))).map;
    const original = old.get('value'), oldArena = arenaOf(old), used = oldArena.used;
    const updated = source.set('new', { marker: 'x'.repeat(300000) });
    const next = (await stream.attach(wire({ map: updated }))).map;
    const nextArena = arenaOf(next);
    expect(next.get('value')).toBe(original);
    expect(next.get('new')).toEqual({ marker: 'x'.repeat(300000) });
    expect(old.has('new')).toBe(false);
    expect(old.get('value')).toBe(original);
    expect(Object.isFrozen((original as any).nested)).toBe(true);
    expect(nextArena).not.toBe(oldArena);
    expect(nextArena.wasm).not.toBe(oldArena.wasm);
    expect(oldArena.used).toBe(used);
    expect(nextArena.used).toBeGreaterThan(used);
    const oldCopy = getWorkerData({ old }, { copy: true }), nextCopy = getWorkerData({ next }, { copy: true });
    expect(oldCopy.arenas[0].copy!.byteLength).toBe(used);
    expect(nextCopy.arenas[0].copy!.byteLength).toBe(nextArena.used);
    const restoredOld = (await initWorker(oldCopy)).old, restoredNext = (await initWorker(nextCopy)).next;
    expect(restoredOld.get('value')).toEqual(original);
    expect(restoredOld.has('new')).toBe(false);
    expect(restoredNext.get('value')).toEqual(original);
    expect(restoredNext.get('new')).toEqual(next.get('new'));
    expect(() => next.set('no', {})).toThrow(/read-only/);
  });

  it('does not share raw attachments, copied payloads, or separate connection contexts', async () => {
    const source = jsonMap({ value: 1 }), data = wire({ source });
    const plainA = await initWorker(data), plainB = await initWorker(data);
    expect(plainA.source.get('value')).not.toBe(plainB.source.get('value'));
    const a = reader(), b = reader();
    const first = await a.attach(data), separate = await b.attach(data);
    expect(first.source.get('value')).not.toBe(separate.source.get('value'));
    const copies = reader(), copy = wire({ source }, true);
    const copyA = await copies.attach(copy), copyB = await copies.attach(copy);
    expect(copyA.source.get('value')).not.toBe(copyB.source.get('value'));
    expect(copies.current.size).toBe(0);
  });

  it('separates changed values, compaction, overlapping IDs, and removed/reintroduced memory', async () => {
    const a = jsonMap({ value: 1 }, new Arena({ id: 'same' }));
    const b = jsonMap({ value: 2 }, new Arena({ id: 'same' }));
    expect(a.root).toBe(b.root);
    const stream = reader();
    const old = (await stream.attach(wire({ map: a }))).map, value = old.get('value');
    const changed = (await stream.attach(wire({ map: a.set('value', { value: 3 }) }))).map;
    expect(changed.get('value')).toEqual({ value: 3 });
    expect(changed.get('value')).not.toBe(value);
    const replacement = (await stream.attach(wire({ map: b }))).map;
    expect(replacement.get('value')).toEqual({ value: 2 });
    expect(old.get('value')).toBe(value);
    const compacted = (await stream.attach(wire({ map: compact(a) }))).map;
    expect(compacted.get('value')).toEqual(value);
    expect(compacted.get('value')).not.toBe(value);
    await stream.attach(wire({}));
    expect(stream.current.size).toBe(0);
    const again = (await stream.attach(wire({ map: a }))).map;
    expect(again.get('value')).toEqual(value);
    expect(again.get('value')).not.toBe(value);
    const retained = again.get('value'); stream.clear();
    expect(again.get('value')).toBe(retained);
    expect((await stream.attach(wire({ map: a }))).map.get('value')).not.toBe(retained);
  });

  it('separates arena IDs even when their exact memory object is the same', async () => {
    const source = jsonMap({ n: 1 }), data = wire({ source }), stream = reader();
    const descriptor = data.arenas[0], alias = 'same-memory-alias';
    const aliased = { ...data,
      arenas: [descriptor, { ...descriptor, id: alias }],
      structures: { a: data.structures.source, b: { ...data.structures.source, arena: alias } },
    };
    const first = await stream.attach(aliased), av = first.a.get('value'), bv = first.b.get('value');
    expect(arenaOf(first.a).memory).toBe(arenaOf(first.b).memory);
    expect(av).toEqual(bv); expect(av).not.toBe(bv);
    const next = await stream.attach(aliased);
    expect(next.a.get('value')).toBe(av); expect(next.b.get('value')).toBe(bv);
  });

  it('keeps nested reconstruction local to each complete dependency registry', async () => {
    const leafA = new SharedMap('number', 0, 0, new Arena({ id: 'leaf' })).set('n', 1);
    const leafB = new SharedMap('number', 0, 0, new Arena({ id: 'leaf' })).set('n', 2);
    expect(leafA.root).toBe(leafB.root);
    const parent = new SharedMap('SharedMap<number>', 0, 0, new Arena({ id: 'parent' })).set('child', leafA);
    const first = wire({ parent });
    const leafWire = wire({ leafB }).arenas[0];
    const second = { ...first, arenas: first.arenas.map(source => source.id === 'leaf' ? leafWire : source) };
    const stream = reader(), old = (await stream.attach(first)).parent;
    const next = (await stream.attach(second)).parent;
    expect(next.get('child')!.get('n')).toBe(2);
    expect(old.get('child')!.get('n')).toBe(1); // First old nested read is deferred.
    expect(next.get('child')).not.toBe(old.get('child'));
    expect(Object.is(arenaOf(next).transportDependencies, arenaOf(old).transportDependencies)).toBe(false);
    const missing = { ...first, arenas: first.arenas.filter(source => source.id !== 'leaf') };
    const incomplete = (await stream.attach(missing)).parent;
    expect(() => incomplete.get('child')).toThrow(/Missing nested arena/);
  });

  it('calls current public factories on every attachment and nested reconstruction', async () => {
    const source = jsonMap({ value: 1 }), stream = reader(), data = wire({ source });
    const original = SharedMap.fromWorkerData;
    const factory = vi.spyOn(SharedMap, 'fromWorkerData');
    try {
      const old = await stream.attach(data); old.source.get('value');
      await stream.attach(data);
      expect(factory).toHaveBeenCalledTimes(2);
      factory.mockImplementationOnce(() => { throw new Error('factory failure'); });
      await expect(stream.attach(data)).rejects.toThrow('factory failure');
      expect(factory).toHaveBeenCalledTimes(3);
      expect(old.source.get('value')).toEqual({ value: 1 });
      factory.mockImplementation(original);
      const nested = new SharedMap('SharedMap<object>').set('child', source);
      const a = (await stream.attach(wire({ nested }))).nested;
      a.get('child');
      const b = (await stream.attach(wire({ nested }))).nested;
      factory.mockImplementationOnce(() => { throw new Error('nested factory failure'); });
      expect(() => b.get('child')).toThrow('nested factory failure');
      expect(a.get('child')!.get('value')).toEqual({ value: 1 });
    } finally { factory.mockRestore(); }
  });

  it('does not commit a failed frame, while permitting bounded warming of an existing cache', async () => {
    const source = jsonMap({ n: 1 }), extra = jsonMap({ n: 2 }), stream = reader();
    const retained = (await stream.attach(wire({ source }))).source;
    const committed = stream.current, original = SharedMap.fromWorkerData;
    const factory = vi.spyOn(SharedMap, 'fromWorkerData');
    let warmed: unknown;
    try {
      factory.mockImplementationOnce((root, type, size, arena) => {
        const value = original(root, type, size, arena);
        warmed = value.get('value');
        return value;
      });
      factory.mockImplementationOnce(() => { throw new Error('later factory failure'); });
      await expect(stream.attach(wire({ source, extra }))).rejects.toThrow('later factory failure');
      expect(stream.current).toBe(committed);
      expect(stream.current.size).toBe(1);
      expect(retained.get('value')).toBe(warmed);
    } finally { factory.mockRestore(); }
  });

  it('deactivates dropped and abandoned caches without clearing local decoded values', async () => {
    const source = jsonMap({ n: 1 }), extra = jsonMap({ n: 2 }), stream = reader();
    const old = (await stream.attach(wire({ source }))).source, stable = old.get('value');
    const previous = stream.current, entry = [...previous.values()][0];
    const next = new Map([[arenaOf(source).id, { memory: entry.memory, values: entry.values }]]);
    retireReaderAttachments(previous, next); // New metadata record, same live handle.
    const leaf = arenaOf(source).find(source.root, 'value');
    const ptr = leaf + 16 + arenaOf(source).dv.getUint32(leaf + 8, true);
    const len = arenaOf(source).dv.getUint32(leaf + 12, true);
    expect(entry.values.json.get(ptr, len)!.value).toBe(stable);
    await stream.attach(wire({ extra }));
    expect(entry.values.json.get(ptr, len)).toBeUndefined();
    entry.values.json.remember(ptr, len, stable);
    expect(entry.values.json.get(ptr, len)).toBeUndefined();
    expect(old.get('value')).toBe(stable);

    const original = SharedMap.fromWorkerData, factory = vi.spyOn(SharedMap, 'fromWorkerData');
    let captured: SharedMap<any> | undefined, abandoned: ReaderValues | undefined;
    const staged: ReaderAttachments = new Map();
    try {
      factory.mockImplementationOnce((root, type, size, arena) => {
        captured = original(root, type, size, arena);
        captured.get('value');
        abandoned = [...staged.values()][0].values;
        return captured;
      });
      factory.mockImplementationOnce(() => { throw new Error('abandon new cache'); });
      await expect(attachSessionWorker(wire({ source, extra }), new Map(), staged)).rejects.toThrow('abandon new cache');
      expect(staged.size).toBe(0);
      expect(abandoned!.json.get(ptr, len)).toBeUndefined();
      abandoned!.json.remember(ptr, len, stable);
      expect(abandoned!.json.get(ptr, len)).toBeUndefined();
      expect(captured!.get('value')).toEqual(stable);
    } finally { factory.mockRestore(); }
  });

  it('distinguishes plain JSON, nested descriptors, and record lengths at one address', async () => {
    const child = jsonMap({ n: 1 }), nested = new SharedMap('SharedMap<object>').set('child', child);
    const data = wire({ nested }), stream = reader();
    const plain = { ...data, structures: { nested: { ...data.structures.nested, data: { ...data.structures.nested.data, valueType: 'object' } } } } as any;
    const decoded = (await stream.attach(plain) as any).nested.get('child');
    expect(decoded.__t).toBe('SharedMap');
    const restored = (await stream.attach(data)).nested.get('child')!;
    expect(restored).toBeInstanceOf(SharedMap);
    expect(restored.get('value')).toEqual({ n: 1 });
    const values = new DecodedValues<unknown>();
    values.remember(65536, 10, Object.freeze({ n: 1 }));
    expect(values.get(65536, 9)).toBeUndefined();
    expect(values.get(65536, 10)!.value).toEqual({ n: 1 });
  });

  it('caches JSON scalar values without confusing false-like values with misses', async () => {
    const values = [null, false, 0, '', true, 7, 'text'];
    const source = new SharedList('object').pushMany(values), stream = reader();
    const a = (await stream.attach(wire({ source }))).source;
    expect(a.toArray()).toEqual(values);
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const b = (await stream.attach(wire({ source }))).source;
      expect(b.toArray()).toEqual(values);
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });

  it('keeps the original local JSON budget even when a shared value exists', async () => {
    const source = new SharedList('object').pushMany(Array.from({ length: 2049 }, (_, n) => ({ n })));
    const stream = reader(), a = (await stream.attach(wire({ source }))).source;
    const sharedLast = a.get(2048);
    const b = (await stream.attach(wire({ source }))).source;
    for (let i = 0; i < 2048; i++) b.get(i);
    const first = b.get(2048), second = b.get(2048);
    expect(first).toEqual(sharedLast);
    expect(first).not.toBe(sharedLast);
    expect(second).not.toBe(first);
    expect(Object.isFrozen(second)).toBe(true);
  });

  it('keeps the exact encoded-byte admission limit and leaves oversized values uncached', async () => {
    const limit = 2097152, overhead = JSON.stringify({ payload: '' }).length;
    const source = new SharedList('object').pushMany([{ payload: 'x'.repeat(limit - overhead) }, { n: 1 }]);
    const stream = reader(), a = (await stream.attach(wire({ source }))).source, exact = a.get(0);
    const b = (await stream.attach(wire({ source }))).source;
    expect(b.get(0)).toBe(exact);
    expect(b.get(1)).not.toBe(b.get(1));
    const big = new SharedList('object').push({ payload: 'x'.repeat(limit) });
    const c = (await stream.attach(wire({ big }))).big, first = c.get(0);
    const d = (await stream.attach(wire({ big }))).big;
    expect(d.get(0)).toEqual(first);
    expect(d.get(0)).not.toBe(first);
  });

  it('retains Unicode strings through growth and does not cache empty ranges', async () => {
    const source = new SharedList('string').pushMany(['', 'Å🙂'.repeat(40)]), stream = reader();
    const a = (await stream.attach(wire({ source }))).source;
    expect(a.toArray()).toEqual(['', 'Å🙂'.repeat(40)]);
    const next = source.push('x'.repeat(300000));
    const b = (await stream.attach(wire({ source: next }))).source;
    expect(b.toArray()).toEqual(['', 'Å🙂'.repeat(40), 'x'.repeat(300000)]);
    expect(a.toArray()).toEqual(['', 'Å🙂'.repeat(40)]);
    const values = new DecodedValues<string>();
    values.remember(65536, 0, ''); values.remember(65536, 1, 'a');
    expect(values.get(65536, 1)!.value).toBe('a');
    expect(values.get(65536, 0)).toBeUndefined();
  });

  it('keeps a string view uncached after its own entry budget is full', async () => {
    const source = new SharedList('string').pushMany(Array.from({ length: 2049 }, (_, n) => `é-${n}`));
    const stream = reader(), a = (await stream.attach(wire({ source }))).source;
    expect(a.get(2048)).toBe('é-2048');
    const b = (await stream.attach(wire({ source }))).source;
    for (let i = 0; i < 2048; i++) b.get(i);
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    try {
      expect(b.get(2048)).toBe('é-2048');
      const firstCalls = decode.mock.calls.length;
      expect(firstCalls).toBeGreaterThan(0);
      expect(b.get(2048)).toBe('é-2048');
      expect(decode.mock.calls.length).toBeGreaterThan(firstCalls);
    } finally { decode.mockRestore(); }
  });

  it('bounds shared entry and encoded-byte counts without eviction', () => {
    const values = new DecodedValues<number>();
    for (let i = 0; i < 2049; i++) values.remember(i, 1, i);
    expect(values.get(0, 1)!.value).toBe(0);
    expect(values.get(2047, 1)!.value).toBe(2047);
    expect(values.get(2048, 1)).toBeUndefined();
    const bytes = new DecodedValues<string>();
    bytes.remember(1, 2097153, 'oversized'); bytes.remember(2, 2097152, 'exact'); bytes.remember(3, 1, 'later');
    expect(bytes.get(1, 2097153)).toBeUndefined();
    expect(bytes.get(2, 2097152)!.value).toBe('exact');
    expect(bytes.get(3, 1)).toBeUndefined();
    const session = new ReaderValues();
    session.json.remember(1, 1, false); session.strings.remember(2, 1, 'a');
    session.deactivate(); session.deactivate();
    session.json.remember(1, 1, true); session.strings.remember(2, 1, 'b');
    expect(session.json.get(1, 1)).toBeUndefined();
    expect(session.strings.get(2, 1)).toBeUndefined();
    const retiredBeforeFirstRead = new ReaderValues();
    retiredBeforeFirstRead.deactivate();
    retiredBeforeFirstRead.json.remember(1, 1, false);
    retiredBeforeFirstRead.strings.remember(2, 1, 'a');
    expect(retiredBeforeFirstRead.json.get(1, 1)).toBeUndefined();
    expect(retiredBeforeFirstRead.strings.get(2, 1)).toBeUndefined();
  });
});
