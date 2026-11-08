import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, Snapshot, HEAP_START, arenaOf } from './arena';
import { SharedMap } from './shared-map';
import { getWorkerData, initWorker } from './shared';

const entries = Array.from({ length: 257 }, (_, i) => [`key${i}`, i + 0.25] as const);
function numbers() { return new SharedMap('number', 0, 0, new Arena()).setMany(entries); }

describe('SharedMap.getMany', () => {
  it('keeps empty input, empty roots and missing-key validation', () => {
    const map = new SharedMap('number', 0, 0, new Arena());
    assert.deepEqual(map.getMany([]), []);
    assert.deepEqual(map.getMany(['missing', '']), [undefined, undefined]);
    assert.throws(() => map.getMany([17 as any]), /Map keys must be strings/);
    const holes = map.getMany(new Array(3));
    assert.equal(holes.length, 3); assert.deepEqual(Object.keys(holes), []);
  });

  it('does not reuse a primitive cache for an empty root returned by a custom kernel', () => {
    const a = new Arena(), native = a.wasm;
    const source = new SharedMap('number', 0, 0, a).set('x', 1);
    assert.equal(source.get('x'), 1);
    let empty: SharedMap<'number'>;
    try {
      (a as any).wasm = { ...native, mapSetNumber: () => 0 };
      empty = source.set('new', 2);
    } finally { (a as any).wasm = native; }
    assert.equal(empty.root, 0);
    assert.equal(empty.get('x'), undefined);
    assert.deepEqual(empty.getMany(['x', 'new', 'missing']), [undefined, undefined, undefined]);
  });

  for (const type of ['number', 'boolean', 'string', 'object'] as const) {
    it(`reads ${type} hits, misses, duplicate keys, old roots and forks`, () => {
      const values = type === 'number' ? [NaN, -0, Infinity, -Infinity, 3.25]
        : type === 'boolean' ? [false, true, false, true, false]
        : type === 'string' ? ['', 'é', '界', '🙂', '\ufeffvalue']
        : [{ nested: [1] }, { nested: [2] }, { nested: [3] }, { nested: [4] }, { nested: [5] }];
      const keys = ['', 'ascii', 'é', 'costarring', 'liquid'];
      const base = new SharedMap(type, 0, 0, new Arena()).setMany(keys.map((key, i) => [key, values[i]] as never));
      const fork = base.delete('ascii').set('new', values[3] as never);
      const request = ['liquid', 'missing', '', 'ascii', 'costarring', 'é', 'liquid'];
      const original = [values[4], undefined, values[0], values[1], values[3], values[2], values[4]];
      const changed = [...original]; changed[3] = undefined;
      const a = arenaOf(base), used = a.used, bytes = a.buf.slice(HEAP_START, used);
      for (let i = 0; i < 4; i++) {
        assert.deepEqual(base.getMany(request), original);
        assert.deepEqual(fork.getMany(request), changed);
      }
      assert.equal(a.used, used);
      assert.deepEqual(a.buf.subarray(HEAP_START, used), bytes);
      if (type === 'object') assert.ok(Object.isFrozen((base.getMany([''])[0] as any).nested));
    });
  }

  it('preserves sparse holes, inherited indices, length capture and duplicate order', () => {
    const map = numbers(), keys = new Array<string>(6);
    const proto = Object.create(Array.prototype);
    proto[1] = 'key1'; Object.setPrototypeOf(keys, proto);
    Object.defineProperty(keys, 0, { get() { keys[2] = 'key2'; keys.push('key9'); return 'key0'; } });
    keys[4] = 'key0';
    const result = map.getMany(keys);
    assert.equal(result.length, 6);
    assert.deepEqual(Object.keys(result), ['0', '1', '2', '4']);
    assert.deepEqual([result[0], result[1], result[2], result[4]], [0.25, 1.25, 2.25, 0.25]);
  });

  it('uses custom map and Array species without extra callbacks', () => {
    const map = numbers();
    const keys = ['key0', 'key1'];
    keys.map = function (callback: any): any { return [callback('key9'), callback('missing'), 'custom']; };
    assert.deepEqual(map.getMany(keys), [9.25, undefined, 'custom']);
    class Output extends Array {}
    class Input extends Array<string> { static get [Symbol.species]() { return Output; } }
    const result = map.getMany(new Input('key2', 'key3'));
    assert.ok(result instanceof Output);
    assert.deepEqual([...result], [2.25, 3.25]);
  });

  it('validates each visited key at its original position', () => {
    const map = numbers(), visited: number[] = [];
    const keys = [0, 1, 2].map(i => Object.defineProperty({}, 'key', { get() { visited.push(i); return i === 1 ? 17 : `key${i}`; } }));
    const input = keys.map((_key, i) => `key${i}`);
    for (let i = 0; i < input.length; i++) Object.defineProperty(input, i, { get: () => (keys[i] as any).key });
    assert.throws(() => map.getMany(input), /Map keys must be strings/);
    assert.deepEqual(visited, [0, 1]);
  });

  it('keeps subclass and borrowed get hooks', () => {
    class Custom extends SharedMap<'number'> { override get(key: string) { return key.length; } }
    assert.deepEqual(new Custom('number', 0, 0, new Arena()).getMany(['a', 'three']), [1, 5]);
    const receiver = { get: (key: string) => key.toUpperCase() };
    assert.deepEqual(SharedMap.prototype.getMany.call(receiver as any, ['one', 'two']), ['ONE', 'TWO']);
    assert.deepEqual(SharedMap.prototype.getMany.call(null as any, []), []);
    const holes = SharedMap.prototype.getMany.call(undefined as any, new Array(3));
    assert.equal(holes.length, 3); assert.deepEqual(Object.keys(holes), []);
  });

  it('observes get replacement from a key accessor without rereading it', () => {
    const map = numbers(), original = Object.getOwnPropertyDescriptor(SharedMap.prototype, 'get')!;
    let reads = 0, methods = 0;
    const keys = ['key0', 'key1', 'key2'];
    Object.defineProperty(keys, 1, { get() {
      reads++;
      Object.defineProperty(SharedMap.prototype, 'get', { configurable: true, get() {
        methods++; return function (this: SharedMap, key: string) { assert.equal(this, map); return key.length * 10; };
      } });
      return 'key1';
    } });
    try { assert.deepEqual(map.getMany(keys), [0.25, 40, 40]); }
    finally { Object.defineProperty(SharedMap.prototype, 'get', original); }
    assert.equal(reads, 1); assert.equal(methods, 2);
  });

  it('observes arena.value replacement while reading keys', () => {
    const map = numbers(), a = arenaOf(map), original = a.value;
    const keys = ['key0', 'key1'];
    Object.defineProperty(keys, 1, { get() { a.value = (_root, key) => key.length * 20; return 'key1'; } });
    try { assert.deepEqual(map.getMany(keys), [0.25, 80]); }
    finally { a.value = original; }
  });

  it('reads a custom value getter once per key, including a cold cache miss', () => {
    const map = numbers(), a = arenaOf(map), original = a.value;
    let reads = 0;
    Object.defineProperty(a, 'value', { configurable: true, get() {
      reads++; return reads === 1 ? original : (_root: number, key: string) => key.length * 20;
    } });
    assert.deepEqual(map.getMany(['key3', 'key4']), [3.25, 80]);
    assert.equal(reads, 2);
  });

  it('does not use a custom get function call property', () => {
    const map = numbers(), original = Object.getOwnPropertyDescriptor(SharedMap.prototype, 'get')!;
    const get = function (this: SharedMap, key: string) { assert.equal(this, map); return key.length; };
    get.call = (() => 999) as any;
    try {
      Object.defineProperty(SharedMap.prototype, 'get', { configurable: true, value: get });
      assert.deepEqual(map.getMany(['key0', 'key22']), [4, 5]);
      Object.defineProperty(SharedMap.prototype, 'get', { configurable: true, value: { call() { return 999; } } });
      assert.throws(() => map.getMany(['key0']), TypeError);
    } finally { Object.defineProperty(SharedMap.prototype, 'get', original); }
  });

  it('does not consult the scalar value function call property on cache misses', () => {
    const map = numbers(), value = Arena.prototype.value;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'call');
    Object.defineProperty(value, 'call', { configurable: true, value: () => 999 });
    try {
      assert.deepEqual(map.getMany(['missing', 'key0']), [undefined, 0.25]);
    } finally {
      if (descriptor) Object.defineProperty(value, 'call', descriptor);
      else delete (value as any).call;
    }
  });

  it('resolves the owner getter for every visited key', () => {
    const map = numbers(), other = new Arena(), descriptor = Object.getOwnPropertyDescriptor(Snapshot.prototype, 'arena')!;
    other.value = (_root, key) => key.length * 30;
    const keys = ['key0', 'key1', 'key2'];
    Object.defineProperty(keys, 1, { get() {
      Object.defineProperty(Snapshot.prototype, 'arena', { configurable: true, get() { return other; } });
      return 'key1';
    } });
    try { assert.deepEqual(map.getMany(keys), [0.25, 120, 120]); }
    finally { Object.defineProperty(Snapshot.prototype, 'arena', descriptor); }
  });

  it('refreshes memory after a key getter grows the arena and forks the map', () => {
    const map = numbers(), a = arenaOf(map), originalBuffer = a.memory.buffer;
    const keys = ['key0', 'key1', 'key2'];
    Object.defineProperty(keys, 1, { get() {
      new SharedMap('string', 0, 0, a).set('grow', 'x'.repeat(originalBuffer.byteLength * 2));
      map.set('key2', -2);
      return 'key1';
    } });
    assert.deepEqual(map.getMany(keys), [0.25, 1.25, 2.25]);
    assert.notEqual(a.memory.buffer, originalBuffer);
  });

  it('decodes presence-only cache entries and normalized UTF-8 aliases', () => {
    const map = new SharedMap('boolean', 0, 0, new Arena()).setMany([
      ['false', false], ['true', true], ['\ufffd', false], ['\ud800', true],
    ]);
    assert.equal(map.has('false'), true); assert.equal(map.has('true'), true);
    const keys = ['false', 'true', '\ud800', '\udc00', '\ufffd', 'missing'];
    for (let i = 0; i < 3; i++) assert.deepEqual(map.getMany(keys), [false, true, true, true, true, undefined]);
  });

  it('retains correct reads beyond the bounded primitive cache', () => {
    const count = 16387;
    const records = Array.from({ length: count }, (_, i) => [`k${i}`, i] as const);
    const map = new SharedMap('number', 0, 0, new Arena()).setMany(records);
    const keys = records.map(([key]) => key), expected = records.map(([, value]) => value);
    assert.deepEqual(map.getMany(keys), expected);
    assert.deepEqual(map.getMany(keys), expected);
    assert.deepEqual(map.getMany(['missing', 'k16386', 'k0', 'k16384']), [undefined, 16386, 0, 16384]);
  });

  for (const copy of [false, true]) it(`reads worker attachments without allocation (copy=${copy})`, async () => {
    const map = numbers(), reader = (await initWorker(getWorkerData({ map }, { copy }))).map;
    const a = arenaOf(reader), used = a.used, bytes = a.buf.slice(HEAP_START, used);
    assert.deepEqual(reader.getMany(['key9', 'missing', 'key0']), [9.25, undefined, 0.25]);
    assert.deepEqual(reader.getMany(['key0', 'key9', 'key9']), [0.25, 9.25, 9.25]);
    assert.equal(a.used, used); assert.deepEqual(a.buf.subarray(HEAP_START, used), bytes);
    assert.throws(() => reader.set('new', 1), /read-only/);
  });
});
