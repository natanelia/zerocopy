import { afterEach, describe, expect, it } from 'vitest';
import { SharedMap } from './shared';
import { arenaOf } from './arena';
import { createSharedState, connectSharedSession, type SharedEndpoint, type SharedState } from './worker';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function drain() { for (let i = 0; i < 50; i++) await Promise.resolve(); }

function record(size: number): Record<string, SharedMap<'number'>> {
  const result = Object.create(null);
  const value = new SharedMap('number').set('value', 1);
  for (let i = 0; i < size; i++) result[`root-${i}`] = value;
  return result;
}

// The protocol harness intentionally preserves synchronous application hooks.
// Real structured-clone workers remain covered by the existing worker proofs.
class Port implements SharedEndpoint {
  peer!: Port;
  sent: any[] = [];
  private listeners = new Map<string, Set<(event: any) => void>>();
  postMessage(data: any) {
    this.sent.push(data);
    queueMicrotask(() => {
      for (const callback of this.peer.listeners.get('message') ?? []) callback({ data });
    });
  }
  addEventListener(name: string, callback: (event: any) => void) {
    let listeners = this.listeners.get(name);
    if (!listeners) this.listeners.set(name, listeners = new Set());
    listeners.add(callback);
  }
  removeEventListener(name: string, callback: (event: any) => void) { this.listeners.get(name)?.delete(callback); }
  start() {}
}

