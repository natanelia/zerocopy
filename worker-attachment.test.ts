import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { Arena, arenaOf } from './arena';
import { SharedMap, getWorkerData, initWorker } from './shared';

function numberMap(value: number, arena = new Arena()) {
  return new SharedMap('number', 0, 0, arena).set('value', value);
}
function nestedMap(child: SharedMap<'number'>, arena = new Arena()) {
  return new SharedMap('SharedMap<number>', 0, 0, arena).set('child', child);
}

// Original iterative all-to-all traversal, without observing/materializing maps.
function legacyArenaOrder(structures: Record<string, object>): Arena[] {
  const found = new Map<string, Arena>();
  for (const root of Object.values(structures)) {
    const pending = [arenaOf(root)];
    while (pending.length) {
      const arena = pending.pop()!;
      if (found.has(arena.id)) continue;
      found.set(arena.id, arena);
      for (const nested of (arena.transportDependencies ?? arena.dependencies).values()) pending.push(nested);
    }
  }
  return [...found.values()];
}
function assertLegacyExport(structures: Record<string, SharedMap<'number'>>): void {
  const expected = legacyArenaOrder(structures);
  const actual = getWorkerData(structures, { copy: false }).arenas;
  assert.deepEqual(actual.map(arena => arena.id), expected.map(arena => arena.id));
  actual.forEach((arena, index) => assert.equal(arena.memory, expected[index].memory));
}

