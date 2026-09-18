import { beforeEach, describe, expect, test } from 'vitest';
import {
  SharedMap, SharedList, SharedStack, SharedQueue, SharedLinkedList,
  SharedDoublyLinkedList, SharedOrderedMap, SharedSortedMap, SharedPriorityQueue,
  SharedSet, SharedOrderedSet, SharedSortedSet, json, list, map, stack, queue,
  linkedList, doublyLinkedList, orderedMap, sortedMap, priorityQueue,
  set, orderedSet, sortedSet, getWorkerData, initWorker, compact, compactMany,
  resetMap, resetSharedList, resetStack, resetQueue, resetLinkedList,
  resetDoublyLinkedList, resetOrderedMap, resetSortedMap, resetPriorityQueue,
} from './shared';
import { arenaOf } from './arena';
import { getCodec } from './codec';
import { stringifyJsonObject } from './json-value';

interface Lane {
  id: string;
  speedLimit: number;
  direction: 'forward' | 'reverse';
  label?: string;
  centerline: Array<[number, number]>;
  metadata: { revision: number | null };
}
const LaneValue = json<Lane>();
const lane = (id = 'lane-1'): Lane => ({
  id, speedLimit: 50, direction: 'forward', centerline: [[103.85, 1.29]],
  metadata: { revision: null },
});

beforeEach(() => {
  resetMap(); resetSharedList(); resetStack(); resetQueue(); resetLinkedList();
  resetDoublyLinkedList(); resetOrderedMap(); resetSortedMap(); resetPriorityQueue();
});

