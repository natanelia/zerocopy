import { afterEach, describe, expect, it } from 'vitest';
import { SharedMap, SharedList, SharedSet, resetMap, compact, getWorkerData, initWorker } from './shared';
import { Arena, arenaOf } from './arena';
import { createSharedState, createSharedSession, connectSharedSession, shareWithWorker, receiveShared, type SharedValue, type StateOptions } from './worker';
import { bindRedux } from './worker-redux';

// Deterministic protocol unit harness. Real structured cloning is tested separately
// by proofs/worker-sessions.mjs and the Chromium module-worker suite.
class Port {
  peer!: Port;
  sent: any[] = [];
  handlers = new Map<string, Set<(event: any) => void>>();
  drop?: (data: any) => boolean;
  fail?: (data: any) => boolean;
  postMessage(data: any) {
    if (this.fail?.(data)) throw new Error('send failed');
    this.sent.push(data);
    if (!this.drop?.(data)) queueMicrotask(() => this.peer.emit('message', { data }));
  }
  addEventListener(name: string, fn: (event: any) => void) {
    let handlers = this.handlers.get(name); if (!handlers) this.handlers.set(name, handlers = new Set()); handlers.add(fn);
  }
  removeEventListener(name: string, fn: (event: any) => void) { this.handlers.get(name)?.delete(fn); }
  emit(name: string, event: any) { for (const fn of [...(this.handlers.get(name) ?? [])]) fn(event); }
  start() {}
  get count() { return [...this.handlers.values()].reduce((n, set) => n + set.size, 0); }
  get frames() { return this.sent.filter(item => item.kind === 'snapshot'); }
}
function ports() { const owner = new Port(), reader = new Port(); owner.peer = reader; reader.peer = owner; return { owner, reader }; }
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function drain() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
async function setup<T extends SharedValue>(initial: T, options: StateOptions = {}) {
  const pair = ports();
  const state = createSharedState(initial, { copy: false, ...options });
  cleanup.push(() => state.dispose());
  const connecting = state.connect(pair.owner);
  const reader = await connectSharedSession<T>({ endpoint: pair.reader });
  cleanup.push(() => reader.dispose());
  await connecting;
  return { state, reader, pair };
}

