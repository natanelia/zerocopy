import { arenaOf } from './arena';
import { NATIVE_LITTLE_ENDIAN, typedArrayBuffer, typedArrayOffset } from './memory';
import type { SharedList } from './shared-list';

// Internal kernel. Callers validate ranges and use a checked ArrayBuffer
// destination or a fresh shared allocation that cannot alias a snapshot.
export function copyFloat64Range(
  list: SharedList<'number'>, target: Float64Array, start: number, end: number, offset: number,
): void {
  if (start === end) return;
  const { size, root, depth, tail } = list;
  const a = arenaOf(list), view = a.dv;
  const tailStart = (size - 1) & ~31;
  // Scalar reads avoid temporary views for short spans and handle host byte order.
  if (end - start <= 64 || !NATIVE_LITTLE_ENDIAN) {
    for (let index = start; index < end;) {
      const first = index & ~31, stop = Math.min(end, first + 32);
      const leaf = first >= tailStart ? tail : a.wasm.vecLeaf(root, depth, index) >>> 0;
      for (; index < stop; index++) target[offset++] = view.getFloat64(leaf + (index - first) * 8, true);
    }
    return;
  }

  const source = view.buffer;
  const output = new Uint8Array(typedArrayBuffer.call(target), typedArrayOffset.call(target) + offset * 8, (end - start) * 8);
  const firstBlock = start & ~31;
  // A range can start in the middle of a group of 32 leaves.
  let parent = depth && firstBlock < tailStart && (firstBlock & 1023)
    ? a.wasm.vecLeaf(root, depth - 1, firstBlock >>> 5) >>> 0 : 0;
  let leafOffset = (start & 31) * 8;
  let spanStart = -1, spanEnd = -1, written = 0;
  // Bulk appends place consecutive leaves next to each other. An edit can
  // replace just one leaf, so copy adjacent spans together in logical order.
  for (let first = firstBlock; first < end; first += 32) {
    let leaf = tail;
    if (first < tailStart) {
      leaf = root;
      if (depth) {
        // One trie walk locates the parent of up to 32 consecutive leaves.
        if ((first & 1023) === 0) parent = a.wasm.vecLeaf(root, depth - 1, first >>> 5) >>> 0;
        leaf = view.getUint32(parent + ((first >>> 5) & 31) * 4, true);
      }
    }
    if (leaf !== spanEnd) {
      const length = spanEnd - spanStart;
      if (length) {
        output.set(new Uint8Array(source, spanStart, length), written);
        written += length;
      }
      spanStart = leaf + leafOffset;
      leafOffset = 0;
    }
    spanEnd = leaf + Math.min(32, end - first) * 8;
  }
  output.set(new Uint8Array(source, spanStart, spanEnd - spanStart), written);
}
