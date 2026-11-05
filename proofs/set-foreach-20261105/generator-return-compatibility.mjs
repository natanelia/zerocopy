import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run with Bun against either source checkout. This is a deterministic
// compatibility probe, never a timed benchmark or a claim of improvement.
const directory = resolve(process.argv[2]);
const S = await import(pathToFileURL(join(directory, 'shared.ts')));
const rows = [];
for (const name of ['SharedSet', 'SharedOrderedSet', 'SharedSortedSet']) {
  const Ctor = S[name], prototype = Ctor.prototype.values.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, 'return');
  const snapshot = new Ctor().add('one').add('two'), error = new Error('callback');
  const visited = [], closes = [];
  try {
    assert.throws(() => snapshot.forEach(value => {
      visited.push(value);
      // All initial prototype checks would pass. Install the hook only while
      // the callback is active, immediately before IteratorClose is required.
      Object.defineProperty(prototype, 'return', { configurable: true, writable: true,
        value: function () {
          closes.push({ arguments: arguments.length, generatorPrototype: Object.getPrototypeOf(this) === prototype });
          return { done: true };
        } });
      throw error;
    }), thrown => thrown === error);
    assert.equal(visited.length, 1);
    rows.push({ name, visited, closes, expectedCloses: 1, compatible: closes.length === 1 });
  } finally {
    if (original) Object.defineProperty(prototype, 'return', original);
    else delete prototype.return;
  }
}
console.log(JSON.stringify({ runtime: process.versions, rows }, null, 2));
