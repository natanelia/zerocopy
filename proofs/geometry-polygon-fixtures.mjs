import { random } from './geometry-fixtures.mjs';
export function polygonCase(seed, vertices = 5 + seed % 53, points = 33) {
  const rng = random(seed), scale = 2 ** ((seed % 21) - 10), cx = (rng() - .5) * 1000, cy = (rng() - .5) * 1000;
  const makeRing = (radius, star) => {
    const values = [];
    for (let i = 0; i < vertices; i++) {
      const angle = i * 2 * Math.PI / vertices, r = radius * (star && i % 2 ? .55 : 1);
      values.push(cx + Math.cos(angle) * r * scale, cy + Math.sin(angle) * r * scale);
    }
    values.push(values[0], values[1]); return values;
  };
  const outer = makeRing(100, seed % 2), rings = [outer];
  if (seed % 3 === 0) rings.push(makeRing(20, false));
  const values = [];
  for (let i = 0; i < points; i++) values.push(cx + (rng() - .5) * 260 * scale, cy + (rng() - .5) * 260 * scale);
  for (const ring of rings) for (let i = 0; i < ring.length - 2; i += 2) {
    values.push(ring[i], ring[i + 1]);
    const x = (ring[i] + ring[i + 2]) / 2, y = (ring[i + 1] + ring[i + 3]) / 2;
    values.push(x, y, x + Number.EPSILON * (Math.abs(x) || 1), y, x, y - Number.EPSILON * (Math.abs(y) || 1));
  }
  return { rings, values };
}
// Independent exact integer predicate: half-open crossings and BigInt cross
// products, with no use of the production robust-predicates implementation.
export function integerMembership(x, y, rings, ignoreBoundary) {
  let parity = false;
  for (const ring of rings) for (let i = 0; i + 3 < ring.length; i += 2) {
    const ax = ring[i], ay = ring[i + 1], bx = ring[i + 2], by = ring[i + 3];
    const det = (BigInt(bx) - BigInt(ax)) * (BigInt(y) - BigInt(ay)) - (BigInt(by) - BigInt(ay)) * (BigInt(x) - BigInt(ax));
    if (det === 0n && x >= Math.min(ax,bx) && x <= Math.max(ax,bx) && y >= Math.min(ay,by) && y <= Math.max(ay,by)) return !ignoreBoundary;
    if ((ay > y) !== (by > y) && ((det > 0n) === (by > ay))) parity = !parity;
  }
  return parity;
}
