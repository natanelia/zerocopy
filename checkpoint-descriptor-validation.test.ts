import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  SharedMap, SharedSet, SharedList, SharedStack, SharedQueue,
  SharedLinkedList, SharedDoublyLinkedList, SharedOrderedMap,
  SharedOrderedSet, SharedSortedMap, SharedSortedSet, SharedPriorityQueue,
  getWorkerData, initWorker,
} from './shared';
import { arenaOf, FORMAT_VERSION, HEAP_START, MAX_SIZE, hashBytes } from './arena';
import { decodeZerocopyState, serializeZerocopyState } from './redux';

// Use public writers to produce valid packets. Expected contents are ordinary
// values, independent of the decoder's descriptor checks or compaction code.
const fixtures = [
  { kind: 'SharedMap', empty: () => new SharedMap('number'), make: () => new SharedMap('number').set('x', 7), expected: [['x', 7]], pointers: ['root'], live: ['root'] },
  { kind: 'SharedSet', empty: () => new SharedSet(), make: () => new SharedSet().add('x'), expected: ['x'], pointers: ['root'], live: ['root'] },
  { kind: 'SharedList', empty: () => new SharedList('number'), make: () => new SharedList('number').push(7), expected: [7], pointers: ['root', 'tail'], live: ['tail'] },
  { kind: 'SharedStack', empty: () => new SharedStack('number'), make: () => new SharedStack('number').push(7), expected: [7], pointers: ['head'], live: ['head'] },
  { kind: 'SharedQueue', empty: () => new SharedQueue('number'), make: () => new SharedQueue('number').enqueue(7), expected: [7], pointers: ['head', 'block'], live: ['block'] },
  { kind: 'SharedLinkedList', empty: () => new SharedLinkedList('number'), make: () => new SharedLinkedList('number').append(7), expected: [7], pointers: ['head', 'tail'], live: ['tail'] },
  { kind: 'SharedDoublyLinkedList', empty: () => new SharedDoublyLinkedList('number'), make: () => new SharedDoublyLinkedList('number').append(7), expected: [7], pointers: ['head', 'tail'], live: ['tail'] },
  { kind: 'SharedOrderedMap', empty: () => new SharedOrderedMap('number'), make: () => new SharedOrderedMap('number').set('x', 7), expected: [['x', 7]], pointers: ['root', 'head'], live: ['root', 'head'] },
  { kind: 'SharedOrderedSet', empty: () => new SharedOrderedSet(), make: () => new SharedOrderedSet().add('x'), expected: ['x'], pointers: ['root', 'head'], live: ['root', 'head'] },
  { kind: 'SharedSortedMap', empty: () => new SharedSortedMap('number'), make: () => new SharedSortedMap('number').set('x', 7), expected: [['x', 7]], pointers: ['root'], live: ['root'] },
  { kind: 'SharedSortedSet', empty: () => new SharedSortedSet(), make: () => new SharedSortedSet().add('x'), expected: ['x'], pointers: ['root'], live: ['root'] },
  { kind: 'SharedPriorityQueue', empty: () => new SharedPriorityQueue('number'), make: () => new SharedPriorityQueue('number', { maxHeap: true }).enqueue(7, 3), expected: [[7, 3]], pointers: ['root'], live: ['root'] },
];

function contents(value: any): unknown[] {
  if (value instanceof SharedStack || value instanceof SharedQueue || value instanceof SharedPriorityQueue) {
    const result: unknown[] = [];
    while (!value.isEmpty) {
      result.push(value instanceof SharedPriorityQueue ? [value.peek(), value.peekPriority()] : value.peek());
      value = value instanceof SharedStack ? value.pop() : value.dequeue();
    }
    return result;
  }
  if (value instanceof SharedList || value instanceof SharedLinkedList || value instanceof SharedDoublyLinkedList) return value.toArray();
  if (value instanceof SharedSet || value instanceof SharedOrderedSet || value instanceof SharedSortedSet) return [...value.values()];
  return [...value.entries()];
}
function removeOnly(value: any): any {
  if (value instanceof SharedList || value instanceof SharedStack) return value.pop();
  if (value instanceof SharedQueue || value instanceof SharedPriorityQueue) return value.dequeue();
  if (value instanceof SharedLinkedList || value instanceof SharedDoublyLinkedList) return value.removeFirst();
  return value.delete('x');
}
function packetOf(value: unknown): any { return JSON.parse(serializeZerocopyState(value)); }
// Avoid encodeZerocopyState's compaction here: public descriptors can retain
// queue offsets, historical order entries, and noncanonical sequence storage.
function rawPacketOf(snapshot: any): any {
  const transport = getWorkerData({ s0: snapshot }, { copy: true });
  return {
    codec: 'zerocopy-redux', version: 1, format: FORMAT_VERSION,
    tree: ['snapshot', 's0'], structures: transport.structures,
    arenas: transport.arenas.map(arena => ({
      id: arena.id, used: arena.used, checksum: hashBytes(arena.copy!),
      base64: Buffer.from(arena.copy!).toString('base64'),
    })),
  };
}
function changeDescriptor(packet: any, change: (data: any) => void): any {
  const data = { ...packet.structures.s0.data };
  change(data);
  return { ...packet, structures: { ...packet.structures, s0: { ...packet.structures.s0, data } } };
}
function rejectDescriptor(packet: any): void {
  expect(() => decodeZerocopyState(packet)).toThrow(/invalid collection descriptor/);
}

