/** Bounds in the input coordinate system, ordered as [minX, minY, maxX, maxY]. */
export type BoundsXY = readonly [number, number, number, number];

/** Spatial indexes use complete finite vertices. Geometry bounds retain per-axis IEEE comparisons. */
export function packedBoundsXY(xy: Float64Array, start: number, end: number, finiteVertices: boolean): BoundsXY {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = start; i < end; i += 2) {
    const x = xy[i], y = xy[i + 1];
    if (finiteVertices && !(Number.isFinite(x) && Number.isFinite(y))) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

export function checkBounds(box: BoundsXY, finite: boolean): void {
  if (!Array.isArray(box) || box.length !== 4) throw new TypeError('Expected four XY bounds');
  for (const value of box) {
    if (typeof value !== 'number') throw new TypeError('Expected numeric XY bounds');
    if (Number.isNaN(value) || (finite && !Number.isFinite(value))) throw new RangeError('Invalid XY bounds');
  }
  if (box[0] > box[2] || box[1] > box[3]) throw new RangeError('Reversed XY bounds');
}
