import { xyLeaf } from './geometry-kernels';
@external('predicates', 'orient2d')
declare function orient2d(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64): f64;
export { xyLeaf };

// Match the translated-coordinate orientation used by Turf's predicate.
// The filter is conservative; uncertain, subnormal, and overflowing products
// use robust-predicates. There is no fixed coordinate epsilon.
@inline
function orientation(u1: f64, v1: f64, u2: f64, v2: f64): f64 {
  const left = u2 * v1, right = u1 * v2, det = left - right;
  const sum = abs(left) + abs(right);
  if (sum > 1e-280 && sum < 1e280 && abs(det) > sum * 1e-15) return det;
  return orient2d(u1, u2, v1, v2, 0, 0);
}
// 0: no crossing, 1: crossing, 2: boundary. Uses a half-open vertex rule.
@inline
function edgePoint(ax: f64, ay: f64, bx: f64, by: f64, x: f64, y: f64): u32 {
  const u1 = ax - x, v1 = ay - y, u2 = bx - x, v2 = by - y;
  if (v1 == 0 && v2 == 0) return ((u2 <= 0 && u1 >= 0) || (u1 <= 0 && u2 >= 0)) ? 2 : 0;
  if (!((v2 >= 0 && v1 <= 0) || (v2 <= 0 && v1 >= 0))) return 0;
  const det = orientation(u1, v1, u2, v2);
  if (det == 0) return 2;
  return <u32>((det > 0 && v2 > 0 && v1 <= 0) || (det < 0 && v2 <= 0 && v1 > 0));
}

// The low 16 bits are crossings; the high 16 bits are boundary matches.
function edgeMask(p: u32, count: u32, active: u32, ax: f64, ay: f64, bx: f64, by: f64): u32 {
  let crossings: u32 = 0, boundary: u32 = 0, i: u32 = 0;
  if (ASC_FEATURE_SIMD) {
    const zero = f64x2.splat(0), avx = f64x2.splat(ax), avy = f64x2.splat(ay), bvx = f64x2.splat(bx), bvy = f64x2.splat(by);
    for (; i + 1 < count; i += 2) {
      const enabled = (active >> i) & 3;
      if (!enabled) continue;
      const a = v128.load(p + i * 16), b = v128.load(p + i * 16 + 16);
      const x = v128.shuffle<f64>(a, b, 0, 2), y = v128.shuffle<f64>(a, b, 1, 3);
      const u1 = f64x2.sub(avx, x), v1 = f64x2.sub(avy, y), u2 = f64x2.sub(bvx, x), v2 = f64x2.sub(bvy, y);
      const horizontal = v128.and(f64x2.eq(v1, zero), f64x2.eq(v2, zero));
      const horizontalHit = v128.and(horizontal, v128.or(v128.and(f64x2.le(u2, zero), f64x2.ge(u1, zero)), v128.and(f64x2.le(u1, zero), f64x2.ge(u2, zero))));
      const eligible = v128.andnot(v128.or(v128.and(f64x2.ge(v2, zero), f64x2.le(v1, zero)), v128.and(f64x2.le(v2, zero), f64x2.ge(v1, zero))), horizontal);
      const eligibleBits = <u32>i64x2.bitmask(eligible) & enabled;
      let bound = <u32>i64x2.bitmask(horizontalHit) & enabled;
      let cross: u32 = 0;
      if (eligibleBits) {
        const left = f64x2.mul(u2, v1), right = f64x2.mul(u1, v2), det = f64x2.sub(left, right);
        const sum = f64x2.add(f64x2.abs(left), f64x2.abs(right));
        const safe = v128.and(v128.and(f64x2.gt(sum, f64x2.splat(1e-280)), f64x2.lt(sum, f64x2.splat(1e280))), f64x2.gt(f64x2.abs(det), f64x2.mul(sum, f64x2.splat(1e-15))));
        const positive = v128.and(f64x2.gt(det, zero), v128.and(f64x2.gt(v2, zero), f64x2.le(v1, zero)));
        const negative = v128.and(f64x2.lt(det, zero), v128.and(f64x2.le(v2, zero), f64x2.gt(v1, zero)));
        cross = <u32>i64x2.bitmask(v128.or(positive, negative)) & eligibleBits;
        const uncertain = eligibleBits & ~<u32>i64x2.bitmask(safe);
        if (uncertain & 1) {
          const result = edgePoint(ax, ay, bx, by, f64x2.extract_lane(x, 0), f64x2.extract_lane(y, 0));
          cross = (cross & ~1) | <u32>(result == 1); bound |= <u32>(result == 2);
        }
        if (uncertain & 2) {
          const result = edgePoint(ax, ay, bx, by, f64x2.extract_lane(x, 1), f64x2.extract_lane(y, 1));
          cross = (cross & ~2) | (<u32>(result == 1) << 1); bound |= <u32>(result == 2) << 1;
        }
      }
      crossings |= cross << i; boundary |= bound << i;
    }
  }
  for (; i < count; i++) if (active & (1 << i)) {
    const result = edgePoint(ax, ay, bx, by, load<f64>(p + i * 16), load<f64>(p + i * 16 + 8));
    crossings |= <u32>(result == 1) << i; boundary |= <u32>(result == 2) << i;
  }
  return crossings | (boundary << 16);
}

export function boxMaskXY(p: u32, count: u32, lx: f64, ly: f64, hx: f64, hy: f64): u32 {
  if (count > 16) unreachable();
  let mask: u32 = 0;
  for (let i: u32 = 0; i < count; i++) {
    const x = load<f64>(p + i * 16), y = load<f64>(p + i * 16 + 8);
    mask |= <u32>(x >= lx && x <= hx && y >= ly && y <= hy) << i;
  }
  return mask;
}

export function ringMaskXY(p: u32, count: u32, active: u32, root: u32, depth: u32, tail: u32, size: u32): u32 {
  if (count > 16 || size < 8 || (size & 1)) unreachable();
  let crossings: u32 = 0, boundary: u32 = 0;
  let node = xyLeaf(root, depth, tail, size, 0);
  let ax = load<f64>(node), ay = load<f64>(node + 8);
  for (let at: u32 = 2; at < size; at += 2) {
    if (!active) break;
    if (!(at & 31)) node = xyLeaf(root, depth, tail, size, at);
    const bx = load<f64>(node + (at & 31) * 8), by = load<f64>(node + (at & 31) * 8 + 8);
    const masks = edgeMask(p, count, active, ax, ay, bx, by);
    crossings ^= masks & 65535; boundary |= masks >> 16; active &= ~boundary;
    ax = bx; ay = by;
  }
  return crossings | (boundary << 16);
}

// Different arenas need no copy or multi-memory feature. Pass one query point
// by value and scan the ring in its own arena. This path is deliberately scalar.
export function ringPointXY(root: u32, depth: u32, tail: u32, size: u32, x: f64, y: f64): u32 {
  if (size < 8 || (size & 1)) unreachable();
  let node = xyLeaf(root, depth, tail, size, 0), parity: u32 = 0;
  let ax = load<f64>(node), ay = load<f64>(node + 8);
  for (let at: u32 = 2; at < size; at += 2) {
    if (!(at & 31)) node = xyLeaf(root, depth, tail, size, at);
    const bx = load<f64>(node + (at & 31) * 8), by = load<f64>(node + (at & 31) * 8 + 8);
    const result = edgePoint(ax, ay, bx, by, x, y);
    if (result == 2) return 2;
    parity ^= result; ax = bx; ay = by;
  }
  return parity;
}
