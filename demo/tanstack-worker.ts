import { initWorker } from '../dist/shared.js';
import { bboxXY, pathIntersectsBoxXY } from '../dist/geometry.js';

import { diffSpatialJoin, diffSpatialViewport, querySpatialIndex, querySpatialJoin, rebuildSpatialIndex } from '../dist/spatial.js';

let first, current, firstPrepared;
self.onmessage = async ({ data }) => {
  try {
    current = await initWorker(data.roots, { previous: current });
    first ??= current;
    firstPrepared ??= data.prepared;
    // Both generations have overlapping bounds here. Only the edited segment crosses it.
    const narrow = [0, 2.5, 0, 2.75] as const;
    const frame = (state, prepared) => ({ left: prepared, right: data.roadIndex,
      filter: () => pathIntersectsBoxXY(state.geometry, narrow) });
    const read = (state, prepared) => {
      const row = state.rows.get('lane');
      const viewport = [-12, 0, -8, 3] as const;
      const rebuilt = rebuildSpatialIndex(data.base, state.changes, row.revision);
      return {
        row, bounds: bboxXY(state.geometry),
        candidates: querySpatialIndex(data.base, viewport, state.changes),
        rebuiltCandidates: querySpatialIndex(rebuilt, viewport),
        preparedCandidates: querySpatialIndex(prepared, viewport),
        narrowCandidates: querySpatialIndex(prepared, narrow),
        intersectsNarrow: pathIntersectsBoxXY(state.geometry, narrow),
        narrowPairs: querySpatialJoin(prepared, data.roadIndex, frame(state, prepared)),
      };
    };
    const edits = [];
    for (const { before, after } of current.rows.changesSince(first.rows)) {
      edits.push({ id: (after ?? before).handle, before: before?.bounds ?? null, after: after?.bounds ?? null });
    }
    const delta = diffSpatialJoin(frame(first, firstPrepared), frame(current, data.prepared), { left: edits });
    const viewportDelta = diffSpatialViewport(narrow, edits, (_, phase) =>
      pathIntersectsBoxXY(phase === 'before' ? first.geometry : current.geometry, narrow));
    self.postMessage({ first: read(first, firstPrepared), current: read(current, data.prepared), delta, viewportDelta });
  } catch (error) { self.postMessage({ error: String(error) }); }
};