describe('typed JSON values', () => {
  test('keeps old snapshots, forks, input ownership, and deeply frozen reads', () => {
    const input = lane();
    const empty = new SharedMap(LaneValue);
    const old = empty.set('lane', input);
    input.speedLimit = 99;
    input.centerline[0][0] = 0;
    expect(Object.isFrozen(input)).toBe(false);
    expect(old.get('lane')).toEqual(lane());
    const read = old.get('lane')!;
    expect(old.get('lane')).toBe(read);
    for (const object of [read, read.metadata, read.centerline, read.centerline[0]]) {
      expect(Object.isFrozen(object)).toBe(true);
    }
    expect(() => { (read as Lane).speedLimit = 70; }).toThrow(TypeError);
    expect(() => { (read as Lane).centerline.push([0, 0]); }).toThrow(TypeError);
    const left = old.set('lane', { ...read, speedLimit: 30 });
    const right = old.set('lane', { ...read, direction: 'reverse' });
    expect(empty.size).toBe(0);
    expect(old.get('lane')?.speedLimit).toBe(50);
    expect(left.get('lane')?.speedLimit).toBe(30);
    expect(right.get('lane')?.direction).toBe('reverse');
    expect(left.delete('lane').size).toBe(0);
  });

  test('covers bulk operations, callbacks, arrays, and detached iteration tuples', () => {
    const first = lane('first'), last = lane('last');
    const values = new SharedMap(LaneValue).setMany([['first', first], ['last', last]]);
    expect(values.getMany(['first', 'missing'])).toEqual([first, undefined]);
    expect([...values.values()]).toEqual(expect.arrayContaining([first, last]));
    const seen: string[] = [];
    values.forEach((value, key) => { expect(Object.isFrozen(value)).toBe(true); seen.push(key); });
    expect(seen.sort()).toEqual(['first', 'last']);
    const entry = values.entries().next().value!;
    entry[0] = 'detached';
    expect(values.has('detached')).toBe(false);
    expect(values.setMany([])).toBe(values);
    const original = new SharedList(LaneValue).pushMany(Array.from({ length: 65 }, (_, i) => lane(String(i))));
    const changed = original.set(32, last).push(first).pop();
    expect(original.get(32)?.id).toBe('32');
    expect(changed.get(32)?.id).toBe('last');
    expect(changed.toArray()).toHaveLength(65);
    expect(changed.get(-1)).toBeUndefined();
    expect(changed.get(65)).toBeUndefined();
    changed.forEach(value => expect(Object.isFrozen(value.centerline)).toBe(true));
    expect(new SharedList(LaneValue).pushMany([]).size).toBe(0);
  });

  test.each([
    ['map', () => new SharedMap(LaneValue).set('lane', lane()), (s: any) => s.get('lane')],
    ['list', () => new SharedList(LaneValue).push(lane()), (s: any) => s.get(0)],
    ['stack', () => new SharedStack(LaneValue).push(lane()), (s: any) => s.peek()],
    ['queue', () => new SharedQueue(LaneValue).enqueue(lane()), (s: any) => s.peek()],
    ['linked list', () => new SharedLinkedList(LaneValue).append(lane()), (s: any) => s.getFirst()],
    ['doubly linked list', () => new SharedDoublyLinkedList(LaneValue).append(lane()), (s: any) => s.getLast()],
    ['ordered map', () => new SharedOrderedMap(LaneValue).set('lane', lane()), (s: any) => s.get('lane')],
    ['sorted map', () => new SharedSortedMap(LaneValue).set('lane', lane()), (s: any) => s.get('lane')],
    ['priority queue', () => new SharedPriorityQueue(LaneValue).enqueue(lane(), 1), (s: any) => s.peek()],
  ])('supports %s, worker reconstruction, and compaction', async (_name, create, read) => {
    const source = create();
    expect(read(source)).toEqual(lane());
    for (const copy of [false, true]) {
      const restored = await initWorker(getWorkerData({ source }, { copy }));
      expect(read(restored.source)).toEqual(lane());
      expect(Object.isFrozen(read(restored.source))).toBe(true);
    }
    const rebuilt = compact(source);
    expect(read(rebuilt)).toEqual(lane());
    expect(arenaOf(rebuilt)).not.toBe(arenaOf(source));
  });

  test('preserves nested descriptors through forks, compaction, growth, and resets', async () => {
    const children = new SharedList(LaneValue).push(lane());
    const tiles = new SharedMap(list(LaneValue)).set('tile', children);
    const regions = new SharedMap(map(list(LaneValue))).set('region', tiles);
    const next = regions.set('region', tiles.set('tile', children.push(lane('lane-2'))));
    const used = arenaOf(children).used;
    children.push({ ...lane('large'), label: '🙂'.repeat(100000) });
    expect(arenaOf(children).used).toBeGreaterThan(used);
    const compacted = compactMany({ regions, next });
    resetMap(); resetSharedList();
    for (const source of [regions, compacted.regions]) {
      const data = getWorkerData({ source }, { copy: false });
      const restored = await initWorker(data);
      const list = restored.source.get('region')!.get('tile')!;
      expect(list.size).toBe(1);
      expect(list.get(0)).toEqual(lane());
      expect(() => list.push(lane())).toThrow(/read-only/);
    }
    expect(compacted.next.get('region')?.get('tile')?.size).toBe(2);
    expect(regions.get('region')?.get('tile')?.size).toBe(1);
  });

  test('matches native JSON for plain values and keeps special keys as data', () => {
    const shared = { value: 'repeat' };
    const input = {
      text: 'quotes " slash \\ control \n unicode 🙂 \ud800',
      bool: true, nil: null, number: 1.25e20,
      array: [null, false, 0, 'text', { x: 2 }], first: shared, second: shared,
      empty: Object.create(null),
    };
    expect(stringifyJsonObject(input)).toBe(JSON.stringify(input));
    const special = JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}');
    const read = new SharedMap(json<Record<string, object | string>>()).set('special', special).get('special')!;
    expect(Object.hasOwn(read, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const array = new SharedList(json<Array<{ x: number }>>()).push([{ x: 1 }]).get(0)!;
    expect(array).toEqual([{ x: 1 }]);
    expect(Object.isFrozen(array[0])).toBe(true);
  });

  test('accepts a deep acyclic tree and rejects deep cycles without recursion overflow', () => {
    const root: Record<string, unknown> = {};
    let leaf = root;
    for (let i = 0; i < 12000; i++) { const child = {}; leaf.child = child; leaf = child; }
    leaf.value = 7;
    const encoded = stringifyJsonObject(root);
    expect(encoded.startsWith('{"child":')).toBe(true);
    let read = new SharedMap('json').set('tree', root as never).get('tree') as Record<string, unknown>;
    let frozen = true;
    for (let i = 0; i < 12000; i++) { frozen = frozen && Object.isFrozen(read); read = read.child as Record<string, unknown>; }
    expect(frozen).toBe(true);
    expect(read.value).toBe(7);
    leaf.cycle = root;
    expect(() => stringifyJsonObject(root)).toThrow(/cycles/);
  });

  test('preserves negative zero instead of normalizing it', () => {
    const source = new SharedList(json<{ coordinate: number }>()).push({ coordinate: -0 });
    expect(Object.is(source.get(0)!.coordinate, -0)).toBe(true);
    expect(stringifyJsonObject({ coordinate: -0 })).toBe('{"coordinate":-0}');
  });

  test('uses the strict serializer in the standalone codec too', () => {
    const codec = getCodec(LaneValue), input = lane();
    const bytes = new Uint8Array(codec.size(input) + 8);
    const length = codec.encode(input, bytes, 4);
    const read = codec.decode(bytes, 4, length);
    expect(read).toEqual(input);
    expect(Object.isFrozen(read.centerline[0])).toBe(true);
    expect(() => codec.size({ ...input, metadata: { revision: NaN } })).toThrow(TypeError);
  });

  test('keeps legacy object serialization unchanged', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const legacy = new SharedMap('object').set('legacy', { date, omitted: undefined, infinity: Infinity });
    expect(legacy.get('legacy')).toEqual({ date: date.toISOString(), infinity: null });
  });
});

