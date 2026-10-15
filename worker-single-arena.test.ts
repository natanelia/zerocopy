import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, arenaOf } from './arena';
import { SharedMap, getWorkerData } from './shared';

function numberMap(value: number, arena: Arena) {
  return new SharedMap('number', 0, 0, arena).set('value', value);
}
function observingMap(source: SharedMap<'number'>, observe: () => void) {
  class ObservedMap extends SharedMap<'number'> {
    override toWorkerData() { observe(); return super.toWorkerData(); }
  }
  return new ObservedMap('number', source.root, source.size, arenaOf(source));
}

// IDs stay strings and native collection intrinsics remain unchanged. Existing
// worker-attachment tests own closed/open registry, nested and DFS coverage.
for (const copy of [false, true]) describe(`singleton worker export (copy=${copy})`, () => {
  it('keeps empty, singleton, alias and multiple-ID payloads frozen and calls every descriptor', () => {
    const calls: string[] = [];
    const a = observingMap(numberMap(1, new Arena({ id: 'a' })), () => calls.push('a'));
    const b = observingMap(numberMap(2, new Arena({ id: 'b' })), () => calls.push('b'));
    const empty = getWorkerData({}, { copy });
    const single = getWorkerData({ a }, { copy });
    const aliases = getWorkerData({ a, alias: a }, { copy });
    const multiple = getWorkerData({ a, b, alias: a }, { copy });
    assert.deepEqual([empty, single, aliases, multiple].map(data => data.arenas.map(arena => arena.id)), [[], ['a'], ['a'], ['a', 'b']]);
    assert.deepEqual(calls, ['a', 'a', 'a', 'a', 'b', 'a']);
    for (const data of [empty, single, aliases, multiple]) {
      assert(Object.isFrozen(data)); assert(Object.isFrozen(data.arenas)); assert(Object.isFrozen(data.structures));
      for (const arena of data.arenas) assert(Object.isFrozen(arena));
      for (const structure of Object.values(data.structures)) {
        assert(Object.isFrozen(structure)); assert(Object.isFrozen(structure.data));
      }
    }
  });

  it('preserves an empty-string first ID and the first Arena on collisions before promotion', () => {
    const first = new Arena({ id: '' }), collision = new Arena({ id: '' }), later = new Arena({ id: 'later' });
    const data = getWorkerData({ first: numberMap(1, first), collision: numberMap(2, collision), later: numberMap(3, later) }, { copy });
    assert.deepEqual(data.arenas.map(arena => arena.id), ['', 'later']);
    if (copy) assert.deepEqual(data.arenas[0].copy, first.copy());
    else assert.equal(data.arenas[0].memory, first.memory);
  });

  it('deduplicates against the saved insertion ID after a descriptor changes the live ID', () => {
    const first = new Arena({ id: 'original' }), collision = new Arena({ id: 'original' }), later = new Arena({ id: 'later' });
    const root = observingMap(numberMap(1, first), () => Object.defineProperty(first, 'id', { value: 'changed' }));
    const data = getWorkerData({ root, collision: numberMap(2, collision), later: numberMap(3, later) }, { copy });
    assert.deepEqual(data.arenas.map(arena => arena.id), ['changed', 'later']);
    assert.equal(data.structures.root.arena, 'original');
    if (copy) assert.deepEqual(data.arenas[0].copy, first.copy());
    else assert.equal(data.arenas[0].memory, first.memory);
  });

  it('can retain one Arena twice when its ID changes before the next alias is collected', () => {
    const arena = new Arena({ id: 'original' }); let calls = 0;
    const root = observingMap(numberMap(1, arena), () => { calls++; Object.defineProperty(arena, 'id', { value: 'changed' }); });
    const data = getWorkerData({ root, alias: root }, { copy });
    assert.equal(calls, 2);
    assert.deepEqual(data.arenas.map(arena => arena.id), ['changed', 'changed']);
    assert.deepEqual([data.structures.root.arena, data.structures.alias.arena], ['original', 'changed']);
    if (copy) assert.deepEqual(data.arenas[0].copy, data.arenas[1].copy);
    else assert.equal(data.arenas[0].memory, data.arenas[1].memory);
  });

  it('keeps separate probe/insertion reads and replaces a seeded value at its original position', () => {
    for (const withPrefix of [false, true]) {
      const arena = new Arena({ id: 'initial' }), prefix = numberMap(2, new Arena({ id: 'first' }));
      const events: string[] = [], dependencies = arena.dependencies;
      const watched = observingMap(numberMap(1, arena), () => events.push('toWorkerData'));
      const ids = ['probe', 'first', 'structure', 'final']; let reads = 0;
      Object.defineProperty(arena, 'id', { get() { const id = ids[reads++]; assert(id !== undefined); events.push(id); return id; } });
      Object.defineProperty(arena, 'transportDependencies', { get() { events.push('dependencies'); return dependencies; } });
      const data = getWorkerData(withPrefix ? { prefix, watched } : { watched }, { copy });
      assert.deepEqual(events, ['probe', 'first', 'dependencies', 'structure', 'toWorkerData', 'final']);
      assert.equal(reads, 4);
      assert.deepEqual(data.arenas.map(source => source.id), ['final']);
      assert.equal(data.structures.watched.arena, 'structure');
      if (copy) assert.deepEqual(data.arenas[0].copy, arena.copy());
      else assert.equal(data.arenas[0].memory, arena.memory);
    }
  });

  it('skips dependencies added after collection for an alias but observes them on the next export', () => {
    const arena = new Arena({ id: 'root' }), child = new Arena({ id: 'child' });
    const root = observingMap(numberMap(1, arena), () => arena.dependencies.set(child.id, child));
    assert.deepEqual(getWorkerData({ root, alias: root }, { copy }).arenas.map(source => source.id), ['root']);
    assert.deepEqual(getWorkerData({ root }, { copy }).arenas.map(source => source.id), ['root', 'child']);
  });

  it('finishes every structure descriptor before copying and includes later growth of an earlier Arena', () => {
    const first = new Arena({ id: 'first', memory: new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true }) });
    const later = new Arena({ id: 'later' }), events: string[] = [];
    const root = observingMap(numberMap(1, first), () => events.push('descriptor:first'));
    const initialUsed = first.used, initialCapacity = first.memory.buffer.byteLength;
    const grow = observingMap(numberMap(2, later), () => {
      events.push('descriptor:later'); first.alloc(initialCapacity); first.buf[first.used - 1] = 123;
    });
    for (const arena of [first, later]) {
      const original = arena.copy.bind(arena);
      Object.defineProperty(arena, 'copy', { value() { events.push(`copy:${arena.id}`); return original(); } });
    }
    const data = getWorkerData({ root, grow }, { copy });
    assert(first.used > initialUsed); assert(first.memory.buffer.byteLength > initialCapacity);
    assert.equal(data.arenas[0].used, first.used);
    assert.deepEqual(events, ['descriptor:first', 'descriptor:later', ...copy ? ['copy:first', 'copy:later'] : []]);
    if (copy) {
      assert.equal(data.arenas[0].copy!.byteLength, first.used);
      assert.equal(data.arenas[0].copy![first.used - 1], 123);
    } else assert.equal(data.arenas[0].memory, first.memory);
  });

  it('preserves descriptor errors and unsupported-structure rejection before any final Arena read or copy', () => {
    for (const unsupported of [false, true]) {
      const first = new Arena({ id: 'first' }), root = numberMap(1, first), failure = new Error('descriptor failure');
      let usedReads = 0, copies = 0;
      Object.defineProperty(first, 'used', { get() { usedReads++; return 65536; } });
      Object.defineProperty(first, 'copy', { value() { copies++; throw new Error('unexpected copy'); } });
      const bad = unsupported ? {} : observingMap(numberMap(2, new Arena({ id: 'bad' })), () => { throw failure; });
      if (unsupported) assert.throws(() => getWorkerData({ root, bad } as never, { copy }), /Unsupported shared structure: bad/);
      else assert.throws(() => getWorkerData({ root, bad } as never, { copy }), error => error === failure);
      assert.equal(usedReads, 0); assert.equal(copies, 0);
    }
  });

  it('preserves errors on either initial membership or insertion ID read', () => {
    for (const throwAt of [1, 2]) {
      const arena = new Arena({ id: 'initial' }), root = numberMap(1, arena), failure = new Error('ID failure');
      let reads = 0, dependencyReads = 0;
      Object.defineProperty(arena, 'id', { get() { if (++reads === throwAt) throw failure; return 'valid'; } });
      Object.defineProperty(arena, 'transportDependencies', { get() { dependencyReads++; return arena.dependencies; } });
      assert.throws(() => getWorkerData({ root }, { copy }), error => error === failure);
      assert.equal(reads, throwAt); assert.equal(dependencyReads, 0);
    }
  });
});
