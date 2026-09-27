import { xyLeaf } from './geometry-kernels.as';
let farthestDistance: f64 = 0;
export function getFarthestDistance(): f64 { return farthestDistance; }
export function finiteXY(root: u32, depth: u32, tail: u32, size: u32): bool {
  if (size & 1) return false;
  for (let base: u32 = 0; base < size; base += 32) {
    const p = xyLeaf(root, depth, tail, size, base), end = p + min(<u32>32, size - base) * 8;
    for (let q = p; q < end; q += 16) {
      if (ASC_FEATURE_SIMD) {
        if (!i64x2.all_true(f64x2.le(f64x2.abs(v128.load(q)), f64x2.splat(1.7976931348623157e308)))) return false;
      } else if (!isFinite(load<f64>(q)) || !isFinite(load<f64>(q + 8))) return false;
    }
  }
  return true;
}
@inline
function squaredDistance(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64): f64 {
  let x = ax, y = ay;
  const dx = bx - ax, dy = by - ay;
  if (dx != 0 || dy != 0) {
    const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = bx; y = by; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  const vx = px - x, vy = py - y;
  return vx * vx + vy * vy;
}
export function farthestXY(root: u32, depth: u32, tail: u32, size: u32, first: u32, last: u32, threshold: f64): i32 {
  if ((size & 1) || first >= size / 2 || last >= size / 2 || first > last) unreachable();
  const ap = xyLeaf(root, depth, tail, size, first * 2) + (first & 15) * 16;
  const bp = xyLeaf(root, depth, tail, size, last * 2) + (last & 15) * 16;
  const ax = load<f64>(ap), ay = load<f64>(ap + 8), bx = load<f64>(bp), by = load<f64>(bp + 8);
  let best = threshold, index: i32 = -1, at = first + 1;
  if (ASC_FEATURE_SIMD) {
    const aX = f64x2.splat(ax), aY = f64x2.splat(ay), bX = f64x2.splat(bx), bY = f64x2.splat(by);
    const dx = f64x2.splat(bx - ax), dy = f64x2.splat(by - ay);
    const denominator = f64x2.add(f64x2.mul(dx, dx), f64x2.mul(dy, dy));
    const zero = f64x2.splat(0), one = f64x2.splat(1), step = i64x2.splat(2);
    let maxima = f64x2.splat(threshold), indices = i64x2.splat(-1);
    while (at < last) {
      const end = min(last, (at | 15) + 1), leaf = xyLeaf(root, depth, tail, size, at * 2);
      let current = i64x2.replace_lane(i64x2.splat(<i64>at), 1, <i64>at + 1);
      for (; at + 1 < end; at += 2) {
        const p = leaf + (at & 15) * 16, a = v128.load(p), b = v128.load(p + 16);
        const px = v128.shuffle<f64>(a, b, 0, 2), py = v128.shuffle<f64>(a, b, 1, 3);
        const t = f64x2.div(f64x2.add(f64x2.mul(f64x2.sub(px, aX), dx), f64x2.mul(f64x2.sub(py, aY), dy)), denominator);
        const positive = f64x2.gt(t, zero), above = f64x2.gt(t, one);
        const x = v128.bitselect(bX, v128.bitselect(f64x2.add(aX, f64x2.mul(dx, t)), aX, positive), above);
        const y = v128.bitselect(bY, v128.bitselect(f64x2.add(aY, f64x2.mul(dy, t)), aY, positive), above);
        const vx = f64x2.sub(px, x), vy = f64x2.sub(py, y);
        const distances = f64x2.add(f64x2.mul(vx, vx), f64x2.mul(vy, vy));
        const better = f64x2.gt(distances, maxima);
        maxima = v128.bitselect(distances, maxima, better);
        indices = v128.bitselect(current, indices, better);
        current = i64x2.add(current, step);
      }
      if (at < end) {
        const p = leaf + (at & 15) * 16, d = squaredDistance(load<f64>(p), load<f64>(p + 8), ax, ay, bx, by);
        if (d > best) { best = d; index = <i32>at; } at++;
      }
    }
    // Reduce only once. Equal distances choose the earliest original index,
    // including ties with the scalar odd-element path. NaN never wins.
    const d0 = f64x2.extract_lane(maxima, 0), d1 = f64x2.extract_lane(maxima, 1);
    const i0 = <i32>i64x2.extract_lane(indices, 0), i1 = <i32>i64x2.extract_lane(indices, 1);
    if (i0 >= 0 && (d0 > best || (d0 == best && (index < 0 || i0 < index)))) { best = d0; index = i0; }
    if (i1 >= 0 && (d1 > best || (d1 == best && (index < 0 || i1 < index)))) { best = d1; index = i1; }
  } else {
    while (at < last) {
      const end = min(last, (at | 15) + 1), leaf = xyLeaf(root, depth, tail, size, at * 2);
      for (; at < end; at++) {
        const p = leaf + (at & 15) * 16, d = squaredDistance(load<f64>(p), load<f64>(p + 8), ax, ay, bx, by);
        if (d > best) { best = d; index = <i32>at; }
      }
    }
  }
  farthestDistance = best; return index;
}
