import { getLineStringById } from '../../dist/spatial.js';

export function currentPaths(paths, tile, rows) {
  if (!tile) return paths;
  return { get(id) {
    // Row presence in this publication survives spatial-index rebuilds and pruning.
    if (!rows.has(id)) return undefined;
    return paths.get(id) ?? getLineStringById(tile, Number(id));
  } };
}
