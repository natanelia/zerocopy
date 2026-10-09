import assert from 'node:assert/strict';
import { Arena, arenaOf } from '../../arena';
import { SharedLinkedList, SharedDoublyLinkedList, compact } from '../../shared';
const modes = ['linked', 'doubly', 'reverse', 'compact'] as const;
const counts = () => ({ generatorStarts: 0, generatorNext: 0, stackArrays: 0, scalarYields: 0, spanCallbacks: 0, spanClosures: 0, dv: 0, refresh: 0, decode: 0, callback: 0 });
(globalThis as any).__blockCounts = counts();
const gp = Object.getPrototypeOf(Arena.prototype.blocks.prototype), next = gp.next;
gp.next = function (...args: any[]) {
  if (Object.getPrototypeOf(this) === Arena.prototype.blocks.prototype) (globalThis as any).__blockCounts.generatorNext++;
  return Reflect.apply(next, this, args);
};
const output = [];
for (const n of [0, 1, 32, 33, 65, 4097]) for (const mode of modes) {
  const a = new Arena({ memory: new WebAssembly.Memory({ initial: 2, maximum: 256, shared: true }) });
  let list: any = mode === 'linked' || mode === 'compact' ? new SharedLinkedList('number', 0, 0, 0, a) : new SharedDoublyLinkedList('number', 0, 0, 0, a);
  for (let i = 0; i < n; i++) list = list.append(i);
  const decoded = a.decode; a.decode = function (type, raw) { (globalThis as any).__blockCounts.decode++; return decoded.call(this, type, raw); };
  const before = a.used; (globalThis as any).__blockCounts = counts();
  const result: number[] = [];
  if (mode === 'compact') {
    const copied: any = compact(list); assert.equal(copied.size, n);
  } else {
    const callback = (value: number, index: number) => { (globalThis as any).__blockCounts.callback++; assert.equal(value, index); result.push(value); };
    if (mode === 'reverse') list.forEachReverse(callback); else list.forEach(callback);
    assert.deepEqual(result, Array.from({length:n}, (_,i)=> mode === 'reverse' ? n-1-i:i));
  }
  const observed = (globalThis as any).__blockCounts;
  assert.equal(a.used, before);
  output.push({ n, mode, headValues: n-list.tailSize, tailValues: list.tailSize, sourceUsedDelta: a.used-before, ...observed });
}
gp.next = next;
console.log(JSON.stringify({ runtime: process.version, bun: (globalThis as any).Bun?.version ?? null, cases: output }, null, 2));
