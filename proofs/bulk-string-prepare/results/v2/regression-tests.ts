import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it, vi } from 'vitest';
import { Arena, HEAP_START } from './arena';
import { SharedMap, getWorkerData, initWorker } from './shared';

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const normalized = (value: string) => decoder.decode(encoder.encode(value));
const fresh = (arena = new Arena()) => new SharedMap('string', 0, 0, arena);
const contents = (map: SharedMap<'string'>) => [...map.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
function model(entries: readonly (readonly [string, string])[]) {
  return [...new Map(entries.map(([key, value]) => [normalized(key), normalized(value)]))]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
function bytesEqual(actual: Uint8Array, expected: Uint8Array) {
  assert.equal(actual.byteLength, expected.byteLength);
  assert.equal(Buffer.compare(actual, expected), 0);
}

describe('temporary bulk string preparation', () => {
  it('encodes each distinct Unicode value once per call and never encodes ASCII values', () => {
    const empty = fresh(), entries = Array.from({ length: 80 }, (_, i) => [`key-${i}`, ['界🙂', 'é', 'ASCII', ''][i % 4]] as const);
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
      const one = empty.setMany(entries);
      assert.deepEqual(encode.mock.calls.map(([value]) => value), ['界🙂', 'é']);
      encode.mockClear();
      one.setMany(entries);
      assert.deepEqual(encode.mock.calls.map(([value]) => value), ['界🙂', 'é']);
      encode.mockClear();
      empty.setMany([['a', 'ASCII'], ['b', ''], ['c', '\0']]);
      assert.equal(encode.mock.calls.length, 0);
    } finally { encode.mockRestore(); }
  });

  it('keeps canonical keys, last-write wins, BOM, empty values and malformed surrogates', () => {
    const values = ['', '\ufeff', '\ud800', '\udc00', '\ud800\ud800', 'a\0b', 'é', '界🙂'];
    const entries = Array.from({ length: 257 }, (_, i) => [`${i % 3 ? 'key' : '界'}-${i}`, values[i % values.length]] as const);
    entries.push(['costarring', '界🙂'], ['liquid', '界🙂'], ['\ud800', 'old'], ['\ufffd', '\ufefflast'], ['', '']);
    const frozen = Object.freeze(entries.map(entry => Object.freeze(entry)));
    const map = fresh().setMany(frozen);
    assert.deepEqual(contents(map), model(entries));
    assert.equal(map.get('\ud800'), '\ufefflast');
    assert.equal(map.get(''), '');
    const duplicate = fresh().setMany([['same', 7], ['same', '界']] as any);
    assert.equal(duplicate.get('same'), '界');
  });

  it('stops probing after a bounded unique prefix even if later values repeat', () => {
    const entries = Array.from({ length: 36 }, (_, i) => [`key-${i}`, `界value-${i < 16 ? i : 0}`] as const);
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    let map: SharedMap<'string'>;
    try {
      map = fresh().setMany(entries);
      assert.equal(encode.mock.calls.length, entries.length);
    } finally { encode.mockRestore(); }
    assert.deepEqual(contents(map!), model(entries));
  });

  it('abandons reuse after a bounded number of misses without changing outputs', () => {
    const values = ['界seed', '界seed', ...Array.from({ length: 16 }, (_, i) => `界unique-${i}`), '界seed', '界seed'];
    const entries = values.map((value, i) => [`key-${i}`, value] as const);
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    let map: SharedMap<'string'>;
    try {
      map = fresh().setMany(entries);
      assert.equal(encode.mock.calls.length, 19);
      assert.equal(encode.mock.calls.filter(([value]) => value === '界seed').length, 3);
    } finally { encode.mockRestore(); }
    assert.deepEqual(contents(map!), model(entries));
  });

  it('keeps distinct inline payloads and identical allocation for equal-length values', () => {
    const a = new Arena(), b = new Arena();
    const repeated = Array.from({ length: 65 }, (_, i) => [`key-${i}`, '界0000'] as const);
    const distinct = repeated.map(([key], i) => [key, `界${String(i).padStart(4, '0')}`] as const);
    const same = fresh(a).setMany(repeated), unique = fresh(b).setMany(distinct);
    assert.equal(a.used, b.used);
    assert.equal(same.root, unique.root);
    const addresses = new Set<number>();
    for (const leaf of a.leaves(same.root)) {
      const key = a.leafKey(leaf), keyLength = a.dv.getUint32(leaf + 8, true), start = leaf + 16 + keyLength;
      const length = a.dv.getUint32(leaf + 12, true);
      assert.equal(b.find(unique.root, key), leaf);
      bytesEqual(a.buf.subarray(start, start + length), encoder.encode('界0000'));
      addresses.add(start);
    }
    assert.equal(addresses.size, repeated.length);
    assert.deepEqual(contents(same), model(repeated));
    assert.deepEqual(contents(unique), model(distinct));
  });

  it('validates surviving values before allocation and keeps the next call independent', () => {
    const a = new Arena(), old = fresh(a).setMany([['held', 'old界']]);
    const end = a.used, before = a.buf.slice(HEAP_START, end);
    assert.throws(() => old.setMany([['good', '界'], ['bad', 17]] as any), /Expected a string/);
    assert.equal(a.used, end);
    bytesEqual(a.buf.subarray(HEAP_START, end), before);
    assert.equal(old.get('held'), 'old界');
    const next = old.setMany([['good', '🙂'], ['second', '🙂']]);
    assert.equal(next.get('good'), '🙂');
    assert.equal(next.get('second'), '🙂');
    assert.equal(old.get('good'), undefined);
  });

  for (const copy of [false, true]) it(`preserves old roots, forks and attached values after growth (copy=${copy})`, async () => {
    const a = new Arena(), entries = Array.from({ length: 257 }, (_, i) => [`key-${i}`, ['界🙂', '\ufeff', '', '\ud800'][i % 4]] as const);
    const old = fresh(a).setMany(entries), fork = old.setMany([['key-0', 'fork🙂'], ['fork', 'fork🙂']]);
    const end = a.used, before = a.buf.slice(HEAP_START, end), buffer = a.memory.buffer;
    const attached = await initWorker(getWorkerData({ old, fork }, { copy }));
    const next = old.setMany(Array.from({ length: 513 }, (_, i) => [`key-${i}`, '界🙂'.repeat(512)] as const));
    assert.notEqual(a.memory.buffer, buffer);
    assert.equal(next.size, 513);
    assert.equal(next.get('key-512'), '界🙂'.repeat(512));
    assert.deepEqual(contents(old), model(entries));
    assert.deepEqual(contents(attached.old), model(entries));
    assert.deepEqual(contents(attached.fork), contents(fork));
    assert.equal(attached.fork.get('fork'), 'fork🙂');
    assert.equal(attached.old.setMany([]), attached.old);
    assert.throws(() => attached.old.setMany([['forbidden', '界']]), /read-only/);
    bytesEqual(a.buf.subarray(HEAP_START, end), before);
  });

  it('preserves published bytes after a fixed-capacity failure and permits a smaller retry', () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true }), a = new Arena({ memory });
    const old = fresh(a).setMany([['held', '界']]), end = a.used, before = a.buf.slice(HEAP_START, end);
    a.alloc(memory.buffer.byteLength - Math.ceil(a.used / 8) * 8 - 128);
    assert.throws(() => old.setMany(Array.from({ length: 32 }, (_, i) => [`key-${i}`, '界🙂'] as const)), WebAssembly.RuntimeError);
    assert.equal(old.get('held'), '界');
    bytesEqual(a.buf.subarray(HEAP_START, end), before);
    const recovered = old.setMany([['ok', 'é']]);
    assert.equal(recovered.get('ok'), 'é');
    assert.equal(old.get('ok'), undefined);
  });
});
