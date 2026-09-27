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
export function bboxXY(root: u32, depth: u32, tail: u32, size: u32): void {
  if (size & 1) unreachable();
  minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
  if (ASC_FEATURE_SIMD) {
    const lowInitial = f64x2.splat(Infinity), highInitial = f64x2.splat(-Infinity);
    let lower = lowInitial, upper = highInitial;
    for (let base: u32 = 0; base < size; base += 32) {
      const p = xyLeaf(root, depth, tail, size, base), take = min(<u32>32, size - base);
      if (take == 32) {
        // Four independent CONTIGUOUS groups, then a left-to-right reduction.
        // This retains the earliest equal extremum, including its zero sign.
        // NaN values cannot enter any accumulator because pmin/pmax select the
        // second operand only on a strict comparison. No repair scan is needed.
        let l0 = lowInitial, l1 = lowInitial, l2 = lowInitial, l3 = lowInitial;
        let h0 = highInitial, h1 = highInitial, h2 = highInitial, h3 = highInitial;
        for (let offset: u32 = 0; offset < 64; offset += 16) {
          const a = v128.load(p + offset), b = v128.load(p + offset + 64);
          const c = v128.load(p + offset + 128), d = v128.load(p + offset + 192);
          l0 = f64x2.pmin(l0, a); h0 = f64x2.pmax(h0, a);
          l1 = f64x2.pmin(l1, b); h1 = f64x2.pmax(h1, b);
          l2 = f64x2.pmin(l2, c); h2 = f64x2.pmax(h2, c);
          l3 = f64x2.pmin(l3, d); h3 = f64x2.pmax(h3, d);
        }
        lower = f64x2.pmin(lower, f64x2.pmin(f64x2.pmin(l0, l1), f64x2.pmin(l2, l3)));
        upper = f64x2.pmax(upper, f64x2.pmax(f64x2.pmax(h0, h1), f64x2.pmax(h2, h3)));
      } else {
        for (let q = p, end = p + take * 8; q < end; q += 16) {
          const value = v128.load(q);
          lower = f64x2.pmin(lower, value); upper = f64x2.pmax(upper, value);
        }
      }
    }
    minX = f64x2.extract_lane(lower, 0); minY = f64x2.extract_lane(lower, 1);
    maxX = f64x2.extract_lane(upper, 0); maxY = f64x2.extract_lane(upper, 1);
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
