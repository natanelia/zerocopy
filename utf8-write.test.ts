import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { Arena, arenaOf } from './arena';
import { encodeUtf8ForWrite } from './utf8';
import {
  SharedMap, SharedList, SharedStack, SharedQueue, SharedLinkedList,
  SharedDoublyLinkedList, SharedOrderedMap, SharedSortedMap, SharedPriorityQueue,
  getWorkerData, initWorker, list,
  resetMap, resetSharedList, resetStack, resetQueue, resetLinkedList,
  resetDoublyLinkedList, resetOrderedMap, resetSortedMap, resetPriorityQueue,
} from './shared';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const normalized = (text: string) => decoder.decode(encoder.encode(text));
const keyAt = (index: number) => `key-${index}:界\ud800`;
const largeText = '界🙂\ud800\0'.repeat(12000);

function expectBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  expect(Buffer.compare(actual, expected)).toBe(0);
}

// Fixed seeds make failed Unicode cases reproducible. Include arbitrary UTF-16
// code units, since JS strings can contain invalid surrogate sequences.
function randomStrings(seed: number, count: number): string[] {
  const next = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return seed >>> 0;
  };
  const parts = ['a', '\0', '\ufeff', 'é', '界', '🙂', '\ud800', '\udc00', '"', '\\', '\n'];
  return Array.from({ length: count }, () => {
    const length = next() % 48;
    let text = '';
    for (let i = 0; i < length; i++) {
      text += next() & 1 ? parts[next() % parts.length] : String.fromCharCode(next() & 0xffff);
    }
    return text;
  });
}

const shortTexts = [...new Set([
  '', 'plain ASCII', '\0', 'a\0b', '\ufefftext', 'é', '界', '🙂',
  '\ud800', '\udc00', '\ud800\ud800', '\udc00\ud800', 'a\ud800b',
  ...randomStrings(0xdecafbad, 64),
])];
const boundaryTexts = [49151, 49152, 49153].flatMap(length => [
  'a'.repeat(length),
  '界'.repeat(Math.floor(length / 3)) + 'a'.repeat(length % 3),
  'a'.repeat(length - 4) + '🙂',
  'a'.repeat(length - 3) + '\ud800',
]);

