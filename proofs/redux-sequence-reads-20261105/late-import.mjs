import assert from 'node:assert/strict';

// Run each mode in a fresh process. --source exercises Bun's source entrypoints;
// the default checks the installed-style portable module graph in Node/Bun.
const sourceMode = process.argv.includes('--source'), decodeMode = process.argv.includes('--decode');
const S = await import(new URL(sourceMode ? '../../shared.ts' : '../../dist/shared.js', import.meta.url));
let stack = new S.SharedStack('number'), queue = new S.SharedQueue('number');
for (let i = 0; i < 40; i++) { stack = stack.push(i); queue = queue.enqueue(i); }
const patches = [], counts = { SharedStack: { peek: 0, next: 0, empty: 0 }, SharedQueue: { peek: 0, next: 0, empty: 0 } };
function replace(object, name, descriptor) {
  patches.push([object, name, Object.getOwnPropertyDescriptor(object, name)]);
  Object.defineProperty(object, name, { configurable: true, ...descriptor });
}
if (decodeMode) {
  // arena is a protected implementation property; use it only in this proof to
  // check that internal overrides made before optional Redux import fall back.
  const prototype = Object.getPrototypeOf(stack.arena), native = prototype.decode;
  replace(prototype, 'decode', { value: function (type, raw) { return Reflect.apply(native, this, [type, raw]) + 10; } });
} else {
  for (const [kind, C, nextName] of [['SharedStack', S.SharedStack, 'pop'], ['SharedQueue', S.SharedQueue, 'dequeue']]) {
    const prototype = C.prototype, peek = prototype.peek, next = prototype[nextName], count = counts[kind];
    const replacement = function () { assert.ok(Object.isFrozen(this)); return Reflect.apply(peek, this, []) + 100; };
    Object.defineProperty(replacement, 'call', { value() { throw new Error('unexpected function.call lookup'); } });
    replace(prototype, 'peek', { get() { count.peek++; assert.ok(Object.isFrozen(this)); return replacement; } });
    replace(prototype, nextName, { get() { count.next++; assert.ok(Object.isFrozen(this)); return next; } });
    replace(prototype, 'isEmpty', { get() { count.empty++; assert.ok(Object.isFrozen(this)); return this.size < 5; } });
  }
}
try {
  const R = await import(new URL(sourceMode ? '../../redux.ts' : '../../dist/redux.js', import.meta.url));
  const codec = R.createZerocopyCodec();
  for (const [kind, sequence] of [['SharedStack', stack], ['SharedQueue', queue]]) {
    let expected = Array.from({ length: 40 }, (_, i) => kind === 'SharedStack' ? 39 - i : i);
    if (!decodeMode) expected = expected.slice(0, 36);
    expected = expected.map(value => value + (decodeMode ? 10 : 100));
    assert.deepEqual(codec.encode(sequence), { $zerocopyRedux: 1, value: ['c', kind, 'number', null, expected] });
    if (!decodeMode) assert.deepEqual(counts[kind], { peek: 36, next: 36, empty: 37 });
  }
  console.log(`Late Redux import (${sourceMode ? 'source' : 'portable'}, ${decodeMode ? 'decoder' : 'reader getters'}): preserved exact overrides`);
} finally {
  for (const [object, name, descriptor] of patches.reverse()) Object.defineProperty(object, name, descriptor);
}
