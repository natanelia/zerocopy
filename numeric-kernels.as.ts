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
  const treeSize = (size - 1) & ~31;
  return (treeSize ? treeCount(root, depth, treeSize, lo, hi) : 0) + spanCount(tail, size - treeSize, lo, hi);
}
