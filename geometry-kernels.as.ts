// Read-only kernels. Results use instance-local globals, never arena scratch.
let minX: f64 = Infinity, minY: f64 = Infinity;
let maxX: f64 = -Infinity, maxY: f64 = -Infinity;
export function bboxMinX(): f64 { return minX; }
export function bboxMinY(): f64 { return minY; }
export function bboxMaxX(): f64 { return maxX; }
export function bboxMaxY(): f64 { return maxY; }
@inline
export function xyLeaf(root: u32, depth: u32, tail: u32, size: u32, index: u32): u32 {
  if (index >= ((size - 1) & ~31)) return tail;
  let node = root;
  for (let d = depth; d > 0; d--) node = load<u32>(node + ((index >> (d * 5)) & 31) * 4);
  return node;
}
// Independent extrema chains preserve all nonzero extrema. For signed-zero
// ties, recover the first zero in input order. Skip zero-free groups with SIMD.
function restoreZeroSigns(root: u32, depth: u32, tail: u32, size: u32): void {
  let need: u32 = <u32>(minX == 0 || maxX == 0) | (<u32>(minY == 0 || maxY == 0) << 1);
  if (!need) return;
  const zero = f64x2.splat(0);
  for (let base: u32 = 0; base < size; base += 32) {
    const p = xyLeaf(root, depth, tail, size, base), end = p + min(<u32>32, size - base) * 8;
    let q = p;
    while (q < end) {
      let groupEnd = min(q + 64, end);
      if (end - q >= 64) {
        const a = f64x2.eq(v128.load(q), zero), b = f64x2.eq(v128.load(q + 16), zero);
        const c = f64x2.eq(v128.load(q + 32), zero), d = f64x2.eq(v128.load(q + 48), zero);
        if (!(<u32>i64x2.bitmask(v128.or(v128.or(a, b), v128.or(c, d))) & need)) { q += 64; continue; }
      }
      for (; q < groupEnd; q += 16) {
        if (need & 1) {
          const x = load<f64>(q);
          if (x == 0) { if (minX == 0) minX = x; if (maxX == 0) maxX = x; need &= ~1; }
        }
        if (need & 2) {
          const y = load<f64>(q + 8);
          if (y == 0) { if (minY == 0) minY = y; if (maxY == 0) maxY = y; need &= ~2; }
        }
        if (!need) return;
      }
    }
  }
}
export function bboxXY(root: u32, depth: u32, tail: u32, size: u32): void {
  if (size & 1) unreachable();
  minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
  if (ASC_FEATURE_SIMD) {
    let l0 = f64x2.splat(Infinity), l1 = l0, l2 = l0, l3 = l0;
    let h0 = f64x2.splat(-Infinity), h1 = h0, h2 = h0, h3 = h0;
    for (let base: u32 = 0; base < size; base += 32) {
      const p = xyLeaf(root, depth, tail, size, base), end = p + min(<u32>32, size - base) * 8;
      let q = p;
      for (; end - q >= 64; q += 64) {
        const a = v128.load(q), b = v128.load(q + 16), c = v128.load(q + 32), d = v128.load(q + 48);
        l0 = f64x2.pmin(l0, a); h0 = f64x2.pmax(h0, a);
        l1 = f64x2.pmin(l1, b); h1 = f64x2.pmax(h1, b);
        l2 = f64x2.pmin(l2, c); h2 = f64x2.pmax(h2, c);
        l3 = f64x2.pmin(l3, d); h3 = f64x2.pmax(h3, d);
      }
      for (; q < end; q += 16) {
        const value = v128.load(q);
        l0 = f64x2.pmin(l0, value); h0 = f64x2.pmax(h0, value);
      }
    }
    const lower = f64x2.pmin(f64x2.pmin(l0, l1), f64x2.pmin(l2, l3));
    const upper = f64x2.pmax(f64x2.pmax(h0, h1), f64x2.pmax(h2, h3));
    minX = f64x2.extract_lane(lower, 0); minY = f64x2.extract_lane(lower, 1);
    maxX = f64x2.extract_lane(upper, 0); maxY = f64x2.extract_lane(upper, 1);
    restoreZeroSigns(root, depth, tail, size);
  } else {
    let lx: f64 = Infinity, ly: f64 = Infinity, hx: f64 = -Infinity, hy: f64 = -Infinity;
    for (let base: u32 = 0; base < size; base += 32) {
      const p = xyLeaf(root, depth, tail, size, base), end = p + min(<u32>32, size - base) * 8;
      for (let q = p; q < end; q += 16) {
        const x = load<f64>(q), y = load<f64>(q + 8);
        if (x < lx) lx = x; if (y < ly) ly = y;
        if (x > hx) hx = x; if (y > hy) hy = y;
      }
    }
    minX = lx; minY = ly; maxX = hx; maxY = hy;
  }
}
