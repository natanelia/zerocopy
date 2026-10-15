/** Inert source checks only: synthetic iterators and deterministic fake clocks. */
import assert from 'node:assert/strict';
import { chunk, oracle, validateCase, resolutionOK } from './subject.mjs';

const events = [];
const firstMap = { entries() {
  events.push('entries');
  return { next() { events.push('next'); return { done: false, value: ['event:000000', 0] }; },
    return() { events.push('return'); return { done: true }; } };
} };
let times = [1, 4, 10, 15], at = 0;
const timed = chunk(firstMap, 'P', 'first', 2, oracle('P'), () => { events.push('clock'); return times[at++]; });
assert.equal(timed.milliseconds, 8);
assert.deepEqual(events, ['entries', 'clock', 'next', 'clock', 'return', 'entries', 'clock', 'next', 'clock', 'return']);

function small(corrupt = false) {
  return { size: 128, *entries() {
    for (let i = 0; i < 128; i++) yield ['event:' + String(i).padStart(6, '0'),
      (i % 4 === 0 ? i + 1000000 : i) + (corrupt && i === 127 ? 1 : 0)];
  } };
}
validateCase(small(), 'F128');
assert.throws(() => validateCase(small(true), 'F128'), /value mismatch/);
at = 0; times = [3, 11];
const full = chunk(small(), 'F128', 'full', 3, oracle('F128'), () => times[at++]);
assert.equal(full.milliseconds, 8); assert.equal(full.yieldedCount, 384); assert.equal(at, 2);
at = 0; assert.throws(() => chunk(small(true), 'F128', 'full', 3, oracle('F128'), () => times[at++]), /checksum mismatch/);

let opened = 0, next = 0, closed = 0;
const empty = { entries() { opened++; return { next() { next++; return { done: true }; },
  return() { closed++; return { done: true }; }, [Symbol.iterator]() { return this; } }; } };
at = 0; times = [5, 9];
assert.equal(chunk(empty, 'E0', 'first', 7, oracle('E0'), () => times[at++]).yieldedCount, 0);
assert.deepEqual([opened, next, closed, at], [7, 7, 7, 2]);
opened = next = closed = at = 0;
assert.equal(chunk(empty, 'E0', 'full', 7, oracle('E0'), () => times[at++]).yieldedCount, 0);
assert.deepEqual([opened, next, closed, at], [7, 7, 0, 2]);
assert.throws(() => chunk(empty, 'E0', 'first', 0, oracle('E0'), () => 0), /invalid K/);
assert.equal(resolutionOK('P', 'first', 2, [400, 401], 1), true);
assert.equal(resolutionOK('P', 'first', 2, [400, 399], 1), false);
assert.equal(resolutionOK('F128', 'first', 2, [200, 201], 1), true);
assert.equal(resolutionOK('F128', 'first', 2, [200, 0], 1), false);

// Added packed-storage controls use synthetic maps, counters and clock values only.
const extra = await import('./subject.mjs');
assert.equal(extra.retentionTotal({heapUsed: 10, external: 20, arrayBuffers: 17}, 'node'), 30);
assert.equal(extra.retentionTotal({heapSize: 40, extraMemorySize: 17, external: 20}, 'bun'), 40);
const beforeState = new Array(10).fill(10000), releasedState = [...beforeState];
releasedState[0] += 1000; releasedState[2] -= 1000;
assert.equal(extra.attributionOK(beforeState, releasedState, 'node', 512), false, 'offsetting residues do not clear');
releasedState[0] = beforeState[0] + 512; releasedState[2] = beforeState[2];
assert.equal(extra.attributionOK(beforeState, releasedState, 'node', 512), true);
releasedState[7] += 1000; releasedState[9] -= 1000;
assert.equal(extra.attributionOK(beforeState, releasedState, 'bun', 512), false);

function syntheticNumeric(size) {
  return { size, *entries() { for (let index = 0; index < size; index++) yield [extra.keyOf(index), index]; } };
}
for (const [id, size] of [['E0', 0], ['N1', 1], ['N32', 32], ['N4096', 4096], ['N4097', 4097], ['N8192', 8192], ['N8193', 8193]]) {
  const map = syntheticNumeric(size), holder = { value: null };
  validateCase(map, id);
  extra.pretouchMemoryIterator(map, id);
  extra.pauseMemoryIterator(holder, map, id);
  assert.notEqual(holder.value, null);
  assert.equal(extra.resumeAndReleaseMemoryIterator(holder, id), true);
  assert.equal(holder.value, null);
}
const brokenOne = { entries() { return { next() { return { done: false, value: ['event:000000', 0] }; }, return() {} }; } };
const badHolder = { value: null };
extra.pauseMemoryIterator(badHolder, brokenOne, 'N1');
assert.throws(() => extra.resumeAndReleaseMemoryIterator(badHolder, 'N1'), /should complete/);
for (const id of extra.CLOSE_CASES) {
  events.length = 0; at = 0; times = [2, 12];
  const lifecycle = chunk(firstMap, id, 'close', 2, oracle(id), () => { events.push('clock'); return times[at++]; });
  assert.equal(lifecycle.milliseconds, 10);
  assert.equal(lifecycle.yieldedCount, 2);
  assert.deepEqual(events, ['clock', 'entries', 'next', 'return', 'entries', 'next', 'return', 'clock']);
}
const forward = extra.endpointPlan(extra.CASES, ['first', 'full']);
const reverse = extra.endpointPlan(extra.CASES, ['full', 'first']);
assert.equal(forward.length, 18);
assert.equal(new Set(forward.map(([id, endpoint]) => id + ':' + endpoint)).size, 18);
assert.deepEqual(forward.slice(14), extra.CLOSE_CASES.map(id => [id, 'close']));
assert.deepEqual(reverse.slice(14), [...extra.CLOSE_CASES].reverse().map(id => [id, 'close']));
assert.equal(extra.overheadOK('P', 'first', 2, 400, 1), true);
assert.equal(extra.overheadOK('P', 'first', 2, 399, 1), false);
assert.equal(extra.overheadOK('P', 'close', 2, 200, 1), true);
assert.equal(extra.overheadOK('P', 'close', 2, 199, 1), false);
assert.equal(resolutionOK('P', 'close', 4096, [200], 1), true);
console.log(JSON.stringify({kind: 'inert-packed-subject-check', passed: true,
  libraryImported: false, clocks: 'synthetic', measurementOrAllocationProbeRun: false}));
