import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, FORMAT_VERSION, arenaOf } from './arena';
import { SharedList, SharedMap, getWorkerData, initWorker } from './shared';
import { decodeZerocopyState, deserializeZerocopyState, encodeZerocopyState, serializeZerocopyState } from './redux';

const plainPacket = (tree: unknown) => ({
  codec: 'zerocopy-redux', version: 1, format: FORMAT_VERSION,
  tree, arenas: [], structures: {},
});
const errorOf = (fn: () => unknown): Error => {
  try { fn(); } catch (error) { return error as Error; }
  throw new Error('Expected an error');
};

describe('checkpoint validation before reconstruction', () => {
  it('restores complete nested arrays and records with the same frozen property contracts', () => {
    const nullRecord = Object.create(null);
    for (const key of ['__proto__', 'constructor', 'toString', '', 'é', '🙂']) nullRecord[key] = { key };
    const sparse = new Array(8); sparse[2] = undefined; sparse[5] = -0; sparse[7] = nullRecord;
    const rows = Array.from({ length: 257 }, (_, i) => ({ id: i, flags: [true, false], values: [i, NaN, Infinity, -Infinity] }));
    const state = { rows, sparse, nil: null, missing: undefined, record: nullRecord };
    const packet = encodeZerocopyState(state), before = JSON.stringify(packet);
    for (const restored of [decodeZerocopyState<any>(packet), deserializeZerocopyState<any>(before)]) {
      assert.deepEqual(restored, state);
      assert.equal(Object.getPrototypeOf(restored.record), null);
      assert.equal(Object.getPrototypeOf(restored.rows[0]), Object.prototype);
      assert.deepEqual(Reflect.ownKeys(restored.sparse), ['2', '5', '7', 'length']);
      assert.deepEqual(Object.getOwnPropertyDescriptor(restored, 'missing'), {
        value: undefined, writable: false, enumerable: true, configurable: false,
      });
      for (const value of [restored, restored.rows, restored.rows[256], restored.rows[256].values,
        restored.sparse, restored.record, restored.record.__proto__]) assert.ok(Object.isFrozen(value));
    }
    assert.equal(JSON.stringify(packet), before);
  });

  it('validates shared references before constructing any WASM instance', () => {
    const packet = encodeZerocopyState(new SharedMap('number', 0, 0, new Arena()).set('x', 1));
    const cycle: unknown[] = ['array', []]; (cycle[1] as unknown[]).push(cycle);
    const badTrees: Array<[unknown, string]> = [
      [['snapshot', 's99'], 'unknown or invalid state node'],
      [['snapshot', 0], 'unknown or invalid state node'],
      [['string', false], 'unknown or invalid state node'],
      [['boolean', 'true'], 'unknown or invalid state node'],
      [['array', {}], 'unknown or invalid state node'],
      [['object', {}], 'unknown or invalid state node'],
      [['null-object', {}], 'unknown or invalid state node'],
      [['object', [['x']]], 'invalid object entry'],
      [['object', [[1, ['null']]]], 'invalid object entry'],
      [['array', [['hole', 1]]], 'unknown or invalid state node'],
      [['hole'], 'invalid state node length'],
      [['null', null], 'unknown or invalid state node'],
      [['undefined', undefined], 'unknown or invalid state node'],
      [['unknown', 1], 'unknown or invalid state node'],
      [['number', Infinity], 'invalid number node'],
      [['number', NaN], 'invalid number node'],
      [['number', 'Infinity'], 'invalid number node'],
      [['number', 1, 2], 'invalid state node length'],
      [['object', [['__proto__', ['null']], ['__proto__', ['null']]]], 'invalid object entry'],
      [['null-object', [['constructor', ['null']], ['constructor', ['null']]]], 'invalid object entry'],
      [['array', [['number', 'invalid']]], 'invalid number node'],
      [['array', [['null', 1]]], 'unknown or invalid state node'],
      [cycle, 'invalid or cyclic state node'],
    ];
    const original = WebAssembly.Instance;
    let instances = 0;
    WebAssembly.Instance = new Proxy(original, { construct() { instances++; throw new Error('Unexpected WASM attachment'); } });
    try {
      for (const [tree, message] of badTrees) {
        const error = errorOf(() => decodeZerocopyState({ ...packet, tree }));
        assert.ok(error instanceof TypeError);
        assert.equal(error.message, `zerocopy/redux: ${message}`);
      }
      assert.equal(instances, 0);
    } finally { WebAssembly.Instance = original; }
  });

  it('accepts every scalar tag and repeated acyclic subnodes with independent frozen results', () => {
    const shared = ['object', [['x', ['number', 3]]]];
    const tree = ['array', [
      ['null'], ['undefined'], ['boolean', true], ['string', 'é🙂'], ['number', 2.5],
      ['number', 'NaN'], ['number', '+Infinity'], ['number', '-Infinity'], ['number', '-0'],
      ['array', []], ['null-object', []], shared, shared,
    ]];
    const result = decodeZerocopyState<any>(plainPacket(tree));
    assert.deepEqual(result, [null, undefined, true, 'é🙂', 2.5, NaN, Infinity, -Infinity, -0,
      [], Object.create(null), { x: 3 }, { x: 3 }]);
    assert.notEqual(result[11], result[12]);
    for (const value of [result, result[9], result[10], result[11], result[12]]) assert.ok(Object.isFrozen(value));
  });

  it('retains exact node and depth budgets, including sparse holes', () => {
    const tree = ['array', [['hole'], ['number', 3], ['hole']]];
    const valid = decodeZerocopyState<any>(plainPacket(tree), { maxNodes: 4, maxDepth: 1 });
    assert.equal(valid.length, 3); assert.deepEqual(Object.keys(valid), ['1']); assert.equal(valid[1], 3);
    assert.throws(() => decodeZerocopyState(plainPacket(tree), { maxNodes: 3 }), /state tree exceeds codec limits/);
    assert.throws(() => decodeZerocopyState(plainPacket(['array', [['array', [['number', 1]]]]]), { maxDepth: 1 }), /state tree exceeds codec limits/);
    assert.throws(() => decodeZerocopyState(plainPacket(['array', Array.from({ length: 5 }, () => ['hole'])]), { maxNodes: 4 }), /array exceeds codec limits/);
  });

  it('rejects an active ancestor before rereading a getter that would change its tag to a scalar', () => {
    let tagReads = 0, valueReads = 0;
    const node: any[] = ['array', []];
    Object.defineProperty(node, 0, { get() { return ++tagReads === 1 ? 'array' : 'number'; } });
    Object.defineProperty(node, 1, { get() { valueReads++; return tagReads === 1 ? [node] : 7; } });
    assert.throws(() => decodeZerocopyState(plainPacket(node)), /invalid or cyclic state node/);
    assert.equal(tagReads, 1); assert.equal(valueReads, 1);
  });

  it('preserves input getter reads and their order in both passes', () => {
    const events: string[] = [];
    const child = new Proxy(['number', 7], { get(target, key, receiver) { events.push(`child:${String(key)}`); return Reflect.get(target, key, receiver); } });
    const pair = new Proxy(['key', child], { get(target, key, receiver) { events.push(`pair:${String(key)}`); return Reflect.get(target, key, receiver); } });
    assert.deepEqual(decodeZerocopyState(plainPacket(['object', [pair]])), { key: 7 });
    const pass = ['pair:length', 'pair:0', 'pair:0', 'pair:0', 'pair:1', 'child:0', 'child:1', 'child:length'];
    assert.deepEqual(events, [...pass, ...pass]);
  });

  it('preserves array length/index read order, holes, and later getter errors', () => {
    const events: string[] = [];
    const values = new Proxy([['hole'], ['number', 5]], { get(target, key, receiver) { events.push(String(key)); return Reflect.get(target, key, receiver); } });
    const result = decodeZerocopyState<any>(plainPacket(['array', values]));
    assert.equal(result.length, 2); assert.equal(Object.hasOwn(result, 0), false); assert.equal(result[1], 5);
    const pass = ['length', 'length', 'length', '0', '0', '0', 'length', '1', '1', '1', 'length'];
    assert.deepEqual(events, [...pass, ...pass]);

    const error = new Error('input getter');
    let gets = 0;
    const throwing = new Proxy([['number', 1]], { get(target, key, receiver) {
      if (key === 'length' && ++gets === 2) throw error;
      return Reflect.get(target, key, receiver);
    } });
    assert.throws(() => decodeZerocopyState(plainPacket(['array', throwing])), thrown => thrown === error);
    assert.equal(gets, 2);
  });

  it('preserves native array-length errors from proxy input before reading any element', () => {
    for (const length of [-1, NaN, 1.5, 2 ** 32]) {
      let elementReads = 0, lengthReads = 0;
      const values = new Proxy([], { get(target, key, receiver) {
        if (key === 'length') { lengthReads++; return length; }
        elementReads++; return Reflect.get(target, key, receiver);
      } });
      const expected = errorOf(() => new Array(length));
      const actual = errorOf(() => decodeZerocopyState(plainPacket(['array', values]), { maxNodes: 2 ** 32 + 1 }));
      assert.equal(actual.constructor, expected.constructor); assert.equal(actual.message, expected.message);
      assert.equal(lengthReads, 2); assert.equal(elementReads, 0);
    }
  });

  it('coerces a changing property key after its child, without prototype setter effects', () => {
    const events: string[] = [];
    let keyReads = 0;
    const key = { [Symbol.toPrimitive]() { events.push('coerce'); return '__proto__'; } };
    const pair = new Proxy(['__proto__', ['number', 9]], { get(target, property, receiver) {
      if (property === '0') { keyReads++; events.push(`key:${keyReads}`); return keyReads % 3 ? '__proto__' : key; }
      if (property === '1') events.push('child');
      return Reflect.get(target, property, receiver);
    } });
    const result = decodeZerocopyState<any>(plainPacket(['object', [pair]]));
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.ok(Object.hasOwn(result, '__proto__')); assert.equal(result.__proto__, 9);
    assert.deepEqual(events, ['key:1', 'key:2', 'key:3', 'child', 'coerce', 'key:4', 'key:5', 'key:6', 'child', 'coerce']);
  });

  it('does not read a duplicate entry child and preserves the original thrown getter', () => {
    const error = new Error('must not read duplicate child');
    const duplicate = ['x', ['null']]; Object.defineProperty(duplicate, 1, { get() { throw error; } });
    assert.throws(() => decodeZerocopyState(plainPacket(['object', [['x', ['null']], duplicate]])), /invalid object entry/);
    const first = ['x', ['null']]; Object.defineProperty(first, 1, { get() { throw error; } });
    assert.throws(() => decodeZerocopyState(plainPacket(['object', [first]])), thrown => thrown === error);
  });

  it('preserves shared aliases and nested dependencies through writable imports and workers', async () => {
    const child = new SharedList('number').pushMany([1, 2, 3]);
    const map = new SharedMap<'SharedList<number>'>('SharedList<number>').set('child', child);
    const sourceArena = arenaOf(map), sourceUsed = sourceArena.used, sourceBytes = sourceArena.copy();
    const text = serializeZerocopyState({ first: map, second: map, rows: [{ open: true }] });
    const restored = deserializeZerocopyState<any>(text);
    assert.equal(restored.first, restored.second);
    assert.deepEqual(restored.first.get('child').toArray(), [1, 2, 3]);
    assert.ok(Object.isFrozen(restored.rows[0]));
    const updated = restored.first.set('next', child.push(4));
    assert.equal(restored.first.size, 1); assert.equal(updated.size, 2);
    for (const copy of [false, true]) {
      const attached = (await initWorker<any>(getWorkerData({ updated }, { copy }))).updated;
      assert.deepEqual(attached.get('next').toArray(), [1, 2, 3, 4]);
      assert.throws(() => attached.set('forbidden', child), /read-only/);
    }
    assert.equal(sourceArena.used, sourceUsed); assert.deepEqual(sourceArena.copy(), sourceBytes);
  });
});
