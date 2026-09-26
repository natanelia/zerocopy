// Interleaved x/y coordinates in an immutable numeric list. Each leaf and tail
// contains complete points. Kernels read only; no shared scratch is required.
function spanBox(p: u32, values: u32, minX: f64, minY: f64, maxX: f64, maxY: f64): u32 {
  let total: u32 = 0;
  if (ASC_FEATURE_SIMD) {
    const lower = f64x2.replace_lane(f64x2.splat(minX), 1, minY);
    const upper = f64x2.replace_lane(f64x2.splat(maxX), 1, maxY);
    for (let i: u32 = 0; i < values; i += 2) {
      const point = v128.load(p + i * 8);
      total += <u32>i64x2.all_true(v128.and(f64x2.ge(point, lower), f64x2.le(point, upper)));
    }
  } else {
    for (let i: u32 = 0; i < values; i += 2) {
      const x = load<f64>(p + i * 8), y = load<f64>(p + i * 8 + 8);
      total += <u32>(x >= minX) & <u32>(x <= maxX) & <u32>(y >= minY) & <u32>(y <= maxY);
    }
  }
  return total;
}
function treeBox(root: u32, depth: u32, values: u32, minX: f64, minY: f64, maxX: f64, maxY: f64): u32 {
  if (!depth) return spanBox(root, values, minX, minY, maxX, maxY);
  const capacity: u32 = 1 << (depth * 5);
  let total: u32 = 0, child: u32 = 0;
  while (values) {
    const take = min(values, capacity);
    total += treeBox(load<u32>(root + child * 4), depth - 1, take, minX, minY, maxX, maxY);
    values -= take; child++;
  }
  return total;
}
export function countPointsInBox(root: u32, depth: u32, tail: u32, size: u32, minX: f64, minY: f64, maxX: f64, maxY: f64): u32 {
  if (size & 1) unreachable();
  if (!size || minX > maxX || minY > maxY || isNaN(minX) || isNaN(minY) || isNaN(maxX) || isNaN(maxY)) return 0;
  const treeSize = (size - 1) & ~31;
  return (treeSize ? treeBox(root, depth, treeSize, minX, minY, maxX, maxY) : 0)
    + spanBox(tail, size - treeSize, minX, minY, maxX, maxY);
}