describe('strict JSON rejection', () => {
  const invalid: Array<[string, () => unknown]> = [
    ['undefined', () => ({ x: undefined })],
    ['function', () => ({ x: () => 1 })],
    ['symbol value', () => ({ x: Symbol('x') })],
    ['bigint', () => ({ x: 1n })],
    ['NaN', () => ({ x: NaN })],
    ['Infinity', () => ({ x: Infinity })],
    ['negative infinity', () => ({ x: -Infinity })],
    ['Date', () => ({ x: new Date() })],
    ['Map', () => ({ x: new Map([['x', 1]]) })],
    ['Set', () => ({ x: new Set([1]) })],
    ['typed array', () => ({ x: new Uint8Array(2) })],
    ['class instance', () => new (class Record { x = 1 })()],
    ['nested shared list', () => ({ x: new SharedList('number').push(1) })],
    ['sparse array', () => ({ x: new Array(2) })],
    ['extra array property', () => ({ x: Object.assign([1], { extra: true }) })],
    ['symbol key', () => ({ [Symbol('key')]: 1 })],
    ['hidden data', () => Object.defineProperty({}, 'hidden', { value: 1 })],
    ['cycle', () => { const value: any = {}; value.self = value; return value; }],
    ['primitive root', () => 42],
    ['null root', () => null],
  ];
  test.each(invalid)('rejects %s without altering a published snapshot', (_name, make) => {
    const old = new SharedMap(LaneValue).set('lane', lane());
    const before = arenaOf(old).used;
    expect(() => old.set('invalid', make() as Lane)).toThrow(TypeError);
    expect(old.size).toBe(1);
    expect(old.get('lane')).toEqual(lane());
    expect(arenaOf(old).used).toBe(before);
    expect(() => new SharedList(LaneValue).push(make() as Lane)).toThrow(TypeError);
  });

  test('does not execute accessors or toJSON hooks', () => {
    let calls = 0;
    const getter = Object.defineProperty({}, 'x', { enumerable: true, get() { calls++; return 1; } });
    const hook = { toJSON() { calls++; return { x: 1 }; } };
    expect(() => stringifyJsonObject(getter)).toThrow(/data properties/);
    expect(() => stringifyJsonObject(hook)).toThrow(/function/);
    expect(calls).toBe(0);
  });

  test('cannot hide an unsupported value in a bulk write', () => {
    const old = new SharedMap(LaneValue).set('lane', lane());
    expect(() => old.setMany([['good', lane()], ['bad', { ...lane(), speedLimit: NaN }]])).toThrow(TypeError);
    expect(old.size).toBe(1);
    const original = new SharedList(LaneValue).push(lane());
    expect(() => original.pushMany([lane(), { ...lane(), speedLimit: NaN }])).toThrow(TypeError);
    expect(original.size).toBe(1);
  });
});

describe('nested descriptor helpers', () => {
  test.each([
    [map, 'SharedMap'], [list, 'SharedList'], [stack, 'SharedStack'], [queue, 'SharedQueue'],
    [linkedList, 'SharedLinkedList'], [doublyLinkedList, 'SharedDoublyLinkedList'],
    [orderedMap, 'SharedOrderedMap'], [sortedMap, 'SharedSortedMap'], [priorityQueue, 'SharedPriorityQueue'],
  ] as const)('%s retains the wire description for %s', (describe, name) => {
    expect(describe(LaneValue)).toBe(`${name}<json>`);
    expect(describe(list(LaneValue))).toBe(`${name}<SharedList<json>>`);
    expect(() => describe('SharedList<invalid>' as never)).toThrow(TypeError);
  });

  test('retains string and number set types without adding object set support', async () => {
    const values = {
      a: new SharedMap(set('string')).set('set', new SharedSet<string>().add('a')),
      b: new SharedMap(orderedSet('number')).set('set', new SharedOrderedSet<number>().add(1)),
      c: new SharedMap(sortedSet('string')).set('set', new SharedSortedSet<string>().add('a')),
    };
    const restored = await initWorker(getWorkerData(values));
    expect([...restored.a.get('set')!.values()]).toEqual(['a']);
    expect([...restored.b.get('set')!.values()]).toEqual([1]);
    expect([...restored.c.get('set')!.values()]).toEqual(['a']);
    for (const describe of [set, orderedSet, sortedSet]) {
      expect(() => describe('json' as never)).toThrow(TypeError);
    }
  });
});
