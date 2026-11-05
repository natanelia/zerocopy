import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import {
  SharedMap, SharedList, SharedSet, SharedStack, SharedQueue,
  SharedLinkedList, SharedDoublyLinkedList, SharedOrderedMap, SharedOrderedSet,
  SharedSortedMap, SharedSortedSet, SharedPriorityQueue, getWorkerData, initWorker,
} from './shared';

type Spec = {
  name: string; ctor: new (...args: any[]) => any; args: (a: Arena) => any[];
  populate: (value: any) => any; read: (value: any) => unknown;
};
const entries = (value: any) => [...value.entries()];
const values = (value: any) => [...value.values()];
const sequence = (value: any, next: 'pop' | 'dequeue') => {
  const result = [];
  while (!value.isEmpty) { result.push(value.peek()); value = value[next](); }
  return result;
};
const specs: Spec[] = [
  { name: 'SharedMap', ctor: SharedMap, args: a => ['number', 0, 0, a], populate: x => x.set('one', 1).set('two', 2), read: entries },
  { name: 'SharedList', ctor: SharedList, args: a => ['number', 0, 0, 0, a], populate: x => x.pushMany([1, 2]), read: x => x.toArray() },
  { name: 'SharedSet', ctor: SharedSet, args: a => [new SharedMap('number', 0, 0, a)], populate: x => x.add('one').add(2), read: values },
  { name: 'SharedStack', ctor: SharedStack, args: a => ['number', 0, 0, undefined, a], populate: x => x.push(1).push(2), read: x => sequence(x, 'pop') },
  { name: 'SharedQueue', ctor: SharedQueue, args: a => ['number', 0, 0, 0, undefined, a], populate: x => x.enqueue(1).enqueue(2), read: x => sequence(x, 'dequeue') },
  { name: 'SharedLinkedList', ctor: SharedLinkedList, args: a => ['number', 0, 0, 0, a], populate: x => x.append(1).append(2), read: x => x.toArray() },
  { name: 'SharedDoublyLinkedList', ctor: SharedDoublyLinkedList, args: a => ['number', 0, 0, 0, a], populate: x => x.append(1).append(2), read: x => x.toArray() },
  { name: 'SharedOrderedMap', ctor: SharedOrderedMap, args: a => ['number', 0, 0, 0, 0, a], populate: x => x.set('two', 2).set('one', 1), read: entries },
  { name: 'SharedOrderedSet', ctor: SharedOrderedSet, args: a => [new SharedOrderedMap('number', 0, 0, 0, 0, a)], populate: x => x.add('two').add(1), read: values },
  { name: 'SharedSortedMap', ctor: SharedSortedMap, args: a => ['number', undefined, 0, 0, a], populate: x => x.set('two', 2).set('one', 1), read: entries },
  { name: 'SharedSortedSet', ctor: SharedSortedSet, args: a => [undefined, new SharedSortedMap('number', undefined, 0, 0, a)], populate: x => x.add('two').add(1), read: values },
  { name: 'SharedPriorityQueue', ctor: SharedPriorityQueue, args: a => ['number', undefined, a], populate: x => x.enqueue(2, 20).enqueue(1, 10), read: entries },
];
const ordinaryHasInstance = Function.prototype[Symbol.hasInstance];
function withInstanceHooks<T>(events: string[], run: () => T,
  decide = (_name: string, ctor: Function, value: unknown) => Reflect.apply(ordinaryHasInstance, ctor, [value])): T {
  const saved = specs.map(spec => Object.getOwnPropertyDescriptor(spec.ctor, Symbol.hasInstance));
  try {
    for (const { name, ctor } of specs) Object.defineProperty(ctor, Symbol.hasInstance, {
      configurable: true,
      get() {
        events.push(`get:${name}`);
        return function(value: unknown) {
          assert.equal(this, ctor); events.push(`call:${name}`);
          return decide(name, ctor, value);
        };
      },
    });
    return run();
  } finally {
    specs.forEach(({ ctor }, i) => {
      if (saved[i]) Object.defineProperty(ctor, Symbol.hasInstance, saved[i]!);
      else Reflect.deleteProperty(ctor, Symbol.hasInstance);
    });
  }
}
const checks = (count: number) => specs.slice(0, count).flatMap(({ name }) => [`get:${name}`, `call:${name}`]);

