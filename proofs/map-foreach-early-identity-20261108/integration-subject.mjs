import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This process must start without importing the root entry or internal paths.
const numericEntry = import.meta.resolve('zerocopy/numeric');
const rootEntry = import.meta.resolve('zerocopy');
assert.ok(numericEntry.endsWith('/numeric.ts'), numericEntry);
assert.ok(rootEntry.endsWith('/shared.ts'), rootEntry);
const { fromFloat64 } = await import('zerocopy/numeric');
const list = fromFloat64(new Float64Array([1.25, -0, 17.5]));
assert.deepEqual(list.toArray(), [1.25, -0, 17.5]);

// owner() is the public inherited static method on the returned constructor.
// No private/protected field or unexported package path is accessed.
const owner = list.constructor.owner(list);
const prototype = Object.getPrototypeOf(owner);
const descriptor = Object.getOwnPropertyDescriptor(prototype, 'leaves');
assert.equal(typeof descriptor.value, 'function');
const failure = new Error('Traversal hook installed before root import');
let hookCalls = 0, callbackCount = 0, caughtHook = false, map;
Object.defineProperty(prototype, 'leaves', {
  ...descriptor,
  value: function* preinstalledLeaves() { hookCalls++; throw failure; },
});
try {
  const { SharedMap } = await import('zerocopy');
  map = new SharedMap('number').set('alpha', 1).set('beta', 2);
  assert.equal(map.size, 2);
  assert.equal(map.get('alpha'), 1);
  assert.equal(map.get('beta'), 2);
  assert.equal(hookCalls, 0, 'Root initialization must not invoke the traversal hook');
  try { map.forEach(() => { callbackCount++; }); }
  catch (error) { assert.equal(error, failure); caughtHook = true; }
} finally {
  Object.defineProperty(prototype, 'leaves', descriptor);
}
assert.equal(hookCalls, 1, 'forEach must invoke a hook installed before root import');
assert.equal(callbackCount, 0, 'The hook throws before any callback');
assert.equal(caughtHook, true, 'forEach must propagate the original hook error');
const restored = [];
map.forEach((value, key) => restored.push([key, value]));
assert.deepEqual(restored, [...map.entries()]);
assert.equal(restored.length, 2);

const root = dirname(fileURLToPath(rootEntry));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
console.log(JSON.stringify({
  schema: 'zerocopy-map-early-identity-subject/v1', status: 'passed',
  runtime: process.versions, numericEntry, rootEntry,
  mapSize: map.size, hookCalls, callbackCount, caughtHook,
  nativeCallbacksAfterRestore: restored.length,
  source: Object.fromEntries(['numeric.ts', 'shared-map.ts', 'arena.ts', 'package.json'].map(name =>
    [name, sha(readFileSync(join(root, name)))])),
  timingMeasurements: false,
}));
