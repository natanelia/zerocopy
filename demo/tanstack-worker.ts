import { initWorker } from '../dist/shared.js';
import { bboxXY } from '../dist/geometry.js';

import { querySpatialIndex } from '../dist/spatial.js';

let first, current;
self.onmessage = async ({ data }) => {
  try {
    current = await initWorker(data.roots, { previous: current });
    first ??= current;
    const read = state => ({
      row: state.rows.get('lane'),
      bounds: bboxXY(state.geometry),
      candidates: querySpatialIndex(data.base, [-12, 0, -8, 3], state.changes),
    });
    self.postMessage({ first: read(first), current: read(current) });
  } catch (error) { self.postMessage({ error: String(error) }); }
};
