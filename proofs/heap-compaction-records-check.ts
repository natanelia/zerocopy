import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as S from '../shared';
import { Arena, arenaOf, HEAP_START } from '../arena';
import * as B from '../.proof-tools/heap-compaction-records/baseline';
import * as C from '../.proof-tools/heap-compaction-records/candidate';
import { cases as screenCases, makeFixture, logical, checkAliases, backingBound } from './heap-compaction-records-fixtures.mjs';

const results: string[] = [], operations: any[] = [];
function check(name: string, fn: () => void) { fn(); results.push(name); }
function values(heap: any) { return [...heap.entries()]; }
function bytes(snapshot: any) { return arenaOf(snapshot).copy(); }
function nodeMap(heap: any): Map<number, number> {
  const a = arenaOf(heap), found = new Map<number, number>(), pending = heap.root ? [heap.root] : [];
  while (pending.length) {
    const p = pending.pop()!; if (found.has(p)) continue;
    found.set(p, found.size);
    const left = a.dv.getUint32(p + 16, true), right = a.dv.getUint32(p + 20, true);
    if (right) pending.push(right); if (left) pending.push(left);
  }
  return found;
}
function topology(heap: any) {
  const nodes = nodeMap(heap), a = arenaOf(heap);
  return [...nodes.keys()].map(p => [a.dv.getFloat64(p, true), nodes.get(a.dv.getUint32(p + 16, true)) ?? -1, nodes.get(a.dv.getUint32(p + 20, true)) ?? -1, a.dv.getUint32(p + 24, true), a.dv.getUint32(p + 28, true)]);
}
function compactWith(mod: typeof B | typeof C, source: any) {
  const compactor = new mod.Compactor();
  // Test-only common target identity makes nested descriptor bytes exactly comparable.
  // The production algorithm and all source identities remain unchanged.
  Object.defineProperty(compactor.target, 'id', { value: 'heap-compaction-proof-target' });
  return compactor.snapshot(source);
}
function paired(source: any, name: string, ordinary = false) {
  const before = bytes(source), used = arenaOf(source).used, shape = topology(source);
  B.resetCounts(); const baseline = compactWith(B, source), baselineCounts = { ...B.counts };
  C.resetCounts(); const candidate = compactWith(C, source), candidateCounts = { ...C.counts };
  assert.deepEqual(bytes(candidate), bytes(baseline), `${name}: exact compacted bytes`);
  assert.deepEqual(candidate.toWorkerData(), baseline.toWorkerData());
  assert.deepEqual(topology(candidate), shape);
  assert.deepEqual(topology(baseline), shape);
  assert.deepEqual(values(candidate), values(baseline));
  assert.deepEqual(bytes(source), before); assert.equal(arenaOf(source).used, used);
  const roots = baselineCounts.stackArrays, expanded = baselineCounts.expanded;
  const edges = baselineCounts.heapKeys - baselineCounts.pops - roots;
  assert.equal(candidateCounts.stackArrays, roots); assert.equal(candidateCounts.expanded, expanded);
  assert.equal(baselineCounts.tupleExpressions, roots + 3 * expanded);
  assert.equal(candidateCounts.tupleExpressions, roots + expanded + edges);
  assert.equal(baselineCounts.zeroPops, 2 * expanded - edges); assert.equal(candidateCounts.zeroPops, 0);
  assert.equal(candidateCounts.heapKeys, candidateCounts.pops + edges + roots);
  operations.push({ name, ordinary, nodes: nodeMap(source).size, nonemptyHeapCalls: roots, expandedNodes: expanded, nonzeroChildEdges: edges, baseline: baselineCounts, candidate: candidateCounts });
  if (ordinary) {
    const n = nodeMap(source).size;
    assert.equal(baselineCounts.tupleExpressions, n ? 3 * n + 1 : 0);
    assert.equal(candidateCounts.tupleExpressions, n ? 2 * n : 0);
    assert.equal(baselineCounts.zeroPops, n ? n + 1 : 0); assert.equal(candidateCounts.zeroPops, 0);
    assert.equal(baselineCounts.pops, baselineCounts.tupleExpressions); assert.equal(candidateCounts.pops, candidateCounts.tupleExpressions);
    assert.equal(baselineCounts.heapKeys, n ? 4 * n + 1 : 0); assert.equal(candidateCounts.heapKeys, n ? 3 * n : 0);
    assert.equal(baselineCounts.pushCalls, n); assert.equal(candidateCounts.pushCalls, n ? 2 * n - 1 : 0);
    assert.equal(candidateCounts.childGuards, 2 * n);
  }
  if (!source.valueType.startsWith('Shared')) {
    const actual = S.compact(source);
    assert.deepEqual(bytes(actual), bytes(candidate), `${name}: uninstrumented production bytes`);
    assert.deepEqual(values(actual), values(source));
  }
  return { baseline, candidate };
}
function make(type: any, data: any[], priorities: number[], maxHeap = false) {
  let h: any = new S.SharedPriorityQueue(type, { maxHeap }, new Arena());
  for (let i = 0; i < data.length; i++) h = h.enqueue(data[i], priorities[i]);
  return h;
}
for (const n of [0, 1, 2, 3, 7, 31, 257, 2049]) for (const maxHeap of [false, true]) {
  check(`number tree ${n}, max=${maxHeap}`, () => paired(make('number', Array.from({ length: n }, (_, i) => i), Array.from({ length: n }, (_, i) => (i * 37) % 101), maxHeap), `number-${n}-${maxHeap}`, true));
}
check('long left spine, 6000 nodes', () => {
  const source = make('number', Array.from({ length: 6000 }, (_, i) => i), Array.from({ length: 6000 }, (_, i) => -i));
  let p = source.root, length = 0; const a = arenaOf(source);
  while (p) { assert.equal(a.dv.getUint32(p + 20, true), 0); p = a.dv.getUint32(p + 16, true); length++; }
  assert.equal(length, 6000); paired(source, 'left-spine-6000', true);
});
check('number bit patterns and equal/infinite priorities', () => {
  const source = make('number', [NaN, -0, 0, Infinity, -Infinity, 3.25], [1, 1, 1, Infinity, -Infinity, 1]);
  paired(source, 'numeric-bits', true);
});
check('boolean values', () => paired(make('boolean', [true, false, true], [0, 1, 0]), 'booleans', true));
check('shared raw strings, UTF-8, and target growth', () => {
  const source = make('string', ['same', 'same', '\uFEFF🙂é', 'x'.repeat(180000), 'last'], [3, 1, 2, 0, 4]);
  const { candidate } = paired(source, 'strings-and-growth', true);
  assert(arenaOf(candidate).memory.buffer.byteLength > 131072);
  const pointers = [...nodeMap(candidate).keys()].filter(p => arenaOf(candidate).decode('string', arenaOf(candidate).dv.getFloat64(p + 8, true)) === 'same').map(p => arenaOf(candidate).dv.getFloat64(p + 8, true));
  assert.equal(pointers[0], pointers[1]);
});
check('object blobs are copied without decoding', () => {
  const source = make('object', [{ a: [1, 2] }, { text: '🙂' }, null], [0, 1, 1]);
  const a = arenaOf(source), original = a.decode;
  a.decode = () => { throw new Error('Unexpected object decode'); };
  const baseline = B.compact(source), candidate = S.compact(source);
  assert.deepEqual(bytes(candidate), bytes(baseline)); a.decode = original;
  assert.deepEqual(values(candidate), values(source)); assert(Object.isFrozen(candidate.peek()));
});
check('compaction preserves forks and pointer sharing across a group', () => {
  const source = make('number', Array.from({ length: 255 }, (_, i) => i), Array.from({ length: 255 }, (_, i) => i));
  const fork = source.enqueue(999, -1), popped = source.dequeue(), before = bytes(source);
  B.resetCounts(); const baseline = B.compactMany({ source, fork, popped, again: source }), baselineCounts = { ...B.counts };
  C.resetCounts(); const candidate = C.compactMany({ source, fork, popped, again: source }), candidateCounts = { ...C.counts };
  const production = S.compactMany({ source, fork, popped, again: source });
  assert.deepEqual(bytes(production.source), bytes(candidate.source));
  const roots = baselineCounts.stackArrays, expanded = baselineCounts.expanded, edges = baselineCounts.heapKeys - baselineCounts.pops - roots;
  assert.equal(candidateCounts.tupleExpressions, roots + expanded + edges); assert.equal(baselineCounts.tupleExpressions, roots + 3 * expanded);
  operations.push({ name: 'shared-fork-group', ordinary: false, nonemptyHeapCalls: roots, expandedNodes: expanded, nonzeroChildEdges: edges, baseline: baselineCounts, candidate: candidateCounts });
  assert.deepEqual(bytes(candidate.source), bytes(baseline.source));
  assert.equal(candidate.source, candidate.again); assert.equal(arenaOf(candidate.source), arenaOf(candidate.fork));
  const shared = (a: any, b: any) => [...nodeMap(a).keys()].filter(p => nodeMap(b).has(p)).length;
  assert(shared(source, fork) > 0); assert.equal(shared(candidate.source, candidate.fork), shared(source, fork));
  assert.equal(shared(candidate.source, candidate.popped), shared(source, popped));
  for (const key of ['source', 'fork', 'popped']) { assert.deepEqual(values(candidate[key]), values(baseline[key])); assert.deepEqual(topology(candidate[key]), topology(({ source, fork, popped } as any)[key])); }
  candidate.source.enqueue(555, -2).dequeue(); assert.deepEqual(bytes(source), before); assert.deepEqual(values(candidate.again), values(source));
});
check('same numerical pointers in distinct arenas remain distinct', () => {
  const a = make('string', ['west'], [1]), b = make('string', ['east'], [2]);
  assert.equal(a.root, b.root);
  const base = B.compactMany({ a, b }), next = S.compactMany({ a, b });
  assert.deepEqual(bytes(next.a), bytes(base.a)); assert.notEqual(next.a.root, next.b.root);
  assert.equal(next.a.peek(), 'west'); assert.equal(next.b.peek(), 'east');
});
check('repeated child pointers retain sharing and postorder', () => {
  const a = new Arena(), child = a.alloc(32), root = a.alloc(32);
  a.dv.setFloat64(child, 2, true); a.dv.setFloat64(child + 8, 22, true);
  a.dv.setUint32(child + 24, 1, true); a.dv.setUint32(child + 28, 1, true);
  a.dv.setFloat64(root, 1, true); a.dv.setFloat64(root + 8, 11, true);
  a.dv.setUint32(root + 16, child, true); a.dv.setUint32(root + 20, child, true);
  a.dv.setUint32(root + 24, 2, true); a.dv.setUint32(root + 28, 3, true);
  const source = new S.SharedPriorityQueue('number', { root, size: 3, isMaxHeap: false }, a);
  const { candidate } = paired(source, 'shared-child-dag');
  const target = arenaOf(candidate);
  assert.equal(target.dv.getUint32(candidate.root + 16, true), target.dv.getUint32(candidate.root + 20, true));
  assert.equal(nodeMap(candidate).size, 2);
});
check('pointer-cache type namespaces remain distinct', () => {
  const number = make('number', [0, 1, 1], [0, 1, 2]);
  const boolean = new S.SharedPriorityQueue('boolean', { root: number.root, size: number.size, isMaxHeap: false }, arenaOf(number));
  const baseline = B.compactMany({ number, boolean }), candidate = S.compactMany({ number, boolean });
  assert.deepEqual(bytes(candidate.number), bytes(baseline.number));
  assert.notEqual(candidate.number.root, candidate.boolean.root);
  assert.deepEqual(values(candidate.boolean), values(boolean));
});
check('nested heaps, repeated snapshots, and nonheap children', () => {
  const inner = make('string', ['a', 'b', 'x'.repeat(160000)], [2, 1, 3]);
  const outer = make('SharedPriorityQueue<string>', [inner, inner, inner.enqueue('c', 3)], [2, 1, 0]);
  const { candidate } = paired(outer, 'nested-heap');
  assert(arenaOf(candidate).memory.buffer.byteLength > 131072);
  assert.deepEqual([...candidate.entries()].map(([v, p]: any) => [values(v), p]), [...outer.entries()].map(([v, p]: any) => [values(v), p]));
  assert.equal(S.getWorkerData({ candidate }, { copy: false }).arenas.length, 1);
  const group = S.compactMany({ outer, inner, again: outer });
  assert.equal(group.outer, group.again);
  assert([...group.outer.entries()].some(([v]: any) => v.root === group.inner.root));
  const list = new S.SharedList('string').pushMany(['hello', 'world']);
  const mixed = make('SharedList<string>', [list, list], [0, 1]);
  paired(mixed, 'nested-list');
});
check('dequeue order survives min/max compaction and tied priorities', () => {
  function drain(heap: any) { const rows: any[] = []; while (heap.size) { rows.push([heap.peek(), heap.peekPriority()]); heap = heap.dequeue(); } return rows; }
  for (const maxHeap of [false, true]) {
    const source = make('string', Array.from({ length: 63 }, (_, i) => `value-${i}`), Array.from({ length: 63 }, (_, i) => i % 5), maxHeap);
    const expected = drain(source), baseline = drain(B.compact(source)), candidate = drain(S.compact(source));
    assert.deepEqual(candidate, expected); assert.deepEqual(candidate, baseline);
  }
});
check('reentrant nested decoding and source growth preserve traversal', () => {
  const inner = make('number', [3, 1, 2], [3, 1, 2]);
  const source = make('SharedPriorityQueue<number>', [inner, inner.enqueue(0, 0)], [1, 0]);
  const a = arenaOf(source), original = a.decode, stable = a.buf.slice(HEAP_START, a.used), trace: any[] = [];
  function arm(mod: typeof B | typeof C) {
    const log: number[] = []; let reentered = false;
    a.decode = function(type: string, raw: number) {
      log.push(raw);
      if (!reentered) { reentered = true; const unrelated = mod.compact(inner); assert.deepEqual(values(unrelated), values(inner)); a.alloc(150000); }
      return original.call(this, type, raw);
    };
    try { const output = compactWith(mod, source); trace.push(log); return output; } finally { a.decode = original; }
  }
  const baseline = arm(B), candidate = arm(C);
  assert.deepEqual(bytes(candidate), bytes(baseline)); assert.deepEqual(trace[0], trace[1]);
  assert.deepEqual(a.buf.slice(HEAP_START, HEAP_START + stable.length), stable);
});
check('nested decode failure preserves error, order and source bytes', () => {
  const inner = make('number', [1], [1]), source = make('SharedPriorityQueue<number>', [inner, inner.enqueue(2, 2)], [1, 0]);
  const a = arenaOf(source), original = a.decode, before = bytes(source), marker = new Error('decode marker');
  const logs: number[][] = [];
  for (const compact of [B.compact, S.compact]) {
    const log: number[] = []; logs.push(log);
    a.decode = function(type: string, raw: number) { log.push(raw); if (log.length === 2) throw marker; return original.call(this, type, raw); };
    try { assert.throws(() => compact(source), error => error === marker); } finally { a.decode = original; }
    assert.deepEqual(bytes(source), before);
  }
  assert.deepEqual(logs[0], logs[1]); assert.equal(S.compact(source).size, 2);
});
check('invalid child pointer retains native range failure and source bytes', () => {
  const a = new Arena(), p = a.alloc(32); a.dv.setUint32(p + 16, 0xfffffff8, true);
  const source = new S.SharedPriorityQueue('number', { root: p, size: 1, isMaxHeap: false }, a), before = bytes(source);
  const errors: any[] = [];
  for (const compact of [B.compact, S.compact]) { try { compact(source); assert.fail('Expected range error'); } catch (error) { errors.push(error); } }
  assert(errors.every(error => error instanceof RangeError)); assert.equal(errors[0].message, errors[1].message); assert.deepEqual(bytes(source), before);
});
check('allocation failure preserves request order and partial target bytes', () => {
  const source = make('string', ['one', 'two', 'three'], [2, 1, 0]), before = bytes(source);
  for (let failAt = 1; failAt <= 6; failAt++) {
    const marker = new Error(`allocation-${failAt}`), attempts: number[][] = [], partials: Uint8Array[] = [];
    for (const mod of [B, C]) {
      const compactor = new mod.Compactor(), target = compactor.target, original = target.alloc, log: number[] = [];
      attempts.push(log);
      target.alloc = function(length: number) { log.push(length); if (log.length === failAt) throw marker; return original.call(this, length); };
      assert.throws(() => compactor.snapshot(source), error => error === marker); partials.push(target.copy());
      assert.deepEqual(bytes(source), before);
    }
    assert.deepEqual(attempts[0], attempts[1]); assert.deepEqual(partials[0], partials[1]);
  }
});
check('all nonheap collection compaction paths retain exact output', () => {
  const sources = {
    map: new S.SharedMap('number').set('b', 2).set('a', 1), set: new S.SharedSet().add('a').add(1),
    list: new S.SharedList('number').pushMany(Array.from({ length: 80 }, (_, i) => i)),
    stack: new S.SharedStack('string').push('a').push('b'), queue: new S.SharedQueue('number').enqueue(1).enqueue(2).dequeue(),
    linked: new S.SharedLinkedList('string').append('a').append('b'), doubly: new S.SharedDoublyLinkedList('number').append(1).append(2),
    ordered: new S.SharedOrderedMap('number').set('a', 1).set('b', 2).set('a', 3), orderedSet: new S.SharedOrderedSet().add('a').add('b'),
    sorted: new S.SharedSortedMap('number').set('b', 2).set('a', 1), sortedSet: new S.SharedSortedSet().add('b').add('a'),
  };
  const baseline = B.compactMany(sources), candidate = S.compactMany(sources);
  assert.deepEqual(bytes(candidate.map), bytes(baseline.map));
  for (const key of Object.keys(sources)) assert.deepEqual(candidate[key].toWorkerData(), baseline[key].toWorkerData());
  const compare = (a: string, b: string) => b.localeCompare(a), custom = new S.SharedSortedMap('number', compare).set('a', 1).set('z', 2);
  assert.deepEqual(bytes(S.compact(custom)), bytes(B.compact(custom))); assert.deepEqual([...S.compact(custom).keys()], ['z', 'a']);
  assert.throws(() => S.getWorkerData({ custom: S.compact(custom) }), /comparator/);
});
check('invalid inputs retain public failures', () => {
  for (const compact of [B.compact, S.compact]) assert.throws(() => compact({} as any), /Expected an immutable shared collection/);
  for (const compactMany of [B.compactMany, S.compactMany]) assert.throws(() => compactMany({ [Symbol('x')]: new S.SharedPriorityQueue('number') } as any), /Snapshot names must be strings/);
});
const screenAllocations: any[] = [];
for (const name of Object.keys(screenCases)) check(`prospective screen bytes, values, aliases and allocations: ${name}`, () => {
  const source = makeFixture(S, name), expected = logical(S, source);
  const original = S.getWorkerData(source, { copy: true });
  const runs: any[] = [];
  for (const mod of [B, C]) {
    const compactor = new mod.Compactor(), allocations: number[] = [], alloc = compactor.target.alloc;
    Object.defineProperty(compactor.target, 'id', { value: 'heap-compaction-screen-fixed-target' });
    compactor.target.alloc = function(size: number) { allocations.push(size); return alloc.call(this, size); };
    const output = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, compactor.snapshot(value as any)]));
    assert.deepEqual(logical(S, output), expected); checkAliases(output, name);
    runs.push({ target: compactor.target, allocations, descriptors: Object.fromEntries(Object.entries(output).map(([k, v]: any) => [k, v.toWorkerData()])) });
  }
  assert.deepEqual(runs[0].target.copy(), runs[1].target.copy());
  assert.deepEqual(runs[0].allocations, runs[1].allocations); assert.deepEqual(runs[0].descriptors, runs[1].descriptors);
  assert.equal(runs[0].target.used, runs[1].target.used); assert.equal(runs[0].target.memory.buffer.byteLength, runs[1].target.memory.buffer.byteLength);
  const production = S.compactMany(source); assert.deepEqual(logical(S, production), expected); checkAliases(production, name);
  const after = S.getWorkerData(source, { copy: true });
  original.arenas.forEach((a: any, i: number) => assert.deepEqual(after.arenas[i].copy, a.copy));
  const packed = S.getWorkerData(production, { copy: false }); assert.equal(packed.arenas.length, 1);
  const bound = backingBound(packed.arenas[0].used, name);
  screenAllocations.push({ name, fixedIdUsed: runs[0].target.used, fixedIdBackingBytes: runs[0].target.memory.buffer.byteLength, allocRequestCount: runs[0].allocations.length, productionInitialBackingBytes: packed.arenas[0].memory!.buffer.byteLength, ...bound });
});
const summary = { passed: true, runtime: typeof Bun === 'undefined' ? process.version : `Bun ${Bun.version}`, checks: results.length, results, operations, screenAllocations, claims: 'Untimed source-expression counts and deterministic arena allocation/layout equivalence only; no runtime allocation, JS heap, RSS, throughput, or latency claim.' };
writeFileSync('.proof-tools/heap-compaction-records/correctness.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, checks: results.length, countedFixtures: operations.length }));
