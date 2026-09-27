import { SharedList } from './shared-list';
import { arenaOf } from './arena';
import { assertXY } from './geometry-runtime';
import { polygonKernel } from './polygon-runtime';
import type { BoundsXY } from './geometry';

declare const preparedPolygonBrand: unique symbol;
/** Opaque, realm-local metadata. Prepare again in a worker from its snapshots. */
export interface PreparedPolygonXY {
  readonly [preparedPolygonBrand]: true;
  readonly bounds: BoundsXY;
  readonly ringCount: number;
  readonly edgeCount: number;
}
interface Ring {
  readonly root: number; readonly depth: number; readonly tail: number;
  readonly size: number; readonly memory: WebAssembly.Memory;
}
const preparedData = new WeakMap<PreparedPolygonXY, readonly Ring[]>();

/**
 * Prepare one polygon: the exterior ring followed by any hole rings.
 * Rings are closed numeric snapshots with at least four x/y pairs. All polygon
 * coordinates must be finite. Validation and bounds require one scan; no
 * coordinate buffer is copied and no shared bytes are allocated or changed.
 * This does not check topology or construct a spatial index.
 */
export function preparePolygonXY(rings: readonly SharedList<'number'>[]): PreparedPolygonXY {
  if (!Array.isArray(rings) || !rings.length) throw new TypeError('Expected at least one polygon ring');
  const entries: Ring[] = [], bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  let edgeCount = 0;
  for (const ring of rings) {
    assertXY(ring);
    if (ring.size < 8) throw new RangeError('A ring requires at least four x/y pairs');
    if (ring.get(0) !== ring.get(ring.size - 2) || ring.get(1) !== ring.get(ring.size - 1)) throw new RangeError('Polygon rings must be closed');
    ring.forEach((value, index) => {
      if (!Number.isFinite(value)) throw new RangeError('Polygon coordinates must be finite');
      const axis = index & 1;
      if (value < bounds[axis]) bounds[axis] = value;
      if (value > bounds[axis + 2]) bounds[axis + 2] = value;
    });
    entries.push({ root: ring.root, depth: ring.depth, tail: ring.tail, size: ring.size, memory: arenaOf(ring).memory });
    edgeCount += ring.size / 2 - 1;
  }
  const result = Object.freeze({ bounds: Object.freeze(bounds), ringCount: entries.length, edgeCount }) as unknown as PreparedPolygonXY;
  preparedData.set(result, entries); return result;
}

/**
 * Return ascending zero-based point indices inside one prepared polygon.
 * Boundary points match unless ignoreBoundary is true. NaN/infinite query
 * coordinates do not match finite polygon bounds. Holes use even-odd parity.
 * Same-arena rings use batched read-only kernels. Different arenas use a
 * scalar point-by-value path, without copying either coordinate collection.
 */
export function pointsWithinPolygonXY(points: SharedList<'number'>, polygon: PreparedPolygonXY, options: { readonly ignoreBoundary?: boolean } = {}): Uint32Array {
  assertXY(points);
  const rings = preparedData.get(polygon);
  if (!rings) throw new TypeError('Expected a polygon from preparePolygonXY in this realm');
  if (!options || typeof options !== 'object' || (options.ignoreBoundary !== undefined && typeof options.ignoreBoundary !== 'boolean')) throw new TypeError('ignoreBoundary must be a boolean');
  const ignoreBoundary = options.ignoreBoundary === true;
  const memory = arenaOf(points).memory, kernel = polygonKernel(memory);
  const view = new DataView(memory.buffer), result: number[] = [];
  const [lx, ly, hx, hy] = polygon.bounds;
  for (let base = 0; base < points.size; base += 32) {
    const count = Math.min(16, (points.size - base) / 2);
    const p = kernel.xyLeaf(points.root, points.depth, points.tail, points.size, base) >>> 0;
    const candidates = kernel.boxMaskXY(p, count, lx, ly, hx, hy);
    if (!candidates) continue;
    let parity = 0, boundary = 0;
    for (const ring of rings) {
      const active = candidates & ~boundary;
      if (!active) break;
      if (ring.memory === memory) {
        const masks = kernel.ringMaskXY(p, count, active, ring.root, ring.depth, ring.tail, ring.size) >>> 0;
        parity ^= masks & 65535; boundary |= masks >>> 16;
      } else {
        const other = polygonKernel(ring.memory);
        for (let i = 0; i < count; i++) if (active & (1 << i)) {
          const classification = other.ringPointXY(ring.root, ring.depth, ring.tail, ring.size, view.getFloat64(p + i * 16, true), view.getFloat64(p + i * 16 + 8, true));
          if (classification === 2) boundary |= 1 << i;
          else parity ^= classification << i;
        }
      }
    }
    let matches = candidates & (ignoreBoundary ? parity & ~boundary : parity | boundary);
    while (matches) {
      const bit = matches & -matches, i = 31 - Math.clz32(bit);
      result.push(base / 2 + i); matches ^= bit;
    }
  }
  return Uint32Array.from(result);
}
