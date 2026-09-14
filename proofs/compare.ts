/** The same file runs unchanged in the pinned baseline and candidate checkout. */
import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { SharedMap, configureAutoGC, resetMap } from '../shared-map';
import { SharedList, resetSharedList, getAllocState as listState } from '../shared-list';
import { SharedLinkedList, resetLinkedList } from '../shared-linked-list';
import { SharedDoublyLinkedList, resetDoublyLinkedList } from '../shared-doubly-linked-list';
import { SharedOrderedMap, resetOrderedMap } from '../shared-ordered-map';
import { SharedSortedMap, resetSortedMap } from '../shared-sorted-map';
import { SharedPriorityQueue, resetPriorityQueue } from '../shared-priority-queue';
import { SharedQueue, resetQueue } from '../shared-queue';
import { SharedStack, resetStack } from '../shared-stack';

// Old auto-GC disposes still-reachable snapshots. Disable it in both builds.
configureAutoGC({ enabled: false });
const n = Number(process.env.N ?? 4096), samples = Number(process.env.SAMPLES ?? 15), warmups = 20;
if (!Number.isInteger(n) || n < 1024 || n > 8192 || !Number.isInteger(samples) || samples < 3) throw Error('Use 1024 <= N <= 8192 and SAMPLES >= 3');
const values = Array.from({ length: n }, (_, i) => i);
const entries = values.slice(0, 1024).map(i => [`k${i}`, i] as [string, number]);
const keys = values.map(i => `k${i % 1024}`);
const indices = values.map(i => (Math.imul(i, 2654435761) >>> 0) % n);
const expectedRead = indices.reduce((a, b) => a + b, 0);
let sink = 0;
type Trial = { run(): void; verify(): number };
const rows: any[] = [];
function measure(name: string, units: string, setup: () => Trial) {
  if (process.env.ONLY && process.env.ONLY !== name) return;
  const times: number[] = [];
  for (let i = 0; i < samples + warmups; i++) {
    const trial = setup();
    const start = performance.now(); trial.run(); const elapsed = performance.now() - start;
    // Check complete outputs after timing. Never compare only size or one element.
    sink += trial.verify(); if (i >= warmups) times.push(elapsed);
  }
  const sorted = [...times].sort((a, b) => a - b);
  rows.push({ name, units, medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1), samplesMs: times });
}
measure('list.pushMany', `build ${n} numbers`, () => {
  resetSharedList(); const empty = new SharedList('number'); let result: any;
  return { run() { result = empty.pushMany(values); }, verify() { assert.deepEqual(result.toArray(), values); return result.size; } };
});
measure('list.toArray', `20 scans of ${n} numbers`, () => {
  resetSharedList(); const list = new SharedList('number').pushMany(values); let result: number[][];
  return { run() { result = []; for (let i = 0; i < 20; i++) result.push(list.toArray()); }, verify() { for (const a of result) assert.deepEqual(a, values); return result.length * n; } };
});
measure('list.push', `${n} scalar pushes`, () => {
  resetSharedList(); let result: any;
  return { run() { result = new SharedList('number'); for (const v of values) result = result.push(v); }, verify() { assert.deepEqual(result.toArray(), values); return result.size; } };
});
measure('map.setMany', 'build 1024 key/number entries', () => {
  resetMap(); const empty = new SharedMap('number'); let result: any;
  return { run() { result = empty.setMany(entries); }, verify() { assert.deepEqual(new Map(result.entries()), new Map(entries)); return result.size; } };
});
measure('map.get', `${n} hits over 1024 keys written in setup`, () => {
  resetMap(); let map = new SharedMap('number'); for (const [k, v] of entries) map = map.set(k, v); let total: number;
  return { run() { total = 0; for (const k of keys) total += map.get(k)!; }, verify() { assert.equal(total, values.reduce((s, v) => s + v % 1024, 0)); return total; } };
});
for (const [name, C, reset] of [['linked', SharedLinkedList, resetLinkedList], ['doubly', SharedDoublyLinkedList, resetDoublyLinkedList]] as const) {
  measure(`${name}.randomGet`, `${n} permuted indexed reads`, () => {
    reset(); let list: any = new C('number'); for (const v of values) list = list.append(v); let total: number;
    return { run() { total = 0; for (const i of indices) total += list.get(i); }, verify() { assert.equal(total, expectedRead); return total; } };
  });
  measure(`${name}.append`, `${n} scalar appends`, () => {
    reset(); let result: any;
    return { run() { result = new C('number'); for (const v of values) result = result.append(v); }, verify() { assert.deepEqual(result.toArray(), values); return result.size; } };
  });
}
for (const [name, C, reset] of [['ordered', SharedOrderedMap, resetOrderedMap], ['sorted', SharedSortedMap, resetSortedMap]] as const) {
  measure(`${name}.set`, '1024 scalar writes', () => {
    reset(); let result: any;
    return { run() { result = new C('number'); for (const [k, v] of entries) result = result.set(k, v); }, verify() { assert.deepEqual(new Map(result.entries()), new Map(entries)); if (name === 'ordered') assert.deepEqual([...result.entries()], entries); return result.size; } };
  });
}
measure('priority.enqueue', '1024 numeric enqueues', () => {
  resetPriorityQueue(); let result: any;
  return { run() { result = new SharedPriorityQueue('number'); for (let i = 0; i < 1024; i++) result = result.enqueue(i, Math.imul(i, 2654435761) >>> 0); }, verify() {
    const expected = Array.from({ length: 1024 }, (_, i) => [Math.imul(i, 2654435761) >>> 0, i]).sort(([a], [b]) => a - b);
    const actual: number[][] = []; let q = result;
    while (q.size) { actual.push([q.peekPriority(), q.peek()]); q = q.dequeue(); }
    assert.deepEqual(actual, expected); return result.size;
  } };
});
for (const [name, C, reset] of [['queue', SharedQueue, resetQueue], ['stack', SharedStack, resetStack]] as const) {
  measure(`${name}.build`, `${n} numeric insertions`, () => {
    reset(); let result: any;
    return { run() { result = new C('number'); for (const v of values) result = name === 'queue' ? result.enqueue(v) : result.push(v); }, verify() {
      const actual: number[] = []; let s = result;
      while (s.size) { actual.push(s.peek()); s = name === 'queue' ? s.dequeue() : s.pop(); }
      assert.deepEqual(actual, name === 'queue' ? values : [...values].reverse()); return result.size;
    } };
  });
}
resetSharedList(); const start = listState().heapEnd;
const allocationResult = new SharedList('number').pushMany(values);
const listBulkAllocationBytes = listState().heapEnd - start, listBulkUsedPrefixBytes = listState().heapEnd;
assert.deepEqual(allocationResult.toArray(), values);
console.log(JSON.stringify({ label: process.env.LABEL ?? 'unknown', n, samples, warmups, runtime: process.versions, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, rows, listBulkAllocationBytes, listBulkUsedPrefixBytes, sink }, null, 2));
