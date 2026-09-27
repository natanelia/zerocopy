// Read-only kernels. No allocator, imported callbacks, or writes to arena memory.
// Results live in instance-local globals, never in the writer's shared scratch.
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

export function bboxXY(root: u32, depth: u32, tail: u32, size: u32): void {
  if (size & 1) unreachable();
  minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
  if (ASC_FEATURE_SIMD) {
    let lower = f64x2.splat(Infinity), upper = f64x2.splat(-Infinity);
    for (let base: u32 = 0; base < size; base += 32) {
      const p = xyLeaf(root, depth, tail, size, base);
      const end = p + min(<u32>32, size - base) * 8;
      for (let q = p; q < end; q += 16) {
        const value = v128.load(q);
        // pmin(a,b) is b < a ? b : a. These ordered operations ignore NaN
        // and retain the first signed zero, exactly like the scalar comparisons.
        lower = f64x2.pmin(lower, value);
        upper = f64x2.pmax(upper, value);
      }
    }
    minX = f64x2.extract_lane(lower, 0); minY = f64x2.extract_lane(lower, 1);
    maxX = f64x2.extract_lane(upper, 0); maxY = f64x2.extract_lane(upper, 1);
  } else {
    let lx: f64 = Infinity, ly: f64 = Infinity, hx: f64 = -Infinity, hy: f64 = -Infinity;
    for (let base: u32 = 0; base < size; base += 32) {
      const p = xyLeaf(root, depth, tail, size, base);
      const end = p + min(<u32>32, size - base) * 8;
      for (let q = p; q < end; q += 16) {
        const x = load<f64>(q), y = load<f64>(q + 8);
        if (x < lx) lx = x; if (y < ly) ly = y;
        if (x > hx) hx = x; if (y > hy) hy = y;
      }
    }
    minX = lx; minY = ly; maxX = hx; maxY = hy;
  }
}
