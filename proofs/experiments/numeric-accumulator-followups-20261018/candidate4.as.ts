// Read-only kernels for SharedList<'number'>. The snapshot owns all byte spans.
// No allocator, shared scratch writes, callbacks, or temporary output buffers.
function spanCount(p: u32, count: u32, lo: f64, hi: f64): u32 {
  let i: u32 = 0, total: u32 = 0;
  if (ASC_FEATURE_SIMD) {
    const lower = f64x2.splat(lo), upper = f64x2.splat(hi);
    let sums = i64x2.splat(0);
    // A snapshot can expose an odd tail beside a writer's unpublished bytes.
    // Load only complete pairs inside the snapshot's visible span.
    while (count - i >= 2) {
      const values = v128.load(p + i * 8);
      sums = i64x2.sub(sums, v128.and(f64x2.ge(values, lower), f64x2.le(values, upper)));
      i += 2;
    }
    total = <u32>i64x2.extract_lane(sums, 0) + <u32>i64x2.extract_lane(sums, 1);
  }
  for (; i < count; i++) {
    const value = load<f64>(p + i * 8);
    total += <u32>(value >= lo) & <u32>(value <= hi);
  }
  return total;
}
function treeCount(root: u32, depth: u32, count: u32, lo: f64, hi: f64): u32 {
  if (!depth) return spanCount(root, count, lo, hi);
  if (ASC_FEATURE_SIMD && depth == 1) {
    // Tree leaves are complete. Keep the vector count across each group of
    // sibling leaves, with no recursive call or lane reduction per leaf.
    const lower = f64x2.splat(lo), upper = f64x2.splat(hi);
    const children = count >> 5;
    // Independent sums shorten the dependency chain across complete leaves.
    let sums0 = i64x2.splat(0);
    let sums1 = i64x2.splat(0);
    let sums2 = i64x2.splat(0);
    let sums3 = i64x2.splat(0);
    for (let child: u32 = 0; child < children; child++) {
      const p = load<u32>(root + child * 4);
      for (let i: u32 = 0; i < 32; i += 8) {
        const values0 = v128.load(p + i * 8);
        const values1 = v128.load(p + i * 8 + 16);
        const values2 = v128.load(p + i * 8 + 32);
        const values3 = v128.load(p + i * 8 + 48);
        sums0 = i64x2.sub(sums0, v128.and(f64x2.ge(values0, lower), f64x2.le(values0, upper)));
        sums1 = i64x2.sub(sums1, v128.and(f64x2.ge(values1, lower), f64x2.le(values1, upper)));
        sums2 = i64x2.sub(sums2, v128.and(f64x2.ge(values2, lower), f64x2.le(values2, upper)));
        sums3 = i64x2.sub(sums3, v128.and(f64x2.ge(values3, lower), f64x2.le(values3, upper)));
      }
    }
    const sums = i64x2.add(i64x2.add(sums0, sums1), i64x2.add(sums2, sums3));
    return <u32>i64x2.extract_lane(sums, 0) + <u32>i64x2.extract_lane(sums, 1);
  }
  const capacity: u32 = 1 << (depth * 5);
  let total: u32 = 0, child: u32 = 0;
  while (count) {
    const take = min(count, capacity);
    total += treeCount(load<u32>(root + child * 4), depth - 1, take, lo, hi);
    count -= take; child++;
  }
  return total;
}
export function countInRange(root: u32, depth: u32, tail: u32, size: u32, lo: f64, hi: f64): u32 {
  if (!size || lo > hi || isNaN(lo) || isNaN(hi)) return 0;
  // One or two published values are faster as direct scalar loads even in a SIMD module.
  // Keep the original grouped-tree and tail dispatch for all larger snapshots.
  if (ASC_FEATURE_SIMD && size <= 2) {
    const a = load<f64>(tail);
    let hits: u32 = <u32>(a >= lo) & <u32>(a <= hi);
    if (size == 2) {
      const b = load<f64>(tail + 8);
      hits += <u32>(b >= lo) & <u32>(b <= hi);
    }
    return hits;
  }
  const treeSize = (size - 1) & ~31;
  // A depth-zero root is one leaf. Avoid the larger recursive SIMD helper
  // on 33–64 value lists; the scalar build keeps its original call path.
  return (treeSize ? (ASC_FEATURE_SIMD && !depth
    ? spanCount(root, treeSize, lo, hi)
    : treeCount(root, depth, treeSize, lo, hi)) : 0) + spanCount(tail, size - treeSize, lo, hi);
}
export { countPointsInBox } from './numeric-spatial.as';