async function withEncoder(implementation: unknown, check: (encode: typeof encodeUtf8ForWrite) => void): Promise<void> {
  vi.resetModules();
  vi.stubGlobal('TextEncoder', implementation);
  try {
    const fresh = await import('./utf8');
    check(fresh.encodeUtf8ForWrite);
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
}

// Test adapters erase only the collection-specific method signatures.
interface Fixture {
  name: string;
  create(type: string): any;
  put(source: any, value: any, index: number): any;
  read(source: any): any[];
}
const mapFixtures: Fixture[] = [
  { name: 'map', create: type => new SharedMap(type) },
  { name: 'ordered map', create: type => new SharedOrderedMap(type) },
  { name: 'sorted map', create: type => new SharedSortedMap(type) },
].map(fixture => ({
  ...fixture,
  put: (source, value, index) => source.set(keyAt(index), value),
  read: source => Array.from({ length: source.size }, (_, i) => source.get(keyAt(i))),
}));
const fixtures: Fixture[] = [
  ...mapFixtures,
  { name: 'list', create: type => new SharedList(type),
    put: (source, value) => source.push(value), read: source => source.toArray() },
  { name: 'stack', create: type => new SharedStack(type),
    put: (source, value) => source.push(value), read: source => {
      const values = [];
      for (let current = source; current.size; current = current.pop()) values.push(current.peek());
      return values.reverse();
    } },
  { name: 'queue', create: type => new SharedQueue(type),
    put: (source, value) => source.enqueue(value), read: source => {
      const values = [];
      for (let current = source; current.size; current = current.dequeue()) values.push(current.peek());
      return values;
    } },
  { name: 'linked list', create: type => new SharedLinkedList(type),
    put: (source, value) => source.append(value), read: source => source.toArray() },
  { name: 'doubly linked list', create: type => new SharedDoublyLinkedList(type),
    put: (source, value) => source.append(value), read: source => source.toArray() },
  { name: 'priority queue', create: type => new SharedPriorityQueue(type),
    put: (source, value, index) => source.enqueue(value, index),
    read: source => [...source.entries()].sort((a, b) => a[1] - b[1]).map(entry => entry[0]) },
];

beforeEach(() => {
  resetMap(); resetSharedList(); resetStack(); resetQueue(); resetLinkedList();
  resetDoublyLinkedList(); resetOrderedMap(); resetSortedMap(); resetPriorityQueue();
});

describe('UTF-8 value writes', () => {
  test('returns complete native UTF-8 bytes across temporary-buffer boundaries', () => {
    for (const text of [...shortTexts, ...boundaryTexts, largeText]) {
      // Small results are borrowed views. Consume each one before the next call.
      expectBytes(encodeUtf8ForWrite(encoder, text), encoder.encode(text));
    }
    // Retry after overflow must not include a prefix from the previous text.
    expectBytes(encodeUtf8ForWrite(encoder, 'after🙂\ud800'), encoder.encode('after🙂\ud800'));
  });

  test('uses ordinary buffers when a runtime rejects shared TextEncoder output', async () => {
    const NativeEncoder = TextEncoder;
    const destinations: ArrayBufferLike[] = [];
    class SharedRejectingEncoder extends NativeEncoder {
      encodeInto(text: string, destination: Uint8Array) {
        destinations.push(destination.buffer);
        if (destination.buffer instanceof SharedArrayBuffer) throw new TypeError('shared output is unavailable');
        return super.encodeInto(text, destination);
      }
    }
    await withEncoder(SharedRejectingEncoder, encode => {
      const localEncoder = new SharedRejectingEncoder();
      for (const text of ['界🙂', 'a'.repeat(49149) + '🙂', 'a'.repeat(49148) + '🙂', '\ud800']) {
        expectBytes(encode(localEncoder, text), encoder.encode(text));
      }
      expect(destinations.length).toBeGreaterThan(0);
      expect(destinations.every(buffer => buffer instanceof ArrayBuffer)).toBe(true);
    });
  });

  test('returns native allocated bytes when TextEncoder.encodeInto is absent', async () => {
    let calls = 0;
    class EncoderWithoutInto {
      encode(text: string) { calls++; return encoder.encode(text); }
    }
    await withEncoder(EncoderWithoutInto, encode => {
      const localEncoder = new EncoderWithoutInto() as TextEncoder;
      const texts = ['', '界🙂\ud800', 'a'.repeat(49149) + '🙂'];
      const retained = texts.map(text => encode(localEncoder, text));
      expect(calls).toBe(texts.length);
      for (const [index, text] of texts.entries()) expectBytes(retained[index], encoder.encode(text));
    });
  });

  test.each(['string', 'object'])('matches native bytes and exact allocation for encoded %s values', type => {
    const arena = new Arena();
    const retained: Array<{ raw: number; value: any }> = [];
    for (const [index, text] of [...shortTexts, ...boundaryTexts, largeText].entries()) {
      const value = type === 'string' ? text : { text, index, nested: [text, '\ufeff', -0, null] };
      const serialized = type === 'string' ? text : JSON.stringify(value);
      const expected = encoder.encode(serialized);
      const before = arena.used;
      const raw = arena.encode(type, value);
      expect(raw).toBe(Math.ceil(before / 8) * 8);
      expect(arena.used).toBe(Math.ceil((raw + 4 + expected.length) / 8) * 8);
      expect(arena.dv.getUint32(raw, true)).toBe(expected.length);
      expectBytes(arena.buf.slice(raw + 4, raw + 4 + expected.length), expected);
      retained.push({ raw, value: type === 'string' ? normalized(text) : JSON.parse(serialized) });
    }
    const reader = new Arena({ memory: arena.memory, used: arena.used, readOnly: true });
    for (const { raw, value } of retained) {
      expect(arena.decode(type, raw)).toEqual(value);
      expect(reader.decode(type, raw)).toEqual(value);
    }
  });

  test('keeps prepared bytes independent from subsequent scratch use', () => {
    const arena = new Arena();
    const value = { text: '\ufeff界🙂\0\ud800' };
    const first = arena.prepare('object', value);
    const second = arena.prepare('object', value);
    const text = arena.prepare('string', value.text);
    expect(first).not.toBe(second);
    expect(first.buffer).not.toBe(second.buffer);
    arena.encode('string', largeText);
    arena.leaf('object', '界', { text: largeText });
    expectBytes(first, encoder.encode(JSON.stringify(value)));
    expectBytes(second, first);
    expectBytes(text, encoder.encode(value.text));
  });

  test.each(['string', 'object'])('keeps native leaf payloads, prefixes, and alignment for %s', type => {
    const arena = new Arena();
    const keys = ['', 'ascii', '界', '🙂\ud800', '路'.repeat(16385)];
    const texts = [...shortTexts.slice(0, 20), ...boundaryTexts];
    const retained: Array<{ ptr: number; prefix: number; key: string; value: any }> = [];
    for (const [index, text] of texts.entries()) {
      const key = keys[index % keys.length], keyBytes = encoder.encode(key);
      const value = type === 'string' ? text : { text };
      const expected = encoder.encode(type === 'string' ? text : JSON.stringify(value));
      const ordinal = index & 1 ? index : undefined, prefix = ordinal === undefined ? 0 : 4;
      const before = arena.used;
      const ptr = arena.leaf(type, key, value, ordinal);
      expect(ptr).toBe(before);
      expect(arena.used).toBe(Math.ceil((ptr + 16 + keyBytes.length + prefix + expected.length) / 4) * 4);
      expect(arena.dv.getUint32(ptr + 8, true)).toBe(keyBytes.length);
      expect(arena.dv.getUint32(ptr + 12, true)).toBe(prefix + expected.length);
      expectBytes(arena.buf.slice(ptr + 16, ptr + 16 + keyBytes.length), keyBytes);
      const start = ptr + 16 + keyBytes.length;
      if (prefix) expect(arena.dv.getUint32(start, true)).toBe(ordinal);
      expectBytes(arena.buf.slice(start + prefix, start + prefix + expected.length), expected);
      retained.push({ ptr, prefix, key: normalized(key), value: type === 'string' ? normalized(text) : value });
    }
    for (const { ptr, prefix, key, value } of retained) {
      expect(arena.leafKey(ptr)).toBe(key);
      expect(arena.leafValue(type, ptr, prefix)).toEqual(value);
    }
  });

  test.each(mapFixtures)('$name handles exact shared-scratch capacity and oversized keys', async fixture => {
    for (const type of ['string', 'object']) {
      const base = fixture.create(type).set('old', type === 'string' ? 'kept' : { text: 'kept' });
      const arena = arenaOf(base), end = arena.used, bytes = arena.buf.slice(65536, end);
      let next = base;
      const keys = ['', '界', '🙂\ud800'];
      for (const key of keys) for (const offset of [-1, 0, 1]) {
        const capacity = 49152 - encoder.encode(key).length + offset;
        const overhead = type === 'object' ? encoder.encode(JSON.stringify({ text: '' })).length : 0;
        const text = 'a'.repeat(capacity - overhead - 4) + '🙂';
        const value = type === 'string' ? text : { text };
        next = next.set(key, value);
        const { source } = await initWorker(getWorkerData({ source: next }, { copy: false }));
        expect(source.get(key)).toEqual(value);
        expect(next.get(key)).toEqual(value);
      }
      const key = '路'.repeat(16385), value = type === 'string' ? 'tail🙂' : { text: 'tail🙂' };
      next = next.set(key, value);
      expect(next.get(key)).toEqual(value);
      if (type === 'string') {
        // Non-ASCII selects the generic writer with a zero-byte value range.
        const fullKey = '界' + 'k'.repeat(49149);
        next = next.set(fullKey, '');
        const { source } = await initWorker(getWorkerData({ source: next }, { copy: false }));
        expect(source.get(fullKey)).toBe('');
      }
      expect(base.size).toBe(1);
      expect(base.has(key)).toBe(false);
      expectBytes(arena.buf.slice(65536, end), bytes);
    }
  });

  test.each(fixtures.flatMap(fixture => ['string', 'object'].map(type => ({ ...fixture, type }))))(
    '$name $type preserves snapshots and attachments while the writer grows', async fixture => {
      const input = shortTexts.slice(0, 35).map(text => fixture.type === 'string' ? text : { text, nested: [text] });
      const expected = input.map(value => fixture.type === 'string' ? normalized(value as string) : JSON.parse(JSON.stringify(value)));
      let old = fixture.create(fixture.type);
      for (const [index, value] of input.entries()) old = fixture.put(old, value, index);
      const branchValue = fixture.type === 'string' ? 'fork\ud800' : { text: 'fork\ud800' };
      const branchExpected = fixture.type === 'string' ? normalized(branchValue as string) : branchValue;
      const fork = fixture.put(old, branchValue, input.length);
      const attached = await initWorker(getWorkerData({ old, fork }, { copy: false }));
      expect(fixture.read(attached.old)).toEqual(expected);
      const arena = arenaOf(old), end = arena.used, bytes = arena.buf.slice(65536, end);
      const capacity = arena.memory.buffer.byteLength;
      const big = fixture.type === 'string' ? largeText : { text: largeText };
      const bigExpected = fixture.type === 'string' ? normalized(largeText) : big;
      const next = fixture.put(old, big, input.length);
      expect(arena.memory.buffer.byteLength).toBeGreaterThan(capacity);
      expectBytes(arena.buf.slice(65536, end), bytes);
      expect(fixture.read(old)).toEqual(expected);
      expect(fixture.read(attached.old)).toEqual(expected);
      expect(fixture.read(attached.fork)).toEqual([...expected, branchExpected]);
      expect(fixture.read(fork)).toEqual([...expected, branchExpected]);
      expect(fixture.read(next)).toEqual([...expected, bigExpected]);
      for (const copy of [false, true]) {
        const restored = await initWorker(getWorkerData({ next }, { copy }));
        expect(fixture.read(restored.next)).toEqual([...expected, bigExpected]);
        let called = false;
        const blocked = fixture.type === 'string' ? 'blocked' : { toJSON() { called = true; return 'blocked'; } };
        expect(() => fixture.put(restored.next, blocked, next.size)).toThrow(/read-only/);
        expect(called).toBe(false);
      }
    },
  );

  test.each(fixtures.flatMap(fixture => [false, true].map(large => ({ ...fixture, large }))))('$name serializes hooks once before reentrant writes and growth, large=$large', async fixture => {
    const old = fixture.put(fixture.create('object'), { text: 'kept' }, 0);
    const arena = arenaOf(old), end = arena.used, bytes = arena.buf.slice(65536, end);
    const capacity = arena.memory.buffer.byteLength;
    let getters = 0, hooks = 0, side: any;
    const input = {
      text: fixture.large ? largeText : '\ufeffouter\ud800',
      get nested() {
        getters++;
        if (!fixture.large) side = fixture.put(old, { text: largeText }, 1);
        return { toJSON() {
          hooks++;
          if (fixture.large) side = fixture.put(old, { text: largeText }, 1);
          return { text: 'inner🙂\0' };
        } };
      },
    };
    const next = fixture.put(old, input, 1);
    expect(getters).toBe(1);
    expect(hooks).toBe(1);
    expect(arena.memory.buffer.byteLength).toBeGreaterThan(capacity);
    expectBytes(arena.buf.slice(65536, end), bytes);
    const expected = [{ text: 'kept' }, { text: input.text, nested: { text: 'inner🙂\0' } }];
    expect(fixture.read(next)).toEqual(expected);
    expect(fixture.read(side)).toEqual([{ text: 'kept' }, { text: largeText }]);
    expect(fixture.read(old)).toEqual([{ text: 'kept' }]);
    const restored = await initWorker(getWorkerData({ next, side, old }, { copy: false }));
    expect(fixture.read(restored.next)).toEqual(expected);
    expect(fixture.read(restored.side)).toEqual(fixture.read(side));
    expect(fixture.read(restored.old)).toEqual([{ text: 'kept' }]);
  });

  test('keeps bytes intact when getters and toJSON reenter different arenas', async () => {
    const oldMap = new SharedMap('object').set('old', { text: 'map kept' });
    const oldList = new SharedList('object').push({ text: 'list kept' });
    const mapArena = arenaOf(oldMap), listArena = arenaOf(oldList);
    expect(mapArena).not.toBe(listArena);
    const mapEnd = mapArena.used, listEnd = listArena.used;
    const mapBytes = mapArena.buf.slice(65536, mapEnd), listBytes = listArena.buf.slice(65536, listEnd);
    let getters = 0, hooks = 0;
    let branchMap: typeof oldMap, branchList: typeof oldList;
    const next = oldMap.set('outer界', {
      get nested() {
        getters++;
        branchList = oldList.push({ toJSON() {
          hooks++;
          branchMap = oldMap.set('branch🙂', { text: 'map branch\ud800' });
          return { text: 'list branch\0🙂' };
        } });
        return { text: 'outer\ufeff界' };
      },
    });
    expect(getters).toBe(1);
    expect(hooks).toBe(1);
    // Reuse the temporary buffer again before the first reads of every branch.
    next.set('later', { text: 'later map' });
    branchList!.push({ text: 'later list' });
    expectBytes(mapArena.buf.slice(65536, mapEnd), mapBytes);
    expectBytes(listArena.buf.slice(65536, listEnd), listBytes);
    const restored = await initWorker(getWorkerData({ oldMap, oldList, next, branchMap: branchMap!, branchList: branchList! }, { copy: false }));
    expect(restored.oldMap.get('old')).toEqual({ text: 'map kept' });
    expect(restored.oldMap.has('branch🙂')).toBe(false);
    expect(restored.oldList.toArray()).toEqual([{ text: 'list kept' }]);
    expect(restored.next.get('outer界')).toEqual({ nested: { text: 'outer\ufeff界' } });
    expect(restored.branchMap.get('branch🙂')).toEqual({ text: 'map branch\ud800' });
    expect(restored.branchList.toArray()).toEqual([{ text: 'list kept' }, { text: 'list branch\0🙂' }]);
  });

  test.each([
    { name: 'scalar map', create: () => new SharedMap('object'), put: (s: any, values: any[]) => s.set('new', values[0]), read: (s: any) => s.get('new') },
    { name: 'bulk map', create: () => new SharedMap('object'), put: (s: any, values: any[]) => s.setMany(values.map((v, i) => [i ? `next-${i}` : 'new', v])), read: (s: any) => s.get('new') },
    { name: 'scalar list', create: () => new SharedList('object'), put: (s: any, values: any[]) => s.push(values[0]), read: (s: any) => s.get(0) },
    { name: 'bulk list', create: () => new SharedList('object'), put: (s: any, values: any[]) => s.pushMany(values), read: (s: any) => s.get(0) },
  ])('$name recovers after failed serialization without changing a retained root', fixture => {
    const empty = fixture.create(), good = { text: 'kept\ud800' };
    const old = fixture.put(empty, [good]);
    const arena = arenaOf(old), end = arena.used, bytes = arena.buf.slice(65536, end);
    let side: any;
    const failure = new Error('serialization failed');
    const bad = { toJSON() { side = fixture.put(empty, [{ text: largeText }]); throw failure; } };
    expect(() => fixture.put(old, [bad])).toThrow(failure);
    expect(() => fixture.put(old, [{ toJSON() { return undefined; } }])).toThrow(/JSON-serializable/);
    expect(fixture.read(side)).toEqual({ text: largeText });
    expect(fixture.read(old)).toEqual(good);
    expect(old.size).toBe(1);
    expectBytes(arena.buf.slice(65536, end), bytes);
    const next = fixture.put(empty, [{ text: 'after🙂' }]);
    expect(fixture.read(next)).toEqual({ text: 'after🙂' });
    expect(fixture.read(old)).toEqual(good);
    expect(empty.size).toBe(0);
  });

  test.each(fixtures)('$name preserves nested descriptors and read-only child attachments', async fixture => {
    const child = new SharedList('string').pushMany(['\ufeffchild', '\ud800', '\0🙂']);
    const old = fixture.put(fixture.create(list('string')), child, 0);
    const nextChild = child.push(largeText);
    const next = fixture.put(old, nextChild, 1);
    const expected = ['\ufeffchild', '\ufffd', '\0🙂'];
    for (const copy of [false, true]) {
      const restored = await initWorker(getWorkerData({ old, next }, { copy }));
      const children = fixture.read(restored.next);
      expect(fixture.read(restored.old)[0].toArray()).toEqual(expected);
      expect(children[0].toArray()).toEqual(expected);
      expect(children[1].toArray()).toEqual([...expected, normalized(largeText)]);
      expect(() => children[0].push('blocked')).toThrow(/read-only/);
      expect(() => children[1].push('blocked')).toThrow(/read-only/);
    }
    expect(child.toArray()).toEqual(expected);
    expect(fixture.read(old)[0].toArray()).toEqual(expected);
  });
});
