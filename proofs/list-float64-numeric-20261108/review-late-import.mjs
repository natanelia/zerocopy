// Isolated-process correctness reproduction: load the optional entry only
// after an existing arena's allocator protocol has been customized.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = resolve(process.argv[2] ?? '.');
const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
const held = new S.SharedList('number').pushMany([10, 20]);
const prototype = Object.getPrototypeOf(held.arena), descriptor = Object.getOwnPropertyDescriptor(prototype, 'alloc');
const input = new Float64Array([1.25, -0, 17.5]), expected = Array.from(input);
let calls = 0;
Object.defineProperty(prototype, 'alloc', { ...descriptor, value(bytes) {
  calls++; input.fill(99);
  return descriptor.value.call(this, bytes);
} });
try {
  const { fromFloat64 } = await import(pathToFileURL(join(directory, 'dist/numeric.js')));
  const result = fromFloat64(input), actual = result.toArray();
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  console.log(JSON.stringify({ runtime: process.versions, date: new Date().toISOString(),
    source: sha(readFileSync(join(directory, 'numeric.ts'))),
    bundle: sha(readFileSync(join(directory, 'dist/numeric.js'))),
    driver: sha(readFileSync(new URL(import.meta.url))),
    order: ['import shared', 'customize prototype allocator', 'import numeric', 'fromFloat64'],
    calls, expected, actual, inputAfter: Array.from(input), timingMeasurements: false }, null, 2));
  assert.equal(calls, 1);
  assert.deepEqual(actual, expected, 'Private input snapshot must precede a custom allocator');
  assert.deepEqual(held.toArray(), [10, 20]);
} finally {
  Object.defineProperty(prototype, 'alloc', descriptor);
}
