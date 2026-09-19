import { beforeEach, describe, expect, test, vi } from 'vitest';
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

  test('keeps special keys as data and freezes array values', () => {
    const special = JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}');
    const read = new SharedMap(json<Record<string, object | string>>()).set('special', special).get('special')!;
    expect(Object.hasOwn(read, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const array = new SharedList(json<Array<{ x: number }>>()).push([{ x: 1 }]).get(0)!;
    expect(array).toEqual([{ x: 1 }]);
    expect(Object.isFrozen(array[0])).toBe(true);
  });
});

describe('existing object codec reuse', () => {
  test('uses the same codec instance, runtime names, and native UTF-8 bytes', () => {
    expect(LaneValue).toBe('object');
    expect(getCodec(LaneValue)).toBe(getCodec('object'));
    const input = { ...lane(), label: 'quotes " slash \\ control \n unicode 🙂 \ud800' };
    const source = new SharedMap(LaneValue);
    const expected = new TextEncoder().encode(JSON.stringify(input));
    expect(arenaOf(source).prepare(LaneValue, input)).toEqual(expected);
    expect(arenaOf(source).prepare(LaneValue, input)).toEqual(arenaOf(source).prepare('object', input));
    const codec = getCodec(LaneValue), bytes = new Uint8Array(expected.length + 8);
    expect(codec.size(input)).toBe(expected.length);
    const length = codec.encode(input, bytes, 4);
    expect(bytes.subarray(4, 4 + length)).toEqual(expected);
    const read = codec.decode(bytes, 4, length);
    expect(read).toEqual(input);
    expect(Object.isFrozen(read.centerline[0])).toBe(true);
  });

  test('calls native JSON.stringify once per scalar write without a validation walk', () => {
    const input = lane();
    const source = new SharedMap(LaneValue);
    const stringify = vi.spyOn(JSON, 'stringify');
    const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors');
    let stored: typeof source;
    let calls: unknown[][], descriptorCalls: number;
    try {
      stored = source.set('lane', input);
      calls = stringify.mock.calls.slice();
      descriptorCalls = descriptors.mock.calls.length;
    } finally {
      descriptors.mockRestore();
      stringify.mockRestore();
    }
    expect(calls!).toEqual([[input]]);
    expect(descriptorCalls!).toBe(0);
    expect(stored!.get('lane')).toEqual(input);
  });

  test('uses native JSON semantics for unchecked inputs, including hooks and negative zero', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    let getters = 0, hooks = 0;
    const unchecked = {
      omitted: undefined, nan: NaN, infinity: Infinity, coordinate: -0, date,
      array: [undefined, NaN, , 1],
      get computed() { getters++; return 7; },
      custom: { toJSON() { hooks++; return { x: 1 }; } },
    };
    // Deliberately bypass the static contract to check reuse, not data validity.
    const source = new SharedMap(LaneValue).set('unchecked', unchecked as never);
    expect(getters).toBe(1);
    expect(hooks).toBe(1);
    const legacy = new SharedMap('object').set('unchecked', unchecked);
    const expected = JSON.parse(JSON.stringify(unchecked));
    expect(source.get('unchecked')).toEqual(expected);
    expect(source.get('unchecked')).toEqual(legacy.get('unchecked'));
    expect(expected.coordinate).toBe(0);
    expect(Object.isFrozen(source.get('unchecked'))).toBe(true);
  });

  test('keeps byte allocation identical for large typed and untyped batches', () => {
    const input = { ...lane(), centerline: Array.from({ length: 1024 }, (_, i): [number, number] => [i + 0.5, i / 100]) };
    const entries = Array.from({ length: 4 }, (_, i) => [String(i), input] as const);
    const typed = new SharedMap(LaneValue).setMany(entries);
    const typedBytes = arenaOf(typed).copy();
    resetMap();
    const legacy = new SharedMap('object').setMany(entries);
    expect(arenaOf(legacy).copy()).toEqual(typedBytes);
    expect(typed.toWorkerData()).toEqual(legacy.toWorkerData());
    const values = new SharedList(LaneValue).pushMany([input, input]);
    const listBytes = arenaOf(values).copy();
    resetSharedList();
    const legacyList = new SharedList('object').pushMany([input, input]);
    expect(arenaOf(legacyList).copy()).toEqual(listBytes);
  });

  test('uses existing object descriptors for transport and mixed nested collections', async () => {
    const lanes = new SharedMap(LaneValue).set('lane', lane());
    const children = new SharedList(LaneValue).push(lane());
    const typed = new SharedMap(list(LaneValue)).set('tile', children);
    const legacy = new SharedMap('SharedList<object>').set('tile', children);
    const data = getWorkerData({ lanes, typed, legacy }, { copy: true });
    expect(data.version).toBe(4);
    expect(data.structures.lanes.data.valueType).toBe('object');
    expect(data.structures.typed.data.valueType).toBe('SharedList<object>');
    const restored = await initWorker(data);
    expect(restored.typed.get('tile')?.get(0)).toEqual(restored.legacy.get('tile')?.get(0));
    expect(restored.typed.get('tile')?.toWorkerData().type).toBe('object');
  });

  test.each([
    ['bigint', () => ({ x: 1n })],
    ['cycle', () => { const value: any = {}; value.self = value; return value; }],
  ])('keeps native %s errors without changing published snapshots', (_name, make) => {
    const old = new SharedMap(LaneValue).set('lane', lane());
    const original = new SharedList(LaneValue).push(lane());
    expect(() => old.set('bad', make() as never)).toThrow(TypeError);
    expect(() => old.setMany([['good', lane()], ['bad', make() as never]])).toThrow(TypeError);
    expect(() => original.pushMany([lane(), make() as never])).toThrow(TypeError);
    expect(old.size).toBe(1);
    expect(old.get('lane')).toEqual(lane());
    expect(original.size).toBe(1);
    expect(original.get(0)).toEqual(lane());
  });

  test('does not register a separate json runtime codec', () => {
    expect(() => getCodec('json')).toThrow(/Unknown type/);
    expect(() => new SharedMap('json').set('lane', lane() as never)).toThrow(/Unknown value type/);
    expect(() => list('json' as never)).toThrow(/Unknown value type/);
  });
});

describe('nested descriptor helpers', () => {
  test.each([
    [map, 'SharedMap'], [list, 'SharedList'], [stack, 'SharedStack'], [queue, 'SharedQueue'],
    [linkedList, 'SharedLinkedList'], [doublyLinkedList, 'SharedDoublyLinkedList'],
    [orderedMap, 'SharedOrderedMap'], [sortedMap, 'SharedSortedMap'], [priorityQueue, 'SharedPriorityQueue'],
  ] as const)('%s retains the wire description for %s', (describe, name) => {
    expect(describe(LaneValue)).toBe(`${name}<object>`);
    expect(describe(list(LaneValue))).toBe(`${name}<SharedList<object>>`);
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
      expect(() => describe(LaneValue as never)).toThrow(TypeError);
    }
  });
});
