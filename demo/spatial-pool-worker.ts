import type { SharedList, SharedMap } from '../dist/shared.js';
import { bboxXY, type BoundsXY } from '../dist/geometry.js';
import { querySpatialIndex, type SpatialChanges, type SpatialIndex } from '../dist/spatial.js';
import { defineTasks, serve } from '../dist/worker.js';

type Layer = { rows: SharedMap<'number'>; geometry: SharedList<'number'>; changes: SpatialChanges };
export const tasks = defineTasks<Layer>()({
  validate({ state }, { base, viewport }: { base: SpatialIndex; viewport: BoundsXY }) {
    return {
      revision: state.rows.get('lane'), bounds: bboxXY(state.geometry),
      visible: querySpatialIndex(base, viewport, state.changes),
    };
  },
});
await serve(tasks);