describe('publication of already committed captures', () => {
  it.each([0, 1, 256])('keeps unchanged flush and publish quiet for %i record roots', async size => {
    const initial = record(size), state = createSharedState(initial);
    cleanup.push(() => state.dispose());
    const seen: number[] = [];
    state.subscribe((_value, version) => seen.push(version));
    const first = state.current;
    for (let i = 0; i < 5; i++) {
      expect(state.flush()).toBe(0);
      expect(state.publish({ ...state.current })).toBe(0);
      expect(state.current).toBe(first);
    }
    await drain();
    expect(state.version).toBe(0);
    expect(seen).toEqual([]);
  });

  it.each(['microtask', 'immediate'] as const)('keeps depth and version order with %s publication', async strategy => {
    const state = createSharedState(new SharedMap('number'), { publish: { strategy } });
    cleanup.push(() => state.dispose());
    const seen: [number, number | undefined][] = [];
    state.subscribe((value, version) => seen.push([version, value.get('n')]));
    state.batch(() => {
      expect(state.flush()).toBe(0);
      state.update(value => value.set('n', 1));
      expect(state.flush()).toBe(0);
      state.batch(() => {
        state.update(value => value.set('n', 2));
        expect(state.publish(state.current)).toBe(0);
      });
      expect(state.version).toBe(0);
    });
    expect(state.version).toBe(strategy === 'immediate' ? 1 : 0);
    expect(state.flush()).toBe(1);
    await drain();
    expect(seen).toEqual([[1, 2]]);
    expect(state.flush()).toBe(1);
    expect(state.publish(state.current)).toBe(1);
    expect(seen).toEqual([[1, 2]]);
  });

  it.each(['microtask', 'immediate'] as const)('compares distinct captures after a revert with %s publication', async strategy => {
    const initial = new SharedMap('number').set('n', 1);
    const state = createSharedState({ root: initial }, { publish: { strategy } });
    cleanup.push(() => state.dispose());
    const seen: [number, number | undefined][] = [];
    state.subscribe((value, version) => seen.push([version, value.root.get('n')]));
    state.batch(() => {
      state.update('root', value => value.set('n', 2));
      state.update(() => ({ root: initial }));
    });
    expect(state.flush()).toBe(0);
    await drain();
    expect(state.version).toBe(0);
    expect(seen).toEqual([]);
    expect(state.publish({ root: initial.set('n', 3) })).toBe(1);
    expect(state.flush()).toBe(1);
    await drain();
    expect(seen).toEqual([[1, 3]]);
  });

  it('still serializes every publish and observes a changed descriptor on the same frozen handle', () => {
    const first = new SharedMap('number').set('n', 1), second = first.set('n', 2);
    let descriptor = first.toWorkerData(), calls = 0;
    class ObservedMap extends SharedMap<'number'> {
      override toWorkerData() { calls++; return descriptor; }
    }
    const handle = new ObservedMap('number', first.root, first.size, arenaOf(first));
    const state = createSharedState(handle);
    cleanup.push(() => state.dispose());
    const seen: number[] = [];
    state.subscribe((_value, version) => seen.push(version));
    expect(Object.isFrozen(handle)).toBe(true);
    expect(calls).toBe(1);
    expect(state.publish(handle)).toBe(0);
    expect(calls).toBe(2);
    descriptor = second.toWorkerData();
    expect(state.publish(handle)).toBe(1);
    expect(calls).toBe(3);
    expect(state.publish(handle)).toBe(1);
    expect(calls).toBe(4);
    expect(seen).toEqual([1]);
  });

  it('preserves serializer failure and closed-state checks before returning a version', () => {
    let fail = false, calls = 0;
    const failure = new Error('serializer failed');
    class ObservedMap extends SharedMap<'number'> {
      override toWorkerData() { calls++; if (fail) throw failure; return super.toWorkerData(); }
    }
    const handle = new ObservedMap('number'), state = createSharedState(handle);
    cleanup.push(() => state.dispose());
    fail = true;
    expect(() => state.publish(handle)).toThrow(failure);
    expect(calls).toBe(2);
    expect(state.current).toBe(handle);
    expect(state.flush()).toBe(0);
    state.dispose();
    expect(() => state.flush()).toThrow(/closed/);
    expect(() => state.publish(handle)).toThrow(/closed/);
    expect(calls).toBe(2);
  });

  it('preserves descriptor getter effects during mandatory capture', () => {
    let reads = 0, fail = false;
    const failure = new Error('descriptor getter failed');
    class ObservedMap extends SharedMap<'number'> {
      override toWorkerData() {
        const descriptor = super.toWorkerData();
        return {
          get root() { reads++; if (fail) throw failure; return descriptor.root; },
          valueType: descriptor.valueType, size: descriptor.size,
        };
      }
    }
    const handle = new ObservedMap('number'), state = createSharedState(handle);
    cleanup.push(() => state.dispose());
    expect(reads).toBe(1);
    expect(state.publish(handle)).toBe(0);
    expect(reads).toBe(2);
    fail = true;
    expect(() => state.publish(handle)).toThrow(failure);
    expect(reads).toBe(3);
    expect(state.flush()).toBe(0);
  });

  it('preserves reentrant serialization and listener flush order', () => {
    let hook: (() => void) | undefined;
    class ObservedMap extends SharedMap<'number'> {
      override toWorkerData() { hook?.(); return super.toWorkerData(); }
    }
    const initial = new ObservedMap('number'), changed = initial.set('n', 1);
    const state: SharedState<SharedMap<'number'>> = createSharedState<SharedMap<'number'>>(initial);
    cleanup.push(() => state.dispose());
    const seen: [number, number | undefined][] = [];
    state.subscribe((value, version) => {
      seen.push([version, value.get('n')]);
      expect(state.flush()).toBe(version);
    });
    hook = () => {
      hook = undefined;
      expect(state.flush()).toBe(0);
      expect(state.publish(changed)).toBe(1);
    };
    expect(state.publish(initial)).toBe(2);
    expect(seen).toEqual([[1, 1], [2, undefined]]);
    expect(state.current).toBe(initial);
    expect(state.flush()).toBe(2);
  });

  it('rejects publication if serialization disposes the state', () => {
    let hook: (() => void) | undefined;
    class ObservedMap extends SharedMap<'number'> {
      override toWorkerData() { hook?.(); return super.toWorkerData(); }
    }
    const handle = new ObservedMap('number'), state = createSharedState(handle);
    cleanup.push(() => state.dispose());
    hook = () => state.dispose();
    expect(() => state.publish(handle)).toThrow(/closed/);
    expect(state.closed).toBe(true);
    expect(state.version).toBe(0);
    expect(() => state.flush()).toThrow(/closed/);
  });

  it.each([false, true])('keeps the initial handshake and later snapshots in copy=%s mode', async copy => {
    const owner = new Port(), remote = new Port(); owner.peer = remote; remote.peer = owner;
    const state = createSharedState(record(1), { copy, delivery: 'all' });
    cleanup.push(() => state.dispose());
    expect(state.flush()).toBe(0);
    const connecting = state.connect(owner);
    const reader = await connectSharedSession<Record<string, SharedMap<'number'>>>({ endpoint: remote });
    cleanup.push(() => reader.dispose());
    await connecting;
    const retained = reader.current['root-0'];
    expect(retained.get('value')).toBe(1);
    expect(reader.version).toBe(0);
    expect(owner.sent.filter(message => message.kind === 'snapshot')).toHaveLength(1);
    expect(state.publish({ ...state.current })).toBe(0);
    state.update('root-0', value => value.set('value', 2));
    expect(state.flush()).toBe(1);
    await drain();
    expect(reader.current['root-0'].get('value')).toBe(2);
    expect(retained.get('value')).toBe(1);
    expect(reader.version).toBe(1);
    expect(owner.sent.filter(message => message.kind === 'snapshot')).toHaveLength(2);
  });
});
