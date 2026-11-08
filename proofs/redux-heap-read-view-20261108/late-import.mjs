import assert from 'node:assert/strict';

// Run each mode in its own process. A source entrypoint needs Bun; portable
// mode works in Node/Bun. Overrides precede the optional Redux module import.
const sourceMode = process.argv.includes('--source');
const mode = process.argv.includes('--view') ? 'view' : 'decode';
const S = await import(new URL(sourceMode ? '../../shared.ts' : '../../dist/shared.js', import.meta.url));
let heap = new S.SharedPriorityQueue('number');
for (let i = 0; i < 65; i++) heap = heap.enqueue(i, i % 7);
// Only this internal compatibility proof accesses the protected Arena owner.
const arena = heap.arena, prototype = Object.getPrototypeOf(arena);
const descriptor = Object.getOwnPropertyDescriptor(prototype, mode === 'view' ? 'dv' : 'decode');
const view = Object.getOwnPropertyDescriptor(prototype, 'dv');
let calls = 0, laterViews = 0;
if (mode === 'view') {
  Object.defineProperty(prototype, 'dv', { configurable: true, get() {
    calls++; assert.equal(this, arena); return Reflect.apply(descriptor.get, this, []);
  } });
} else {
  Object.defineProperty(prototype, 'decode', { configurable: true, value(type, raw) {
    if (++calls === 1) Object.defineProperty(prototype, 'dv', { configurable: true, get() {
      laterViews++; return Reflect.apply(view.get, this, []);
    } });
    assert.equal(this, arena); return Reflect.apply(descriptor.value, this, [type, raw]) + 100;
  } });
}
try {
  const R = await import(new URL(sourceMode ? '../../redux.ts' : '../../dist/redux.js', import.meta.url));
  const encoded = R.createZerocopyCodec().encode(heap);
  assert.equal(calls, heap.size * (mode === 'view' ? 4 : 1));
  if (mode === 'decode') assert.equal(laterViews, heap.size * 4 - 3);
  const actual = encoded.value[4].map(row => row[0]).sort((a, b) => a - b);
  assert.deepEqual(actual, Array.from({ length: heap.size }, (_, i) => i + (mode === 'view' ? 0 : 100)));
  console.log(`Late Redux import (${sourceMode ? 'source' : 'portable'}, ${mode} override): exact fallback reads preserved`);
} finally {
  Object.defineProperty(prototype, mode === 'view' ? 'dv' : 'decode', descriptor);
  if (mode === 'decode') Object.defineProperty(prototype, 'dv', view);
}