for (const copy of [false, true]) describe(`worker attachment registry (copy=${copy})`, () => {
  it('shares one lookup without materializing all-to-all dependency maps', async () => {
    const source = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`map${i}`, numberMap(i)]));
    const attached = await initWorker(getWorkerData(source, { copy }));
    const arenas = Object.values(attached).map(arenaOf), registry = arenas[0].transportDependencies;
    assert.equal(registry.size, 24);
    assert.equal(new Set(arenas.map(arena => arena.transportDependencies)).size, 1);
    const values = vi.spyOn(registry, 'values');
    try {
      const exported = getWorkerData(attached, { copy });
      assert.equal((exported.arenas).length, 24);
      assert.equal(values.mock.calls.length, 0);
      assert.equal(new Set(arenas.map(arena => arena.transportDependencies)).size, 1);
      const again = await initWorker(exported);
      for (let i = 0; i < 24; i++) assert.equal(again[`map${i}`].get('value'), i);
    } finally { values.mockRestore(); }
  });

  it('exports empty, singleton, and two-arena payloads without dependency iterators', async () => {
    assert.deepEqual(getWorkerData({}, { copy }).arenas, []);
    for (const count of [1, 2]) {
      const source = Object.fromEntries(Array.from({ length: count }, (_, i) => [`map${i}`, numberMap(i)]));
      const attached = await initWorker(getWorkerData(source, { copy }));
      const maps = Object.values(attached), lookup = arenaOf(maps[0]).transportDependencies;
      if (count === 1) {
        assert.equal(lookup.size, 0);
        assert.equal(arenaOf(maps[0]).sharedDependencyMembers, undefined);
        assert.equal(arenaOf(maps[0]).dependencies, lookup);
      }
      const values = vi.spyOn(lookup, 'values');
      try {
        for (const map of maps) {
          const result = getWorkerData({ root: map, alias: map }, { copy });
          const expected = [arenaOf(map).id, ...maps.slice().reverse().filter(other => other !== map).map(other => arenaOf(other).id)];
          assert.deepEqual(result.arenas.map(arena => arena.id), expected);
        }
        assert.equal(values.mock.calls.length, 0);
      } finally { values.mockRestore(); }
      // Explicit observation still exposes distinct, self-excluding Maps.
      for (const map of maps) assert.equal(arenaOf(map).dependencies.size, count - 1);
    }
  });

  it('keeps a single dependency backing field and avoids dependency getters during reads', async () => {
    const leaf = numberMap(3), parent = nestedMap(leaf);
    const attached = await initWorker(getWorkerData({ parent }, { copy }));
    for (const arena of [arenaOf(parent), arenaOf(attached.parent)]) {
      assert.deepEqual(Object.getOwnPropertyNames(arena).slice(0, 7), ['memory', 'wasm', 'id', 'readOnly', 'dependencyLookup', 'writeHead', 'writeSize']);
      assert.equal(Object.hasOwn(arena, 'dependencyRegistry'), false);
    }
    const metadata = vi.spyOn(Arena.prototype, 'sharedDependencyMembers', 'get');
    const dependencies = vi.spyOn(Arena.prototype, 'dependencies', 'get');
    try {
      const first = attached.parent.get('child')!;
      assert.equal(first.get('value'), 3);
      for (let i = 0; i < 10; i++) assert.equal(attached.parent.get('child'), first);
      assert.equal(metadata.mock.calls.length, 0);
      assert.equal(dependencies.mock.calls.length, 0);
    } finally { metadata.mockRestore(); dependencies.mockRestore(); }
  });

  it('preserves legacy first-ID order across overlapping closed and observed registries', async () => {
    const group = async (ids: string[], value: number) => {
      const roots = Object.fromEntries(ids.map((id, i) => [id, numberMap(value + i, new Arena({ id }))]));
      return initWorker(getWorkerData(roots, { copy }));
    };
    const left = await group(['a', 'b', 'c'], 10), right = await group(['b', 'd', 'e'], 20);
    for (const structures of [
      { one: left.a, two: right.d }, { one: right.d, two: left.a },
      { one: left.b, two: right.b }, { one: right.b, two: left.b },
      { one: left.c, two: right.e, alias: left.c },
    ]) assertLegacyExport(structures);
    const writer = numberMap(30), owner = arenaOf(writer);
    const collision = numberMap(99, new Arena({ id: 'c' }));
    owner.dependencies.set('left', arenaOf(left.a));
    owner.dependencies.set('collision', arenaOf(collision));
    owner.dependencies.set('right', arenaOf(right.d));
    assertLegacyExport({ writer });
    // Observing one member opens every untouched sibling in that payload.
    const observed = arenaOf(right.d).dependencies;
    observed.clear(); observed.set(arenaOf(right.d).id, arenaOf(collision));
    assert.equal(arenaOf(right.e).hasSharedDependencies, false);
    assertLegacyExport({ one: right.e, two: left.a });
    assertLegacyExport({ writer });
    observed.set('cycle', owner);
    assertLegacyExport({ one: right.b, writer, two: left.c });
  });

  it('follows singleton dependency values even when their key is the owner ID', async () => {
    const child = numberMap(7), writer = numberMap(8), owner = arenaOf(writer);
    owner.dependencies.set(owner.id, arenaOf(child));
    assertLegacyExport({ writer });
    assert.equal(getWorkerData({ writer }, { copy }).arenas.length, 2);
    const attached = await initWorker(getWorkerData({ writer }, { copy }));
    const reader = arenaOf(attached.writer), dependencies = reader.dependencies;
    dependencies.clear(); dependencies.set(reader.id, arenaOf(child));
    assertLegacyExport({ writer: attached.writer });
    assert.equal(getWorkerData({ writer: attached.writer }, { copy }).arenas.length, 2);
  });

  it('preserves distinct self-excluding dependency maps when observed', async () => {
    const source = { one: numberMap(1), two: numberMap(2), three: numberMap(3) };
    const attached = await initWorker(getWorkerData(source, { copy }));
    const arenas = Object.values(attached).map(arenaOf);
    const maps = arenas.map(arena => arena.dependencies);
    assert.equal(new Set(maps).size, 3);
    arenas.forEach((arena, i) => {
      assert.equal(arena.dependencies, maps[i]);
      assert(maps[i] instanceof Map);
      assert.deepEqual([...maps[i].values()], arenas.filter(other => other !== arena));
      assert.equal(maps[i].has(arena.id), false);
    });
    assert.deepEqual(getWorkerData(attached, { copy }).arenas.map(arena => arena.id), [
      arenas[0].id, arenas[2].id, arenas[1].id,
    ]);
  });

  it('honors mutations of an observed dependency map without changing sibling maps', async () => {
    const leaf = numberMap(7), parent = nestedMap(leaf);
    const attached = await initWorker(getWorkerData({ parent, leaf }, { copy }));
    const owner = arenaOf(attached.parent), child = arenaOf(attached.leaf);
    const dependencies = owner.dependencies;
    dependencies.delete(child.id);
    assert.throws(() => attached.parent.get('child'), /Missing nested arena in worker data/);
    assert.equal(child.dependencies.get(owner.id), owner);
    assert.equal((getWorkerData({ parent: attached.parent }, { copy }).arenas).length, 1);
    dependencies.set(child.id, child);
    assert.equal(attached.parent.get('child')!.get('value'), 7);
  });

  it('preserves DFS order and duplicate-ID precedence after extending a reader graph', async () => {
    for (const duplicate of [false, true]) {
      const source = { a: numberMap(1), b: numberMap(2), c: numberMap(3), d: numberMap(4) };
      const attached = await initWorker(getWorkerData(source, { copy }));
      const [a, b, c, d] = Object.values(attached).map(arenaOf);
      const extra = arenaOf(numberMap(99, new Arena(duplicate ? { id: c.id } : {})));
      const writer = arenaOf(numberMap(5));
      writer.dependencies.set(extra.id, extra);
      writer.dependencies.set(b.id, b);
      d.dependencies.set(writer.id, writer);
      const exported = getWorkerData({ a: attached.a }, { copy: false });
      assert.deepEqual(exported.arenas.map(arena => arena.id), [a.id, d.id, writer.id, b.id, c.id, ...duplicate ? [] : [extra.id]]);
      assert.equal(exported.arenas.find(arena => arena.id === c.id)!.memory, c.memory);
      if (duplicate) assert.notEqual(c.memory, extra.memory);
    }
  });

  it('preserves same-arena nesting, aliases, forks, and read-only behavior', async () => {
    const arena = new Arena(), old = numberMap(1, arena), next = old.set('value', 2);
    const parent = nestedMap(old, arena).set('next', next).set('alias', old);
    assert.equal(arena.dependencies.size, 0);
    const data = getWorkerData({ parent, alias: parent }, { copy });
    assert.equal((data.arenas).length, 1);
    const attached = await initWorker(data), child = attached.parent.get('child')!;
    assert.equal(child.get('value'), 1);
    assert.equal(attached.parent.get('next')!.get('value'), 2);
    assert.equal(attached.parent.get('alias')!.root, child.root);
    assert.equal(attached.parent.get('child'), child);
    assert.equal(arenaOf(attached.alias), arenaOf(attached.parent));
    assert.equal(arenaOf(child), arenaOf(attached.parent));
    assert.equal(arenaOf(child).dependencies.size, 0);
    assert.throws(() => child.set('value', 9), /read-only/);
    assert.throws(() => attached.parent.set('child', old), /read-only/);
    assert.equal(old.get('value'), 1);
    assert.equal(next.get('value'), 2);
    assert.equal((await initWorker(getWorkerData(attached, { copy }))).parent.get('next')!.get('value'), 2);
  });

  it('resolves cross-arena nesting and cycles in the arena dependency graph', async () => {
    const a = new Arena(), b = new Arena(), leaf = numberMap(11, a);
    const middle = nestedMap(leaf, b);
    const root = new SharedMap('SharedMap<SharedMap<number>>', 0, 0, a).set('middle', middle);
    assert.equal(a.dependencies.get(b.id), b);
    assert.equal(b.dependencies.get(a.id), a);
    const attached = await initWorker(getWorkerData({ root, middle }, { copy }));
    const nested = attached.root.get('middle')!;
    assert.equal(arenaOf(nested), arenaOf(attached.middle));
    assert.equal(nested.get('child')!.get('value'), 11);
    assert.equal(arenaOf(nested.get('child')!), arenaOf(attached.root));
    const again = await initWorker(getWorkerData({ root: attached.root }, { copy }));
    assert.equal(again.root.get('middle')!.get('child')!.get('value'), 11);
  });

  it('isolates overlapping arena IDs across attachments, including deferred nested reads', async () => {
    const payload = (value: number) => {
      const leaf = numberMap(value, new Arena({ id: 'session-child' }));
      return getWorkerData({ parent: nestedMap(leaf, new Arena({ id: 'session-parent' })) }, { copy });
    };
    const old = await initWorker(payload(1));
    const next = await initWorker(payload(2));
    assert.equal(next.parent.get('child')!.get('value'), 2);
    const retained = old.parent.get('child')!;
    assert.equal(retained.get('value'), 1);
    assert.notEqual(arenaOf(old.parent).transportDependencies, arenaOf(next.parent).transportDependencies);
    const again = await initWorker(getWorkerData({ retained }, { copy }));
    assert.equal(again.retained.get('value'), 1);
    assert.equal(old.parent.get('child'), retained);
  });

  it('re-exports reader groups reached from writer-owned dependency maps', async () => {
    const one = numberMap(1), two = numberMap(2), spare = numberMap(3);
    const readers = await initWorker(getWorkerData({ one, two, spare }, { copy }));
    const parent = nestedMap(readers.one).set('second', readers.two);
    const owner = arenaOf(parent), dependencies = owner.dependencies;
    assert.equal(dependencies.size, 2);
    assert.equal(dependencies.get(arenaOf(readers.one).id), arenaOf(readers.one));
    assert.equal(dependencies.has(owner.id), false);
    const data = getWorkerData({ parent }, { copy });
    // Attachments retain their full payload's reachability, including spare.
    assert.equal((data.arenas).length, 4);
    assert.equal(owner.dependencies, dependencies);
    assert.equal(dependencies.size, 2);
    const again = await initWorker(data);
    assert.equal(again.parent.get('child')!.get('value'), 1);
    assert.equal(again.parent.get('second')!.get('value'), 2);
  });

  it('retains ordinary invalid transport and missing nested arena errors', async () => {
    const leaf = numberMap(1), parent = nestedMap(leaf);
    const data = getWorkerData({ parent }, { copy });
    await assert.rejects(initWorker({ ...data, version: 3 } as any), /Unsupported worker data/);
    await assert.rejects(initWorker({ ...data, arenas: [...data.arenas, data.arenas[0]] }), /Invalid arena transport/);
    await assert.rejects(initWorker({ ...data, arenas: [{ id: 'missing', used: 65536 }] }), /Invalid arena transport/);
    for (const used of [0, 65535, 65536.5, Infinity, Number.MAX_SAFE_INTEGER]) {
      await assert.rejects(initWorker({ ...data, arenas: [{ ...data.arenas[0], used }] }), /Invalid arena length/);
    }
    const missing = await initWorker({ ...data, arenas: data.arenas.filter(arena => arena.id !== arenaOf(leaf).id) });
    assert.throws(() => missing.parent.get('child'), /Missing nested arena in worker data/);
    const structure = data.structures.parent;
    await assert.rejects(initWorker({ ...data, structures: { parent: { ...structure, arena: 'missing' } } }), /Invalid structure: parent/);
    await assert.rejects(initWorker({ ...data, structures: { parent: { ...structure, type: 'unknown' } } }), /Invalid structure: parent/);
  });
});