describe('shared state and session protocol', () => {
  it('automatically publishes a single collection and preserves old snapshots', async () => {
    const { state, reader } = await setup(new SharedMap('number').set('a', 1));
    const old = reader.current;
    state.update(map => map.set('a', 2));
    expect(state.current.get('a')).toBe(2);
    expect(state.version).toBe(0);
    await drain();
    expect(reader.current.get('a')).toBe(2);
    expect(old.get('a')).toBe(1);
    expect(() => reader.current.set('x', 3)).toThrow(/read-only/);
  });
  it('batches same-turn updates and supports the value setter', async () => {
    const { state, reader, pair } = await setup(new SharedMap('number'));
    state.update(map => map.set('a', 1)); state.update(map => map.set('b', 2));
    state.value = state.value.set('c', 3);
    await drain();
    expect(reader.current.size).toBe(3);
    expect(state.version).toBe(1);
    expect(pair.owner.frames.length).toBe(2);
  });
  it('suppresses no-ops, including newly allocated record wrappers', async () => {
    const { state, reader, pair } = await setup({ map: new SharedMap('number').set('a', 1) });
    const old = state.current, seen: number[] = [];
    state.subscribe((_, version) => seen.push(version));
    expect(state.flush()).toBe(0); expect(state.flush()).toBe(0);
    state.update(current => ({ ...current }));
    state.update('map', map => map); // Same handle, not deep value equality.
    expect(state.publish({ ...state.current })).toBe(0);
    await drain();
    expect(state.version).toBe(0); expect(pair.owner.frames.length).toBe(1);
    expect(state.current).toBe(old); expect(seen).toEqual([]);
    expect(state.publish({ map: old.map.set('a', 2) })).toBe(1);
    expect(state.flush()).toBe(1); expect(state.flush()).toBe(1);
    await drain();
    expect(state.version).toBe(1); expect(pair.owner.frames.length).toBe(2);
    expect(seen).toEqual([1]); expect(reader.current.map.get('a')).toBe(2);
    expect(old.map.get('a')).toBe(1);
  });
  it('does not publish an update that returns to the last committed snapshot', async () => {
    const { state, pair } = await setup(new SharedMap('number'));
    const original = state.current;
    state.update(map => map.set('x', 1)); state.value = original;
    await drain();
    expect(pair.owner.frames.length).toBe(1); expect(state.version).toBe(0);
  });
  it('suppresses distinct record captures restored to the last committed handles', async () => {
    const { state, pair } = await setup({ map: new SharedMap('number') });
    const original = state.current, seen: number[] = [];
    state.subscribe((_, version) => seen.push(version));
    state.update('map', map => map.set('x', 1)); state.value = { ...original };
    expect(state.current).not.toBe(original); expect(state.current.map).toBe(original.map);
    await drain();
    expect(pair.owner.frames.length).toBe(1); expect(state.version).toBe(0);
    expect(state.flush()).toBe(0); expect(state.flush()).toBe(0);
    expect(seen).toEqual([]);
    expect(state.publish({ map: original.map.set('x', 2) })).toBe(1);
    await drain();
    expect(pair.owner.frames.length).toBe(2); expect(seen).toEqual([1]);
    expect(original.map.has('x')).toBe(false);
  });
  it('publishes record roots atomically and preserves unchanged wrapper identity', async () => {
    const { state, reader } = await setup({ map: new SharedMap('number'), list: new SharedList('number').push(1) });
    const oldList = reader.current.list;
    state.update('map', map => map.set('a', 2)); await drain();
    expect(reader.current.list).toBe(oldList);
    expect(Object.isFrozen(reader.current)).toBe(true);
    expect(reader.current.map.get('a')).toBe(2);
  });
  it.each(['immediate', 'microtask'] as const)('batches nested and empty updates with %s publication', async strategy => {
    const { state, reader, pair } = await setup({ map: new SharedMap('number') }, { publish: { strategy } });
    const seen: number[] = [];
    state.subscribe((_, version) => seen.push(version));
    state.batch(() => state.batch(() => {})); await drain();
    expect(state.version).toBe(0); expect(pair.owner.frames.length).toBe(1);
    expect(seen).toEqual([]);
    state.batch(() => {
      state.update('map', map => map.set('a', 1));
      state.batch(() => {
        state.update('map', map => map.set('b', 2));
        expect(state.flush()).toBe(0);
      });
      expect(state.version).toBe(0);
      expect(state.flush()).toBe(0);
    });
    expect(state.version).toBe(strategy === 'immediate' ? 1 : 0);
    await drain();
    expect(state.version).toBe(1); expect(reader.current.map.size).toBe(2);
    expect(pair.owner.frames.length).toBe(2); expect(seen).toEqual([1]);
    state.batch(() => state.batch(() => {})); await drain();
    expect(state.flush()).toBe(1); expect(pair.owner.frames.length).toBe(2);
    expect(seen).toEqual([1]);
  });
  it('flushes pending publication without a duplicate microtask publication', async () => {
    const { state, pair } = await setup(new SharedMap('number'));
    state.update(map => map.set('a', 1)); expect(state.flush()).toBe(1);
    await drain(); expect(pair.owner.frames.length).toBe(2);
  });
  it('flushes newer pending state installed by a publication subscriber', async () => {
    const original = new SharedMap('number').set('x', 0);
    const first = original.set('x', 1), pending = first.set('x', 2);
    const state = createSharedState(original), seen: [number, number][] = [];
    cleanup.push(() => state.dispose());
    state.subscribe((map, version) => {
      seen.push([version, map.get('x')!]);
      if (version === 1) state.update(() => pending);
    });
    expect(state.publish(first)).toBe(1);
    expect(state.current).toBe(pending); expect(state.version).toBe(1);
    expect(seen).toEqual([[1, 1]]);
    expect(state.flush()).toBe(2); expect(state.flush()).toBe(2);
    await drain();
    expect(state.version).toBe(2); expect(state.current).toBe(pending);
    expect(seen).toEqual([[1, 1], [2, 2]]);
    expect(original.get('x')).toBe(0); expect(first.get('x')).toBe(1);
  });
  it('keeps the manual session API', async () => {
    const pair = ports(), session = createSharedSession(new SharedMap('number'), { copy: false });
    cleanup.push(() => session.dispose());
    const ready = session.connect(pair.owner);
    const reader = await connectSharedSession<SharedMap<'number'>>({ endpoint: pair.reader });
    cleanup.push(() => reader.dispose()); await ready;
    session.publish(session.current.set('x', 5)); await drain(); expect(reader.current.get('x')).toBe(5);
  });
  it('handles a reader that starts first', async () => {
    const pair = ports(), receiving = connectSharedSession<SharedMap<'number'>>({ endpoint: pair.reader });
    await drain();
    const session = createSharedSession(new SharedMap('number').set('x', 3)); cleanup.push(() => session.dispose());
    await session.connect(pair.owner); const reader = await receiving; cleanup.push(() => reader.dispose());
    expect(reader.current.get('x')).toBe(3);
  });
  it('shares memory handles once per connection, then sends descriptors', async () => {
    const { state, pair } = await setup(new SharedMap('number'));
    state.update(map => map.set('x', 2)); await drain();
    expect(pair.owner.frames[0].data.arenas.every((a: any) => a.memory && !a.copy)).toBe(true);
    expect(pair.owner.frames[1].data.arenas.every((a: any) => !a.memory && !a.copy)).toBe(true);
  });
  it('copies every publication only when copy mode is selected', async () => {
    const { state, reader, pair } = await setup(new SharedMap('number'), { copy: true });
    state.update(map => map.set('x', 2)); await drain();
    expect(reader.current.get('x')).toBe(2);
    expect(pair.owner.frames.every(frame => frame.data.arenas.every((a: any) => a.copy && !a.memory))).toBe(true);
  });
  it('does not confuse identical root offsets from different arenas', async () => {
    resetMap(); const first = new SharedMap('number').set('a', 1);
    resetMap(); const second = new SharedMap('number').set('a', 2);
    expect(first.root).toBe(second.root);
    const { state, reader, pair } = await setup(first);
    state.value = second; await drain();
    expect(reader.current.get('a')).toBe(2); expect(state.version).toBe(1);
    expect(pair.owner.frames[1].data.arenas[0].memory).toBeTruthy();
  });
  it('attaches nested dependencies and keeps old nested values readable', async () => {
    resetMap(); const child = new SharedMap('number').set('x', 1);
    resetMap(); const parent = new SharedMap('SharedMap<number>').set('child', child);
    const { state, reader } = await setup(parent); const old = reader.current;
    resetMap(); const nextChild = new SharedMap('number').set('x', 99);
    state.update(map => map.set('child', nextChild)); await drain();
    expect(reader.current.get('child')!.get('x')).toBe(99);
    expect(old.get('child')!.get('x')).toBe(1);
  });
  it('attaches a compacted arena without invalidating retained snapshots', async () => {
    const { state, reader } = await setup(new SharedMap('number').set('x', 1)); const old = reader.current;
    state.value = compact(state.current); await drain();
    expect(reader.current.get('x')).toBe(1); expect(old.get('x')).toBe(1);
  });
  it('connects multiple readers and can disconnect one without closing its port', async () => {
    const a = ports(), b = ports(), session = createSharedState(new SharedMap('number'));
    cleanup.push(() => session.dispose());
    const ready = session.connect([a.owner, b.owner]);
    const [ra, rb] = await Promise.all([connectSharedSession<SharedMap<'number'>>({ endpoint: a.reader }), connectSharedSession<SharedMap<'number'>>({ endpoint: b.reader })]);
    cleanup.push(() => ra.dispose(), () => rb.dispose()); await ready;
    session.disconnect(a.owner); session.update(map => map.set('x', 7)); await drain();
    expect(ra.closed).toBe(true); expect(rb.current.get('x')).toBe(7);
    expect(a.owner.count).toBe(0);
  });
  it('isolates named sessions on one endpoint and leaves ordinary messages alone', async () => {
    const pair = ports(); let ordinary = 0;
    pair.reader.addEventListener('message', event => { if (event.data.ordinary) ordinary++; });
    const a = createSharedState(new SharedMap('number').set('a', 1), { channel: 'a' });
    const b = createSharedState(new SharedMap('number').set('b', 2), { channel: 'b' });
    cleanup.push(() => a.dispose(), () => b.dispose());
    const ready = Promise.all([a.connect(pair.owner), b.connect(pair.owner)]);
    const [ra, rb] = await Promise.all([connectSharedSession<SharedMap<'number'>>({ endpoint: pair.reader, channel: 'a' }), connectSharedSession<SharedMap<'number'>>({ endpoint: pair.reader, channel: 'b' })]);
    cleanup.push(() => ra.dispose(), () => rb.dispose()); await ready;
    pair.owner.postMessage({ ordinary: true }); await drain();
    expect(ordinary).toBe(1); expect(ra.current.get('a')).toBe(1); expect(rb.current.get('b')).toBe(2);
  });
  it('bounds in-flight latest delivery while a reader does not acknowledge', async () => {
    const { state, reader, pair } = await setup(new SharedMap('number'));
    pair.reader.drop = data => data.kind === 'ack';
    state.publish(state.current.set('x', 1)); await drain();
    for (let i = 2; i <= 100; i++) state.publish(state.current.set('x', i));
    await drain(); expect(pair.owner.frames.length).toBe(2);
    pair.reader.drop = undefined;
    pair.reader.postMessage(pair.reader.sent.filter(data => data.kind === 'ack').at(-1));
    await drain(); expect(reader.current.get('x')).toBe(100); expect(pair.owner.frames.length).toBe(3);
  });
  it('supports every-publication delivery with a bounded queue', async () => {
    const { state, reader } = await setup(new SharedMap('number'), { delivery: 'all' });
    const seen: number[] = []; reader.subscribe(map => seen.push(map.get('x')!));
    state.publish(state.current.set('x', 1)); state.publish(state.current.set('x', 2)); state.publish(state.current.set('x', 3));
    await drain(); expect(seen).toEqual([1, 2, 3]);
  });
  it('reports queue overflow instead of silently dropping all-mode snapshots', async () => {
    const errors: Error[] = [];
    const { state, pair } = await setup(new SharedMap('number'), { delivery: 'all', maxPending: 1, onError: error => errors.push(error) });
    pair.reader.drop = data => data.kind === 'ack';
    state.publish(state.current.set('x', 1)); await drain();
    state.publish(state.current.set('x', 2)); state.publish(state.current.set('x', 3)); await drain();
    expect(errors.some(error => /overflow/.test(error.message))).toBe(true); expect(pair.owner.count).toBe(0);
  });
  it('supports latest-only async iteration and closes pending reads on disposal', async () => {
    const { state, reader } = await setup(new SharedMap('number'));
    const stream = reader.snapshots(); expect((await stream.next()).value.size).toBe(0);
    state.publish(state.current.set('x', 1)); await drain();
    state.publish(state.current.set('x', 2)); await drain();
    expect((await stream.next()).value.get('x')).toBe(2);
    const pending = stream.next(); reader.dispose(); expect((await pending).done).toBe(true);
  });
  it('rejects a bounded all-mode iterator on overflow', async () => {
    const { state, reader } = await setup(new SharedMap('number'));
    const stream = reader.snapshots({ strategy: 'all', capacity: 1 });
    state.publish(state.current.set('x', 1)); await drain();
    await expect(stream.next()).rejects.toThrow(/overflow/);
  });
  it('supports aborting a pending stream', async () => {
    const { reader } = await setup(new SharedMap('number')); const abort = new AbortController();
    const stream = reader.snapshots({ emitCurrent: false, signal: abort.signal });
    const pending = stream.next(); abort.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped'); expect(reader.closed).toBe(false);
  });
  it('keeps the session alive when a subscriber throws', async () => {
    const pair = ports(), errors: Error[] = [];
    const owner = createSharedState(new SharedMap('number')); cleanup.push(() => owner.dispose());
    const ready = owner.connect(pair.owner);
    const reader = await connectSharedSession<SharedMap<'number'>>({ endpoint: pair.reader, onError: error => errors.push(error) }); cleanup.push(() => reader.dispose()); await ready;
    reader.subscribe(() => { throw new Error('callback failed'); });
    owner.update(map => map.set('x', 1)); await drain(); expect(reader.current.get('x')).toBe(1); expect(errors).toHaveLength(1);
  });
  it('rejects a failed send and releases the channel for reuse', async () => {
    const pair = ports(), owner = createSharedState(new SharedMap('number')); cleanup.push(() => owner.dispose());
    pair.owner.fail = data => data.kind === 'offer';
    await expect(owner.connect(pair.owner)).rejects.toThrow('send failed'); expect(pair.owner.count).toBe(0);
    pair.owner.fail = undefined;
    const ready = owner.connect(pair.owner); const reader = await connectSharedSession({ endpoint: pair.reader }); cleanup.push(() => reader.dispose()); await ready;
  });
  it('rejects initialization timeout and removes listeners', async () => {
    const pair = ports(), owner = createSharedState(new SharedMap('number'), { timeoutMs: 10 }); cleanup.push(() => owner.dispose());
    await expect(owner.connect(pair.owner)).rejects.toThrow(/timed out/); expect(pair.owner.count).toBe(0);
  });
  it('rejects a connection when aborted', async () => {
    const pair = ports(), owner = createSharedState(new SharedMap('number')); cleanup.push(() => owner.dispose()); const abort = new AbortController();
    const pending = owner.connect(pair.owner, { signal: abort.signal }); abort.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop'); expect(pair.owner.count).toBe(0);
  });
  it('cancels scheduled publication and closes readers on disposal', async () => {
    const { state, reader, pair } = await setup(new SharedMap('number'));
    state.update(map => map.set('x', 1)); state.dispose();
    expect(() => state.flush()).toThrow('Shared session is closed');
    await drain();
    expect(() => state.flush()).toThrow('Shared session is closed');
    expect(state.version).toBe(0);
    expect(pair.owner.frames.length).toBe(1); expect(reader.closed).toBe(true); expect(pair.owner.count).toBe(0); expect(pair.reader.count).toBe(0);
  });
  it('rejects unsupported state without changing the current value', () => {
    const state = createSharedState(new SharedMap('number')); cleanup.push(() => state.dispose());
    const old = state.current;
    expect(() => state.update((() => Promise.resolve(old)) as any)).toThrow();
    expect(() => state.update(() => { state.update(map => map); return old; })).toThrow(/recursively/);
    expect(state.current).toBe(old);
    let called = false;
    expect(() => createSharedState({ get bad() { called = true; return old; } })).toThrow(/getters/);
    expect(called).toBe(false);
  });
  it('supports the one-shot helpers', async () => {
    const pair = ports();
    const sending = shareWithWorker(pair.owner, { map: new SharedMap('number').set('x', 9) }, { copy: false });
    const value = await receiveShared<{ map: SharedMap<'number'> }>({ endpoint: pair.reader });
    await sending; expect(value.map.get('x')).toBe(9); await drain();
    expect(pair.owner.count + pair.reader.count).toBe(0);
  });
  it('binds Redux selections and unsubscribes on disposal', async () => {
    let state = { map: new SharedMap('number'), sidebarOpen: false };
    const listeners = new Set<() => void>();
    const store = { getState: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    const owner = bindRedux(store, { select: value => ({ map: value.map }) }); cleanup.push(() => owner.dispose());
    state = { ...state, sidebarOpen: true }; for (const listener of listeners) listener(); await drain(); expect(owner.version).toBe(0);
    state = { ...state, map: state.map.set('x', 1) }; for (const listener of listeners) listener(); await drain(); expect(owner.version).toBe(1);
    owner.dispose(); expect(listeners.size).toBe(0);
  });
  it('covers a source update made while subscribe is installed', async () => {
    let value = new SharedSet<string>(); let removed = false;
    const session = createSharedSession({ source: { getSnapshot: () => value, subscribe: () => { value = value.add('ready'); return () => { removed = true; }; } } }); cleanup.push(() => session.dispose());
    await drain(); expect(session.current.has('ready')).toBe(true); session.dispose(); expect(removed).toBe(true);
  });
  it('does not allocate in the source arena during publication', async () => {
    const map = new SharedMap('number').set('x', 1), arena = arenaOf(map), used = arena.used;
    const { state } = await setup(map); state.publish(map); await drain(); expect(arena.used).toBe(used);
  });
});

describe('later session native readers', () => {
  const isBorrowed = (value: object) => typeof Object.getOwnPropertyDescriptor(arenaOf(value), 'wasm')!.get === 'function';

  it('reuses native reads with fresh decoded caches and independent used bounds through growth', async () => {
    const owner = new Arena(), original = new SharedMap('object', 0, 0, owner).set('same', { value: 1 });
    const { state, reader } = await setup(original);
    const first = reader.current, a = arenaOf(first), firstUsed = a.used, firstJSON = first.get('same');
    expect(isBorrowed(first)).toBe(false);
    owner.alloc(owner.memory.buffer.byteLength);
    state.publish(original.set('other', { value: 2 })); await drain();
    const second = reader.current, b = arenaOf(second), secondUsed = b.used, secondJSON = second.get('same');
    expect(isBorrowed(second)).toBe(true);
    expect(b).not.toBe(a); expect(b.wasm).not.toBe(a.wasm);
    expect(b.nativeReads.mapSize).toBe(a.nativeReads.mapSize);
    expect(secondJSON).toEqual(firstJSON); expect(secondJSON).not.toBe(firstJSON);
    expect(second.get('same')).toBe(secondJSON); expect(first.get('same')).toBe(firstJSON);
    expect(secondUsed).toBeGreaterThan(firstUsed);
    owner.alloc(owner.memory.buffer.byteLength);
    expect(a.wasm.getHeapEnd() >>> 0).toBe(firstUsed);
    expect(b.wasm.getHeapEnd() >>> 0).toBe(secondUsed);
    for (const [snapshot, used] of [[first, firstUsed], [second, secondUsed]] as const) {
      const arena = arenaOf(snapshot);
      expect(arena.used).toBe(used); expect(arena.state().heapEnd).toBe(used);
      const shared = getWorkerData({ snapshot }, { copy: false }).arenas[0];
      const copied = getWorkerData({ snapshot }, { copy: true }).arenas[0];
      expect(shared.used).toBe(used); expect(copied.used).toBe(used); expect(copied.copy!.length).toBe(used);
    }
    state.publish(state.current.set('third', { value: 3 })); await drain();
    expect(arenaOf(reader.current).nativeReads.mapSize).toBe(a.nativeReads.mapSize);
    expect(reader.current.get('same')).not.toBe(secondJSON);
    const raw = await initWorker(getWorkerData({ map: state.current }, { copy: false }));
    expect(isBorrowed(raw.map)).toBe(false);
    reader.dispose(); expect(first.get('same')).toBe(firstJSON); expect(second.get('same')).toBe(secondJSON);
  });

  it('keeps deferred nested ownership and complete fresh registries during factory reentrancy', async () => {
    const childA = new SharedMap('number', 0, 0, new Arena()).set('value', 1);
    const childB = new SharedMap('number', 0, 0, new Arena()).set('value', 2);
    const owner = new Arena(), parent = new SharedMap('SharedMap<number>', 0, 0, owner).set('child', childA);
    const { state, reader } = await setup(parent);
    const first = reader.current, oldRegistry = arenaOf(first).transportDependencies;
    const next = parent.set('child', childB);
    owner.dependencies.delete(arenaOf(childA).id);
    const factory = SharedMap.fromWorkerData;
    let calls = 0;
    SharedMap.fromWorkerData = ((root: number, type: any, size: number, source: Arena) => {
      const value = factory(root, type, size, source);
      if (source.id === owner.id) {
        calls++;
        expect(source.transportDependencies).not.toBe(oldRegistry);
        expect(source.transportDependencies.has(arenaOf(childB).id)).toBe(true);
        expect(source.transportDependencies.has(arenaOf(childA).id)).toBe(false);
        expect(first.get('child')!.get('value')).toBe(1);
        owner.alloc(owner.memory.buffer.byteLength);
        expect((value as SharedMap<'SharedMap<number>'>).get('child')!.get('value')).toBe(2);
      }
      return value;
    }) as typeof SharedMap.fromWorkerData;
    try { state.publish(next); await drain(); } finally { SharedMap.fromWorkerData = factory; }
    expect(calls).toBe(1); expect(isBorrowed(reader.current)).toBe(true);
    expect(reader.current.get('child')!.get('value')).toBe(2);
    expect(first.get('child')!.get('value')).toBe(1);
    expect(oldRegistry.has(arenaOf(childA).id)).toBe(true);
    expect(oldRegistry.has(arenaOf(childB).id)).toBe(false);
    expect(arenaOf(first).transportDependencies).toBe(oldRegistry);
  });

  it('preserves eager copy/fresh/missing-donor fallbacks and retires removed IDs', async () => {
    const make = (value: number) => new SharedMap('number', 0, 0, new Arena()).set('value', value);
    const copy = await setup(make(1), { copy: true });
    copy.state.publish(copy.state.current.set('value', 2)); await drain();
    expect(isBorrowed(copy.reader.current)).toBe(false);
    const a = make(1), b = make(2);
    const session = await setup({ a, b });
    const retained = session.reader.current;
    session.state.publish({ a: a.set('value', 3) } as any); await drain();
    const changedA = session.reader.current.a;
    expect(isBorrowed(changedA)).toBe(true);
    session.state.publish({ a: session.state.current.a.set('value', 4), b } as any); await drain();
    expect(isBorrowed(session.reader.current.a)).toBe(true);
    expect(isBorrowed(session.reader.current.b)).toBe(false);
    const fresh = compact(session.state.current.a);
    session.state.publish({ a: fresh } as any); await drain();
    expect(isBorrowed(session.reader.current.a)).toBe(false);
    session.reader.dispose();
    expect(retained.a.get('value')).toBe(1); expect(retained.b.get('value')).toBe(2);
    expect(changedA.get('value')).toBe(3);

    // A retained unchanged root may lack a newly added dependency. Recovering
    // that absent donor must fall back, rather than borrowing stale metadata.
    const root = make(8), late = make(9), spare = make(0), missing = await setup({ root, spare });
    const retainedRoot = missing.reader.current.root;
    arenaOf(root).dependencies.set(arenaOf(late).id, arenaOf(late));
    // Removing spare forces publication without changing root's descriptor.
    // The new wire has late, but the retained root keeps its older registry.
    missing.state.publish({ root } as any); await drain();
    expect(missing.reader.current.root).toBe(retainedRoot);
    expect(missing.pair.owner.frames.at(-1).data.arenas.some((source: any) => source.id === arenaOf(late).id)).toBe(true);
    expect(arenaOf(retainedRoot).transportDependencies.has(arenaOf(late).id)).toBe(false);
    const factory = SharedMap.fromWorkerData;
    const seen: Arena[] = [];
    SharedMap.fromWorkerData = ((r: number, t: any, n: number, source: Arena) => {
      seen.push(source); return factory(r, t, n, source);
    }) as typeof SharedMap.fromWorkerData;
    try {
      missing.state.publish({ root: root.set('value', 10) } as any); await drain();
    } finally { SharedMap.fromWorkerData = factory; }
    expect(seen).toHaveLength(1);
    const dependency = seen[0].transportDependencies.get(arenaOf(late).id)!;
    expect(Object.getOwnPropertyDescriptor(dependency, 'wasm')!.get).toBeUndefined();
    expect(missing.reader.current.root.get('value')).toBe(10);
  });

  it('calls current factories for unchanged handles and retains failed-factory views', async () => {
    const pair = ports(), errors: Error[] = [];
    const a = new SharedMap('number', 0, 0, new Arena()).set('value', 1);
    const b = new SharedMap('number', 0, 0, new Arena()).set('value', 2);
    const state = createSharedState({ a, b }, { copy: false, onError: error => errors.push(error) });
    cleanup.push(() => state.dispose());
    const connected = state.connect(pair.owner);
    const reader = await connectSharedSession<typeof state.current>({ endpoint: pair.reader, onError: error => errors.push(error) });
    cleanup.push(() => reader.dispose()); await connected;
    const retained = reader.current, factory = SharedMap.fromWorkerData;
    const calls: string[] = []; let leaked: SharedMap<'number'> | undefined, fail = false;
    SharedMap.fromWorkerData = ((root: number, type: any, size: number, source: Arena) => {
      calls.push(source.id);
      const value = factory(root, type, size, source);
      if (source.id === arenaOf(a).id) leaked = value as SharedMap<'number'>;
      if (fail && source.id === arenaOf(b).id) throw new Error('later factory failed');
      return value;
    }) as typeof SharedMap.fromWorkerData;
    try {
      state.publish({ a, b: b.set('value', 3) }); await drain();
      expect(calls).toEqual([arenaOf(a).id, arenaOf(b).id]);
      expect(reader.current.a).toBe(retained.a);
      expect(isBorrowed(leaked!)).toBe(true);
      const acceptedVersion = reader.version, acknowledgements = pair.reader.sent.filter(item => item.kind === 'ack').length;
      calls.length = 0; fail = true;
      state.publish({ a: a.set('value', 4), b: state.current.b.set('value', 5) }); await drain();
      expect(reader.closed).toBe(true); expect(reader.version).toBe(acceptedVersion);
      expect(pair.reader.sent.filter(item => item.kind === 'ack')).toHaveLength(acknowledgements);
      expect(errors.some(error => error.message === 'later factory failed')).toBe(true);
      expect(leaked!.get('value')).toBe(4);
      expect(retained.a.get('value')).toBe(1); expect(retained.b.get('value')).toBe(2);
    } finally { SharedMap.fromWorkerData = factory; }
  });

  it('keeps raw attachment validation errors ahead of later session factories', async () => {
    const changes: ((data: any) => any)[] = [
      data => ({ ...data, version: 3 }),
      data => ({ ...data, arenas: data.arenas.map((source: any) => ({ ...source, used: 65535 })) }),
      data => ({ ...data, structures: { value: { ...data.structures.value, type: 'compact' } } }),
      data => ({ ...data, structures: { value: { ...data.structures.value, type: '__proto__' } } }),
    ];
    for (const change of changes) {
      const pair = ports(), errors: Error[] = [];
      const memory = new WebAssembly.Memory({ initial: 2, maximum: 8, shared: true });
      const map = new SharedMap('number', 0, 0, new Arena({ memory })).set('value', 1);
      const state = createSharedState(map, { copy: false, onError: () => {} }); cleanup.push(() => state.dispose());
      const connected = state.connect(pair.owner);
      const reader = await connectSharedSession<SharedMap<'number'>>({ endpoint: pair.reader, onError: error => errors.push(error) });
      cleanup.push(() => reader.dispose()); await connected;
      const retained = reader.current, frame = pair.owner.frames[0];
      const raw = change(frame.data);
      let expected: Error | undefined;
      try { await initWorker(raw); } catch (error) { expected = error as Error; }
      expect(expected).toBeInstanceOf(Error);
      const factory = SharedMap.fromWorkerData; let calls = 0;
      SharedMap.fromWorkerData = ((...args: any[]) => { calls++; return (factory as any)(...args); }) as typeof SharedMap.fromWorkerData;
      try {
        // Later frames omit known memory handles, as the real publisher does.
        const data = { ...raw, arenas: raw.arenas.map(({ memory: _memory, ...source }: any) => source) };
        pair.reader.emit('message', { data: { ...frame, sequence: 1, data } }); await drain();
      } finally { SharedMap.fromWorkerData = factory; }
      expect(calls).toBe(0); expect(reader.closed).toBe(true);
      expect(errors).toHaveLength(1); expect(errors[0].message).toBe(expected!.message);
      expect(reader.version).toBe(0); expect(retained.get('value')).toBe(1);
      expect(pair.reader.sent.filter(item => item.kind === 'ack')).toHaveLength(1);
    }
  });

  it('keeps the native ceiling fallback eager with a synthetic capacity seam', async () => {
    const pair = ports(), errors: Error[] = [];
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 8, shared: true });
    const map = new SharedMap('number', 0, 0, new Arena({ memory })).set('value', 1);
    const state = createSharedState(map, { copy: false, onError: () => {} }); cleanup.push(() => state.dispose());
    const connected = state.connect(pair.owner);
    const reader = await connectSharedSession<SharedMap<'number'>>({ endpoint: pair.reader, onError: error => errors.push(error) });
    cleanup.push(() => reader.dispose()); await connected;
    const retained = reader.current, frame = pair.owner.frames[0], originalBuffer = Object.getOwnPropertyDescriptor(memory, 'buffer');
    const raw = { ...frame.data, arenas: frame.data.arenas.map((source: any) => ({ ...source, used: 0x7fff0001 })) };
    const factory = SharedMap.fromWorkerData; let calls = 0, expected: Error | undefined;
    SharedMap.fromWorkerData = ((...args: any[]) => { calls++; return (factory as any)(...args); }) as typeof SharedMap.fromWorkerData;
    try {
      // Synthetic JS validation seam only: native imports still receive this
      // genuine two-page Memory. This does not test oversized Memory transport.
      Object.defineProperty(memory, 'buffer', { configurable: true, value: { byteLength: 0x80000000 } });
      try { await initWorker(raw); } catch (error) { expected = error as Error; }
      expect(expected).toBeInstanceOf(WebAssembly.RuntimeError);
      expect(calls).toBe(0);
      const data = { ...raw, arenas: raw.arenas.map(({ memory: _memory, ...source }: any) => source) };
      pair.reader.emit('message', { data: { ...frame, sequence: 1, data } }); await drain();
      expect(calls).toBe(0); expect(reader.closed).toBe(true);
      expect(errors).toHaveLength(1); expect(errors[0]).toBeInstanceOf(WebAssembly.RuntimeError);
      expect(errors[0].message).toBe(expected!.message);
      expect(reader.version).toBe(0);
      expect(pair.reader.sent.filter(item => item.kind === 'ack')).toHaveLength(1);
    } finally {
      SharedMap.fromWorkerData = factory;
      if (originalBuffer) Object.defineProperty(memory, 'buffer', originalBuffer);
      else delete (memory as any).buffer;
    }
    expect(retained.get('value')).toBe(1);
    expect(memory.buffer.byteLength).toBe(2 * 65536);
  });
});