describe('worker constructor dispatch', () => {
  it.each([false, true])('round-trips every registered type and alias without changing source bytes, copy=%s', async copy => {
    const arena = new Arena();
    const input = Object.fromEntries(specs.map(spec => [spec.name, spec.populate(new spec.ctor(...spec.args(arena)))]));
    input.alias = input.SharedPriorityQueue;
    const end = arena.used, before = arena.buf.slice(HEAP_START, end);
    const expected = specs.map(spec => spec.read(input[spec.name]));
    const packet = getWorkerData(input, { copy });
    assert.ok(Object.isFrozen(packet)); assert.ok(Object.isFrozen(packet.arenas)); assert.ok(Object.isFrozen(packet.structures));
    assert.equal(packet.arenas.length, 1); assert.equal(packet.arenas[0].id, arena.id);
    assert.equal(packet.arenas[0].used, end);
    if (copy) assert.deepEqual(packet.arenas[0].copy, arena.copy());
    else assert.equal(packet.arenas[0].memory, arena.memory);
    for (const spec of specs) {
      const item = packet.structures[spec.name];
      assert.equal(item.type, spec.name); assert.equal(item.arena, arena.id);
      assert.deepEqual(item.data, input[spec.name].toWorkerData()); assert.ok(Object.isFrozen(item));
    }
    assert.deepEqual(packet.structures.alias, packet.structures.SharedPriorityQueue);
    const attached = await initWorker(packet);
    specs.forEach((spec, i) => {
      assert.equal(attached[spec.name] instanceof spec.ctor, true);
      assert.deepEqual(spec.read(attached[spec.name]), expected[i]);
      assert.equal(arenaOf(attached[spec.name]).readOnly, true);
    });
    assert.deepEqual(entries(attached.alias), entries(input.alias));
    assert.equal(arena.used, end); assert.deepEqual(arena.buf.slice(HEAP_START, end), before);
  });

  it.each([false, true])('recognizes all subclasses without inspecting their constructor property, copy=%s', async copy => {
    const arena = new Arena(), source: Record<string, any> = {};
    for (const spec of specs) {
      class Derived extends spec.ctor {}
      Object.defineProperty(Derived.prototype, 'constructor', { get() { throw new Error('constructor must not be read'); } });
      source[spec.name] = new Derived(...spec.args(arena));
    }
    const packet = getWorkerData(source, { copy }), attached = await initWorker(packet);
    for (const spec of specs) {
      assert.equal(packet.structures[spec.name].type, spec.name);
      assert.equal(attached[spec.name] instanceof spec.ctor, true);
      assert.deepEqual(spec.read(attached[spec.name]), []);
    }
  });

  it('observes every hasInstance lookup and call in registry order until the first match', () => {
    const arena = new Arena(), inputs = specs.map(spec => new spec.ctor(...spec.args(arena)));
    const events: string[] = [];
    withInstanceHooks(events, () => {
      specs.forEach((spec, i) => {
        events.length = 0;
        assert.equal(getWorkerData({ value: inputs[i] }, { copy: false }).structures.value.type, spec.name);
        assert.deepEqual(events, checks(i + 1));
      });
    });
  });

  it('rechecks repeated values and respects a different first match on the next call', () => {
    const value = new SharedPriorityQueue('number'), events: string[] = [];
    let selected = 'SharedPriorityQueue';
    withInstanceHooks(events, () => {
      const first = getWorkerData({ a: value, b: value }, { copy: false });
      assert.equal(first.structures.a.type, selected); assert.equal(first.structures.b.type, selected);
      assert.deepEqual(events, [...checks(12), ...checks(12)]);
      events.length = 0; selected = 'SharedMap';
      const second = getWorkerData({ value }, { copy: false });
      assert.equal(second.structures.value.type, 'SharedMap'); assert.deepEqual(events, checks(1));
    }, name => name === selected);
  });

  it('preserves proxy prototype traps before ownership validation rejects a wrapped snapshot', () => {
    const events: string[] = [], value = new SharedPriorityQueue('number');
    const wrapped = new Proxy(value, {
      getPrototypeOf(target) { events.push('prototype'); return Reflect.getPrototypeOf(target); },
      get(target, key, receiver) { events.push(`property:${String(key)}`); return Reflect.get(target, key, receiver); },
    });
    withInstanceHooks(events, () => {
      assert.throws(() => getWorkerData({ wrapped }, { copy: false }), TypeError);
      assert.deepEqual(events, specs.flatMap(({ name }) => [`get:${name}`, `call:${name}`, 'prototype']));
    });
  });

  it('stops on throwing instance hooks before reading a serializer', () => {
    let serialized = 0;
    class Derived extends SharedPriorityQueue<'number'> {
      toWorkerData() { serialized++; return super.toWorkerData(); }
    }
    const value = new Derived('number'), events: string[] = [], failure = new Error('hook failed');
    withInstanceHooks(events, () => {
      assert.throws(() => getWorkerData({ value }, { copy: false }), error => error === failure);
      assert.deepEqual(events, checks(2)); assert.equal(serialized, 0);
    }, name => { if (name === 'SharedList') throw failure; return false; });
  });

  it('calls dynamic serializer accessors once per record entry with the original receiver', () => {
    const events: string[] = [];
    class Derived extends SharedPriorityQueue<'number'> {}
    const value = new Derived('number'), data = Object.freeze({ ...value.toWorkerData(), marker: 'override' });
    Object.defineProperty(Derived.prototype, 'toWorkerData', {
      configurable: true,
      get() {
        assert.equal(this, value); events.push('get');
        return function() { assert.equal(this, value); events.push('call'); return data; };
      },
    });
    const packet = getWorkerData({ first: value, alias: value }, { copy: false });
    assert.deepEqual(events, ['get', 'call', 'get', 'call']);
    assert.equal(packet.structures.first.data, data); assert.equal(packet.structures.alias.data, data);
  });

  it('keeps eager record getters ahead of dispatch and propagates serializer failures', () => {
    const events: string[] = [], failure = new Error('serializer failed');
    class Derived extends SharedPriorityQueue<'number'> {
      toWorkerData(): ReturnType<SharedPriorityQueue<'number'>['toWorkerData']> { events.push('serialize'); throw failure; }
    }
    const first = new Derived('number'), second = new SharedMap('number');
    const input = { get first() { events.push('first'); return first; }, get second() { events.push('second'); return second; } };
    assert.throws(() => getWorkerData(input, { copy: false }), error => error === failure);
    assert.deepEqual(events, ['first', 'second', 'serialize']);
  });

  it('rejects unsupported values only after all ordered checks and leaves symbol validation first', () => {
    const events: string[] = [];
    withInstanceHooks(events, () => {
      assert.throws(() => getWorkerData({ bad: {} } as never, { copy: false }), /Unsupported shared structure: bad/);
      assert.deepEqual(events, checks(12)); events.length = 0;
      assert.throws(() => getWorkerData({ [Symbol('bad')]: new SharedMap('number') } as never), /names must be strings/);
      assert.deepEqual(events, []);
    });
  });
});
