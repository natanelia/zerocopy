// Immutable index sidecar. Numeric feature IDs remain stable across rebuilds.
import Flatbush from 'flatbush';
import { buildSpatialIndex, querySpatialIndex } from '../../dist/spatial.js';

// The copy control uses Flatbush directly. The shared arm uses the built package.
export function baseFor(shared, rows, revision) {
  if (!shared) return buildBase(rows, revision);
  return buildSpatialIndex(Array.from(rows.values(), r => ({ id: Number(r.id), bounds: r.bounds })), revision);
}

export function viewportFor(shared, base, changes, box) {
  return shared ? querySpatialIndex(base, box, changes).map(String) : candidates(base, changes, box);
}

export function buildBase(rows, revision) {
  const ids = new Uint32Array(new SharedArrayBuffer(rows.size * 4));
  if (!rows.size) return { revision, ids, buffer: null };
  const index = new Flatbush(rows.size, 16, Float64Array, SharedArrayBuffer);
  for (const row of rows.values()) ids[index.add(...row.bounds)] = Number(row.id);
  index.finish();
  return { revision, ids, buffer: index.data };
}

const indexes = new WeakMap();
export function candidates(base, changes, box) {
  const result = [];
  if (base.buffer) {
    let index = indexes.get(base);
    if (!index) indexes.set(base, index = Flatbush.from(base.buffer));
    for (const slot of index.search(...box)) {
      const id = String(base.ids[slot]);
      if (!changes.has(id)) result.push(id);
    }
  }
  for (const [id, change] of changes.entries()) {
    const b = change.bounds;
    if (b && b[0] <= box[2] && b[1] <= box[3] && b[2] >= box[0] && b[3] >= box[1]) result.push(id);
  }
  return result.sort((a, b) => Number(a) - Number(b));
}
