// Interleaved x/y coordinates in an immutable numeric list. Kernels read only.
// Deinterleave two points in registers, then keep counts in vector lanes.
// This avoids a vector-to-scalar reduction for every individual point.
function spanBox(p: u32, values: u32, minX: f64, minY: f64, maxX: f64, maxY: f64): u32 {
  let total: u32 = 0, i: u32 = 0;
  if (ASC_FEATURE_SIMD) {
    const lowerX = f64x2.splat(minX), upperX = f64x2.splat(maxX);
    const lowerY = f64x2.splat(minY), upperY = f64x2.splat(maxY);
    let sums = i64x2.splat(0);
    while (values - i >= 4) {
      const first = v128.load(p + i * 8), second = v128.load(p + i * 8 + 16);
      const x = v128.shuffle<f64>(first, second, 0, 2);
      const y = v128.shuffle<f64>(first, second, 1, 3);
      const xMatch = v128.and(f64x2.ge(x, lowerX), f64x2.le(x, upperX));
      const yMatch = v128.and(f64x2.ge(y, lowerY), f64x2.le(y, upperY));
      sums = i64x2.sub(sums, v128.and(xMatch, yMatch));
      i += 4;
    }
    total = <u32>i64x2.extract_lane(sums, 0) + <u32>i64x2.extract_lane(sums, 1);
  }
  // An odd number of points leaves one complete x/y pair, never an overread.
  for (; i < values; i += 2) {
    const x = load<f64>(p + i * 8), y = load<f64>(p + i * 8 + 8);
    total += <u32>(x >= minX) & <u32>(x <= maxX) & <u32>(y >= minY) & <u32>(y <= maxY);
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