describe('checkpoint descriptors preserve data or reject malformed metadata', () => {
  it('rejects an omitted map root instead of successfully restoring an empty map', async () => {
    const original = new SharedMap('number').set('x', 1), fork = original.set('x', 2);
    const { attached } = await initWorker(getWorkerData({ attached: original }, { copy: true }));
    const packet = packetOf(original), used = arenaOf(original).used;
    rejectDescriptor(changeDescriptor(packet, data => { delete data.root; }));
    expect(original.get('x')).toBe(1);
    expect(fork.get('x')).toBe(2);
    expect(attached.get('x')).toBe(1);
    expect(arenaOf(original).used).toBe(used);
    const restored = decodeZerocopyState<SharedMap<'number'>>(packet);
    expect(restored.get('x')).toBe(1);
    expect(restored.set('x', 3).get('x')).toBe(3);
    expect(restored.get('x')).toBe(1);
  });

  describe.each(fixtures)('$kind', fixture => {
    it('accepts generated nonempty and empty descriptors', () => {
      const restored: any = decodeZerocopyState(packetOf(fixture.make()));
      expect(restored.constructor.name).toBe(fixture.kind);
      expect(contents(restored)).toEqual(fixture.expected);
      const empty: any = decodeZerocopyState(packetOf(fixture.empty()));
      expect(empty.constructor.name).toBe(fixture.kind);
      expect(empty.size).toBe(0);
      expect(contents(empty)).toEqual([]);
    });

    it('also accepts public transport descriptors without prior compaction', () => {
      const restored: any = decodeZerocopyState(rawPacketOf(fixture.make()));
      expect(restored.constructor.name).toBe(fixture.kind);
      expect(contents(restored)).toEqual(fixture.expected);
      const empty: any = decodeZerocopyState(rawPacketOf(fixture.empty()));
      expect(empty.constructor.name).toBe(fixture.kind);
      expect(contents(empty)).toEqual([]);
    });

    it('accepts raw empty descriptors produced by public removal', () => {
      const retained = fixture.make(), source = removeOnly(retained);
      expect(source.size).toBe(0);
      const restored: any = decodeZerocopyState(rawPacketOf(source));
      expect(restored.constructor.name).toBe(fixture.kind);
      expect(restored.size).toBe(0);
      expect(contents(restored)).toEqual([]);
      expect(contents(retained)).toEqual(fixture.expected);
    });

    it('requires every mandatory producer field', () => {
      const packet = packetOf(fixture.make());
      for (const key of Object.keys(packet.structures.s0.data)) {
        // The public ordered-map reader intentionally supports older descriptors
        // without this optional optimization flag.
        if (key === 'orderStable') continue;
        rejectDescriptor(changeDescriptor(packet, data => { delete data[key]; }));
      }
    });

    it('rejects incorrectly typed fields and fields from unrelated descriptors', () => {
      const packet = packetOf(fixture.make());
      for (const [key, value] of Object.entries(packet.structures.s0.data)) {
        const invalid = typeof value === 'number' ? [undefined, null, '1', true, -1, 0.5, NaN, Infinity]
          : typeof value === 'boolean' ? [null, 0, 'true'] : [undefined, null, 1, false];
        for (const replacement of invalid) rejectDescriptor(changeDescriptor(packet, data => { data[key] = replacement; }));
      }
      rejectDescriptor(changeDescriptor(packet, data => { data.unexpected = 0; }));
      const typeKey = Object.hasOwn(packet.structures.s0.data, 'valueType') ? 'valueType' : 'type';
      rejectDescriptor(changeDescriptor(packet, data => { data[typeKey === 'type' ? 'valueType' : 'type'] = 'number'; }));
      rejectDescriptor(changeDescriptor(packet, data => { data.size = MAX_SIZE + 1; }));
    });

    it('validates the complete value type grammar', () => {
      const packet = packetOf(fixture.make());
      const key = Object.hasOwn(packet.structures.s0.data, 'valueType') ? 'valueType' : 'type';
      for (const type of ['', 'unknown', 'SharedMap<unknown>', 'SharedSet<object>', 'SharedList<number>>']) {
        rejectDescriptor(changeDescriptor(packet, data => { data[key] = type; }));
      }
    });

    it('rejects missing live pointers and out-of-range or misaligned pointers', () => {
      const packet = packetOf(fixture.make()), used = packet.arenas[0].used;
      for (const key of fixture.live) rejectDescriptor(changeDescriptor(packet, data => { data[key] = 0; }));
      for (const key of fixture.pointers) {
        for (const address of [4, HEAP_START - 4, HEAP_START + 1, used - 4, used, used + 4]) {
          rejectDescriptor(changeDescriptor(packet, data => { data[key] = address; }));
        }
      }
    });
  });

  it.each(['SharedSet', 'SharedOrderedSet', 'SharedSortedSet'])('requires the numeric backing value type for %s', kind => {
    const packet = packetOf(fixtures.find(fixture => fixture.kind === kind)!.make());
    rejectDescriptor(changeDescriptor(packet, data => { data.valueType = 'string'; }));
  });

  it.each(['SharedOrderedMap', 'SharedOrderedSet'])('preserves the optional orderStable compatibility field for %s', kind => {
    const fixture = fixtures.find(item => item.kind === kind)!;
    const packet = packetOf(fixture.make());
    const restored = decodeZerocopyState(changeDescriptor(packet, data => { delete data.orderStable; }));
    expect(contents(restored)).toEqual(fixture.expected);
  });

  it.each([
    ['SharedMap', 'SharedStack'], ['SharedList', 'SharedQueue'],
    ['SharedLinkedList', 'SharedList'], ['SharedOrderedMap', 'SharedMap'],
    ['SharedPriorityQueue', 'SharedStack'],
  ])('rejects a %s descriptor relabeled as %s', (from, to) => {
    const packet = packetOf(fixtures.find(fixture => fixture.kind === from)!.make());
    packet.structures.s0.type = to;
    rejectDescriptor(packet);
  });

  it('rejects impossible sequence sizes and truncated tail storage', () => {
    for (const kind of ['SharedList', 'SharedQueue', 'SharedLinkedList', 'SharedDoublyLinkedList']) {
      const packet = packetOf(fixtures.find(fixture => fixture.kind === kind)!.make());
      const key = kind === 'SharedQueue' ? 'block' : 'tail';
      rejectDescriptor(changeDescriptor(packet, data => { data[key] = packet.arenas[0].used - 4; }));
      if (kind === 'SharedLinkedList' || kind === 'SharedDoublyLinkedList') {
        for (const tailSize of [2, 33]) rejectDescriptor(changeDescriptor(packet, data => { data.tailSize = tailSize; }));
      } else {
        rejectDescriptor(changeDescriptor(packet, data => { data.depth = MAX_SIZE; }));
      }
    }
    const queue = packetOf(new SharedQueue('number').enqueue(7));
    rejectDescriptor(changeDescriptor(queue, data => { data.tail = MAX_SIZE; }));
  });

  it.each([33, 65])('requires complete direct root headers in size-%s sequence descriptors', size => {
    const values = Array.from({ length: size }, (_, i) => i);
    const list = new SharedList('number').pushMany(values);
    let queue = new SharedQueue('number'), linked = new SharedLinkedList('number'), doubly = new SharedDoublyLinkedList('number');
    for (const value of values) { queue = queue.enqueue(value); linked = linked.append(value); doubly = doubly.append(value); }
    for (const source of [list, queue, linked, doubly]) {
      const packet = rawPacketOf(source), key = source instanceof SharedList ? 'root' : 'head';
      expect(packet.structures.s0.data[key]).toBeGreaterThan(0);
      rejectDescriptor(changeDescriptor(packet, data => { data[key] = packet.arenas[0].used - 4; }));
    }
  });

  it('does not invoke descriptor accessors or accept inherited required fields', () => {
    const packet = packetOf(new SharedMap('number').set('x', 1));
    let getterCalls = 0;
    const accessor = changeDescriptor(packet, data => {
      Object.defineProperty(data, 'root', { enumerable: true, get() { getterCalls++; return packet.structures.s0.data.root; } });
    });
    rejectDescriptor(accessor);
    expect(getterCalls).toBe(0);
    const inherited = changeDescriptor(packet, data => { delete data.root; Object.setPrototypeOf(data, { root: packet.structures.s0.data.root }); });
    rejectDescriptor(inherited);
  });

  it.each([32, 33, 1025])('keeps valid sequence boundaries and nested descriptors at size %s', size => {
    const expected = Array.from({ length: size }, (_, i) => i);
    const list = new SharedList('number').pushMany(expected);
    let queue = new SharedQueue('number'), linked = new SharedLinkedList('number'), doubly = new SharedDoublyLinkedList('number');
    for (const value of expected) { queue = queue.enqueue(value); linked = linked.append(value); doubly = doubly.append(value); }
    queue = queue.dequeue();
    const nested = new SharedMap('SharedList<number>').set('child', list);
    const restored: any = decodeZerocopyState(packetOf({ list, queue, linked, doubly, nested }));
    expect(contents(restored.list)).toEqual(expected);
    expect(contents(restored.queue)).toEqual(expected.slice(1));
    expect(contents(restored.linked)).toEqual(expected);
    expect(contents(restored.doubly)).toEqual(expected);
    expect(restored.nested.get('child').toArray()).toEqual(expected);
  });

  it.each([1, 35, 69])('accepts raw queue descriptors after %s dequeues', removed => {
    const values = Array.from({ length: 70 }, (_, i) => i);
    let source = new SharedQueue('number');
    for (const value of values) source = source.enqueue(value);
    for (let i = 0; i < removed; i++) source = source.dequeue();
    const packet = rawPacketOf(source);
    expect(packet.structures.s0.data.tail).toBe(removed);
    expect(contents(decodeZerocopyState(packet))).toEqual(values.slice(removed));
    expect(contents(source)).toEqual(values.slice(removed));
  });

  it.each([33, 65, 1025, 1057])('accepts raw list descriptors popped across size %s', size => {
    const values = Array.from({ length: size }, (_, i) => i);
    const retained = new SharedList('number').pushMany(values);
    let source = retained;
    for (let i = 1; i <= 2; i++) {
      source = source.pop();
      expect(contents(decodeZerocopyState(rawPacketOf(source)))).toEqual(values.slice(0, -i));
    }
    expect(retained.toArray()).toEqual(values);
  });

  it('accepts raw ordered descriptors with deleted and reinserted entries', () => {
    const map = new SharedOrderedMap('number').set('a', 1).set('b', 2).set('a', 3).delete('b').set('c', 4).set('b', 5);
    const set = new SharedOrderedSet().add('a').add('b').delete('a').add('a');
    for (const [source, expected] of [[map, [['a', 3], ['c', 4], ['b', 5]]], [set, ['b', 'a']]] as const) {
      const packet = rawPacketOf(source);
      expect(packet.structures.s0.data.tail).toBeGreaterThan(source.size);
      expect(packet.structures.s0.data.orderStable).toBe(false);
      expect(contents(decodeZerocopyState(packet))).toEqual(expected);
      expect(contents(source)).toEqual(expected);
    }
  });

  it.each(fixtures.filter(fixture => fixture.kind === 'SharedLinkedList' || fixture.kind === 'SharedDoublyLinkedList'))(
    'accepts raw $kind edits with all remaining values in blocks', fixture => {
      const values = Array.from({ length: 32 }, (_, i) => i);
      let source: any = fixture.empty();
      for (const value of values) source = source.append(value);
      // Prepending to a full tail moves that tail into the block sequence.
      source = source.prepend(-1).removeFirst();
      const packet = rawPacketOf(source);
      expect(packet.structures.s0.data.tailSize).toBe(0);
      expect(packet.structures.s0.data.head).toBeGreaterThan(0);
      expect(contents(decodeZerocopyState(packet))).toEqual(values);
      expect(contents(source)).toEqual(values);
      for (let i = 0; i < values.length; i++) source = source.removeFirst();
      expect(contents(decodeZerocopyState(rawPacketOf(source)))).toEqual([]);
    },
  );
});
