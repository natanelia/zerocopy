import { initWorker } from '../dist/shared.js';
import { bboxXY } from '../dist/geometry.js';

import { querySpatialIndex, rebuildSpatialIndex } from '../dist/spatial.js';

let first, current;
self.onmessage = async ({ data }) => {
  try {
    current = await initWorker(data.roots, { previous: current });
    first ??= current;
    const read = state => {
      const row = state.rows.get('lane');
      const viewport = [-12, 0, -8, 3] as const;
      const rebuilt = rebuildSpatialIndex(data.base, state.changes, row.revision);
      return {
        row, bounds: bboxXY(state.geometry),
        candidates: querySpatialIndex(data.base, viewport, state.changes),
        rebuiltCandidates: querySpatialIndex(rebuilt, viewport),
      };
    };
    self.postMessage({ first: read(first), current: read(current) });
  } catch (error) { self.postMessage({ error: String(error) }); }
};
