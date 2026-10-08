// Read-only bounds. Result globals belong to this module instance, not memory.
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
  let lx: f64 = Infinity, ly: f64 = Infinity;
  let hx: f64 = -Infinity, hy: f64 = -Infinity;
  let parent: u32 = root;
  for (let base: u32 = 0; base < size; base += 32) {
    let p: u32;
    if (base >= ((size - 1) & ~31)) p = tail;
    else if (depth == 0) p = root;
    else {
      // A parent holds 32 leaves (1024 values); refresh only at its boundary.
      if ((base & 1023) == 0) {
        parent = root;
        for (let d = depth; d > 1; d--) parent = load<u32>(parent + ((base >> (d * 5)) & 31) * 4);
      }
      p = load<u32>(parent + ((base >> 5) & 31) * 4);
    }
    const end = p + min(<u32>32, size - base) * 8;
    for (let q = p; q < end; q += 16) {
      const x = load<f64>(q), y = load<f64>(q + 8);
      // Strict comparisons ignore NaN axes and retain the first signed zero.
      if (x < lx) lx = x;
      if (y < ly) ly = y;
      if (x > hx) hx = x;
      if (y > hy) hy = y;
    }
  }
  minX = lx; minY = ly; maxX = hx; maxY = hy;
}
