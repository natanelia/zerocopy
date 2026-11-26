import { initWorker } from '../dist/shared.js';
import { bboxXY } from '../dist/geometry.js';

import { querySpatialIndex, rebuildSpatialIndex } from '../dist/spatial.js';

let first, current, firstPrepared;
self.onmessage = async ({ data }) => {
  try {
    current = await initWorker(data.roots, { previous: current });
    first ??= current;
    firstPrepared ??= data.prepared;
    const read = (state, prepared) => {
      const row = state.rows.get('lane');
      const viewport = [-12, 0, -8, 3] as const;
      const rebuilt = rebuildSpatialIndex(data.base, state.changes, row.revision);
      return {
        row, bounds: bboxXY(state.geometry),
        candidates: querySpatialIndex(data.base, viewport, state.changes),
        rebuiltCandidates: querySpatialIndex(rebuilt, viewport),
        preparedCandidates: querySpatialIndex(prepared, viewport),
      };
    };
    self.postMessage({ first: read(first, firstPrepared), current: read(current, data.prepared) });
  } catch (error) { self.postMessage({ error: String(error) }); }
};
