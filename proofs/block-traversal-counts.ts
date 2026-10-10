/** Deterministic mechanism proof; no elapsed-time or heap measurement. Run with Bun. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [directory = '.', variant] = process.argv.slice(2);
if (variant !== 'baseline' && variant !== 'candidate') throw new Error('Usage: bun proofs/block-traversal-counts.ts DIRECTORY baseline|candidate');
const root = resolve(directory), api = await import(pathToFileURL(`${root}/shared.ts`).href);
const { Arena, arenaOf } = await import(pathToFileURL(`${root}/arena.ts`).href);
const get = Object.getOwnPropertyDescriptor(Arena.prototype, 'dv')!.get!;
const rows: any[] = [];
for (const name of ['SharedLinkedList', 'SharedDoublyLinkedList']) for (const size of [0, 1, 32, 33, 129, 4097]) {
  const a = new Arena(); let item = new api[name]('number', 0, 0, 0, a, 0);
  const expected = Array.from({ length: size }, (_, i) => i + 0.25);
  for (const value of expected) item = item.append(value);
  const dv = a.dv, pending = item.head ? [item.head] : []; let blocks = 0;
  while (pending.length) {
    const p = pending.pop()!; blocks++;
    for (const offset of [0, 4]) { const child = dv.getUint32(p + offset, true); if (child) pending.push(child); }
  }
  const refresh = a.refresh, calls = { dv: 0, refresh: 0 };
  Object.defineProperty(a, 'dv', { configurable: true, get() { calls.dv++; return get.call(this); } });
  a.refresh = function () { calls.refresh++; return refresh.call(this); };
  const prefix = size - item.tailSize;
  const operations: [string, () => number[], number[], boolean][] = [
    ['blocks-forward', () => [...a.blocks(item.head)], expected.slice(0, prefix), false],
    ['blocks-reverse', () => [...a.blocks(item.head, true)], expected.slice(0, prefix).reverse(), false],
    ['forEach', () => { const seen: number[] = []; item.forEach((value: number) => seen.push(value)); return seen; }, expected, true],
    ['compact', () => api.compact(item).toArray(), expected, true],
  ];
  if (name === 'SharedDoublyLinkedList') operations.push(['forEachReverse', () => {
    const seen: number[] = []; item.forEachReverse((value: number) => seen.push(value)); return seen;
  }, expected.slice().reverse(), true]);
  try {
    for (const [operation, run, want, withTail] of operations) {
      calls.dv = calls.refresh = 0;
      assert.deepEqual(run(), want);
      const count = (variant === 'baseline' ? prefix + 4 * blocks : item.head ? 1 : 0) + (withTail ? item.tailSize : 0);
      assert.deepEqual(calls, { dv: count, refresh: count }, `${name}/${size}/${operation}`);
      rows.push({ name, size, blocks, tail: item.tailSize, operation, ...calls });
    }
  } finally { delete a.dv; delete a.refresh; }
  assert.equal(arenaOf(item), a);
}
console.log(JSON.stringify({ variant, sourceSha256: createHash('sha256').update(readFileSync(`${root}/arena.ts`)).digest('hex'), rows }, null, 2));
