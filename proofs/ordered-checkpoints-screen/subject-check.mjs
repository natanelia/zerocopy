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
console.log(JSON.stringify({ kind: 'inert-subject-check', passed: true, libraryImported: false, clocks: 'synthetic' }));
