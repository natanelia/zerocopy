import assert from 'node:assert/strict';
import * as S from '../shared';
import { Arena, arenaOf, HEAP_START } from '../arena';
const count = 4096, values = Array.from({ length: count }, (_, i) => i);
const rows: any[] = [];
function measure(name: string, build: () => any, verify: (s: any) => void) {
  const s = build(), a = arenaOf(s), used = a.used, start = performance.now(), copy = S.compact(s), ms = performance.now() - start;
  verify(s); verify(copy); assert.equal(a.used, used);
  rows.push({ name, sourceAllocatedBytes: used - HEAP_START, compactedAllocatedBytes: arenaOf(copy).used - HEAP_START, sourceReservedBytes: a.memory.buffer.byteLength, compactedReservedBytes: arenaOf(copy).memory.buffer.byteLength, compactMs: ms, remainingItems: s.size });
}
measure('vector.scalar', () => { S.resetSharedList(); let s = new S.SharedList('number'); for (const v of values) s = s.push(v); return s; }, s => assert.deepEqual(s.toArray(), values));
measure('vector.bulk', () => { S.resetSharedList(); return new S.SharedList('number').pushMany(values); }, s => assert.deepEqual(s.toArray(), values));
for (const [name, C, reset] of [['linked', S.SharedLinkedList, S.resetLinkedList], ['doubly', S.SharedDoublyLinkedList, S.resetDoublyLinkedList]] as const) {
  measure(name, () => { reset(); let s: any = new C('number'); for (const v of values) s = s.append(v); return s; }, s => assert.deepEqual(s.toArray(), values));
}
measure('queue.consumed', () => { S.resetQueue(); let s = new S.SharedQueue('number'); for (const v of values) s = s.enqueue(v); for (let i = 0; i < count - 32; i++) s = s.dequeue(); return s; }, s => { const out = []; while (s.size) { out.push(s.peek()); s = s.dequeue(); } assert.deepEqual(out, values.slice(-32)); });
for (const [name, C, reset] of [['map', S.SharedMap, S.resetMap], ['ordered', S.SharedOrderedMap, S.resetOrderedMap], ['sorted', S.SharedSortedMap, S.resetSortedMap]] as const) {
  measure(`${name}.churn`, () => { reset(); let s: any = new C('number'); for (let i = 0; i < count; i++) s = s.set(`key-${i % 128}`, i); return s; }, s => { for (let i = 0; i < 128; i++) assert.equal(s.get(`key-${i}`), count - 128 + i); assert.equal(s.size, 128); });
}
console.log(JSON.stringify({ runtime: process.versions, count, scope: 'WASM arena allocations and reserved pages, not total process memory. Source arenas are retained during measurement; compaction temporarily needs both.', rows }));
