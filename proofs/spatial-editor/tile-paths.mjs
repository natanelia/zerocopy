import { lineStringViewXY } from '../../dist/geometry.js';

// The fixture's validated uint32 IDs are consecutive in record-batch order.
export const rowsPerBatch = 64;
export function tilePath(tile, id) {
  const slot = Number(id), batch = tile[Math.floor(slot / rowsPerBatch)];
  if (!batch || slot % rowsPerBatch >= batch.offsets.length - 1) return undefined;
  return lineStringViewXY(batch, slot % rowsPerBatch);
}

export function currentPaths(paths, tile, rows) {
  if (!tile) return paths;
  return { get(id) {
    // Row presence in this publication survives spatial-index rebuilds and pruning.
    if (!rows.has(id)) return undefined;
    return paths.get(id) ?? tilePath(tile, id);
  } };
}
