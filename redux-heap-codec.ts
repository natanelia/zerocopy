import { Arena, arenaOf } from './arena';
import { SharedPriorityQueue } from './shared-priority-queue';

/** Portable child indexes preserve equal-priority behavior. These are not WASM
 * pointers. Breadth-first order makes each child index greater than its parent.
 */
export function readReduxHeap(heap: SharedPriorityQueue<any>, encode: (value: unknown) => any): any[] {
  const arena = arenaOf(heap), nodes = heap.root ? [heap.root] : [], rows: any[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (nodes.length > heap.size) throw new TypeError('Invalid heap size');
    const node = nodes[i], left = arena.dv.getUint32(node + 16, true), right = arena.dv.getUint32(node + 20, true);
    const leftIndex = left ? nodes.push(left) - 1 : -1;
    const rightIndex = right ? nodes.push(right) - 1 : -1;
    rows.push([encode(arena.decode(heap.valueType, arena.dv.getFloat64(node + 8, true))),
      encode(arena.dv.getFloat64(node, true)), leftIndex, rightIndex]);
  }
  if (rows.length !== heap.size) throw new TypeError('Invalid heap size');
  return rows;
}

/** Rebuild only validated tree nodes in fresh unpublished storage. No pointer
 * from the input is accepted. Rank and subtree size are recomputed, not trusted.
 */
export function restoreReduxHeap(rows: any[], type: string, isMaxHeap: boolean, arena: Arena,
  decode: (value: unknown) => any, check: (value: unknown) => void): SharedPriorityQueue<any> {
  const bad = (): never => { throw new TypeError('zerocopy Redux: invalid heap topology or priority'); };
  const parents = new Uint8Array(rows.length), ranks = new Uint32Array(rows.length), sizes = new Uint32Array(rows.length);
  const priorities: number[] = [], values: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length !== 4) bad();
    const priority = decode(row[1]);
    if (typeof priority !== 'number' || Number.isNaN(priority)) bad();
    priorities.push(priority);
    const value = decode(row[0]); check(value); values.push(arena.encode(type, value));
    for (const child of [row[2], row[3]]) {
      if (!Number.isSafeInteger(child) || child < -1 || child >= rows.length || (child !== -1 && child <= i)) bad();
      if (child !== -1 && ++parents[child] !== 1) bad();
    }
  }
  for (let i = 1; i < rows.length; i++) if (parents[i] !== 1) bad();
  for (let i = rows.length - 1; i >= 0; i--) {
    const [, , left, right] = rows[i], leftRank = left === -1 ? 0 : ranks[left], rightRank = right === -1 ? 0 : ranks[right];
    if (leftRank < rightRank) bad();
    for (const child of [left, right]) if (child !== -1 && (isMaxHeap ? priorities[child] > priorities[i] : priorities[child] < priorities[i])) bad();
    ranks[i] = rightRank + 1;
    sizes[i] = 1 + (left === -1 ? 0 : sizes[left]) + (right === -1 ? 0 : sizes[right]);
  }
  const root = rows.length ? arena.alloc(rows.length * 32) : 0, view = arena.dv;
  for (let i = 0; i < rows.length; i++) {
    const p = root + i * 32, [, , left, right] = rows[i];
    view.setFloat64(p, priorities[i], true); view.setFloat64(p + 8, values[i], true);
    view.setUint32(p + 16, left === -1 ? 0 : root + left * 32, true);
    view.setUint32(p + 20, right === -1 ? 0 : root + right * 32, true);
    view.setUint32(p + 24, ranks[i], true); view.setUint32(p + 28, sizes[i], true);
  }
  return new SharedPriorityQueue(type, { root, size: rows.length, isMaxHeap }, arena);
}
