import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Arena, arenaOf, hashBytes, HEAP_START } from './arena';
import { SharedMap, compactMany, getWorkerData, initWorker } from './shared';

test('compactMany preserves shared retained map branches and observable fallbacks', async () => {
  // Full FNV-1a collision verified against the production hash implementation.
  const c1 = 'collision/259fe47/82289', c2 = 'collision/87dfa293/90509';
  const enc = new TextEncoder();
  assert.equal(hashBytes(enc.encode(c1)), hashBytes(enc.encode(c2)));
  const unicode = ['café', 'cafe\u0301', '道路/🚗', '\u0000inside', 'replacement/\ufffd'];
  const seed: [string, any][] = Array.from({ length: 60000 }, (_, i) => ['lane/' + i, { i, rev: 0, coords: [i, -i] }]);
  seed.push(...[c1, c2, ...unicode].map((key, i): [string, any] => [key, { i, rev: 0 }]));
  const a = new Arena(), root = new SharedMap('object', 0, 0, a).setMany(seed);
  const o0 = new Map(seed.map(([k, v]) => [k, JSON.stringify(v)]));
  function mutate(parent: SharedMap<'object'>, previous: Map<string, string>, updates: [string, any][], removed: string[] = []) {
    let next = parent;
    const oracle = new Map(previous);
    for (const [k, v] of updates) { next = next.set(k, v); oracle.set(k, JSON.stringify(v)); }
    for (const k of removed) { next = next.delete(k); oracle.delete(k); }
    return [next, oracle] as const;
  }
  const [r1, o1] = mutate(root, o0, [[c1, { i: 1, rev: 1 }], ['lane/1', { i: 1, rev: 1 }]]);
  const [r2, o2] = mutate(r1, o1, [[unicode[2], { rev: 2 }], ['lane/2', { i: 2, rev: 2 }]], [c2]);
  const [fork, ofork] = mutate(root, o0, [[c2, { i: 2, rev: 3 }], ['lane/3', { i: 3, rev: 3 }]]);
  const [r4, o4] = mutate(r2, o2, [[c2, { i: 2, rev: 4 }], ['lane/4', { i: 4, rev: 4 }]]);
  const input = { root, r1, r2, fork, r4 }, oracles = { root: o0, r1: o1, r2: o2, fork: ofork, r4: o4 };

  function verify(maps: Readonly<typeof input>) {
    const digests: Record<string, string> = {};
    for (const name of Object.keys(input) as (keyof typeof input)[]) {
      const m = maps[name], expected = oracles[name], seen = new Set<string>();
      const digest = createHash('sha256');
      for (const [key, value] of m.entries()) {
        assert(!seen.has(key));
        const json = JSON.stringify(value);
        assert.equal(json, expected.get(key));
        seen.add(key);
        digest.update(JSON.stringify([key, json]) + '\n');
      }
      assert.equal(seen.size, expected.size);
      assert.equal(m.size, expected.size);
      digests[name] = digest.digest('hex');
    }
    return digests;
  }
  const sourceUsed = a.used;
  const sourceHash = () => createHash('sha256').update(a.buf.subarray(HEAP_START, sourceUsed)).digest('hex');
  const before = sourceHash(), original = verify(input);
  const packed = compactMany(input);
  assert.deepEqual(verify(packed), original);
  const packedUsed = arenaOf(packed.root).used;

  const copied = await initWorker(getWorkerData(input, { copy: true }));
  assert.deepEqual(verify(compactMany(copied)), original);
  for (const copy of [true, false]) {
    const attached = await initWorker(getWorkerData(packed, { copy }));
    assert.deepEqual(verify(attached), original);
    for (const name of Object.keys(input) as (keyof typeof input)[]) {
      for (const key of [c1, c2, ...unicode]) {
        assert.equal(JSON.stringify(attached[name].get(key)), oracles[name].get(key));
      }
    }
  }

  const changed = packed.r4.set('lane/4', { i: 4, rev: 99 });
  assert.deepEqual(changed.get('lane/4'), { i: 4, rev: 99 });
  assert.deepEqual(packed.r4.get('lane/4'), { i: 4, rev: 4 });
  assert.deepEqual(packed.root.get('lane/4'), { i: 4, rev: 0, coords: [4, -4] });

  const alloc = Arena.prototype.alloc;
  let attempts = 0;
  try {
    Arena.prototype.alloc = function (n: number) {
      if (this !== a && ++attempts === 2) throw new RangeError('injected compaction allocation failure');
      return alloc.call(this, n);
    };
    assert.throws(() => compactMany(input), /injected compaction allocation failure/);
  } finally { Arena.prototype.alloc = alloc; }

  const leaves = Arena.prototype.leaves;
  let calls = 0, fallbackUsed = 0;
  try {
    Arena.prototype.leaves = function* (p: number) {
      if (this === a) calls++;
      yield* leaves.call(this, p);
    };
    const fallback = compactMany(input);
    fallbackUsed = arenaOf(fallback.root).used;
    assert.equal(calls, Object.keys(input).length);
    assert.deepEqual(verify(fallback), original);
  } finally { Arena.prototype.leaves = leaves; }
  // Structural sharing must actually reduce arena allocation in this fixture.
  assert(packedUsed < fallbackUsed);

  const descriptor = SharedMap.prototype.toWorkerData;
  let descriptorCalls = 0;
  try {
    SharedMap.prototype.toWorkerData = function () {
      descriptorCalls++;
      return descriptor.call(this);
    };
    const fallback = compactMany(input);
    assert.equal(descriptorCalls, Object.keys(input).length);
    assert.equal(arenaOf(fallback.root).used, fallbackUsed);
    assert.deepEqual(verify(fallback), original);
  } finally { SharedMap.prototype.toWorkerData = descriptor; }

  assert.equal(a.used, sourceUsed);
  assert.equal(sourceHash(), before);
  assert.deepEqual(verify(input), original);
}, 60000);
