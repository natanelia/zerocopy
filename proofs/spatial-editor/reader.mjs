import { connectSharedSession } from '../../dist/worker.js';
import { initWorker } from '../../dist/shared.js';
import { bboxXY } from '../../dist/geometry.js';
import { rebuildSpatialIndex } from '../../dist/spatial.js';
import { bounds } from './workload.mjs';
import { baseFor, viewportFor } from './spatial.mjs';
import { currentPaths } from './tile-paths.mjs';

let session, snapshot, base, native, tile, first, held;
self.onmessage = async ({ data }) => {
  if (data.protocol === 'zerocopy/session') return;
  try {
    if (data.connect) {
      session = await connectSharedSession({ channel: 'editor' });
      self.postMessage({ connected: true });
      return;
    }
    if (data.sequence !== undefined) {
      const requested = await session.snapshotAt(data.sequence);
      if (!requested) throw new Error('Validation missed its requested publication');
      snapshot = requested;
    }
    if (data.release) {
      const { path, row, revision, request } = held;
      const b = snapshot ? bboxXY(path) : bounds(path);
      self.postMessage({ revision, request, bounds: b, rowRevision: row.revision });
      held = undefined;
      return;
    }
    if (data.base) base = data.base;
    if (data.tile) {
      if (tile || !(data.tile.ids.buffer instanceof SharedArrayBuffer) ||
          !data.tile.batches.every(p => p.coordinates.buffer instanceof SharedArrayBuffer &&
          p.offsets.buffer instanceof SharedArrayBuffer)) throw new Error('Expected one shared tile attachment');
      tile = data.tile;
    }
    if (data.payload) snapshot = await initWorker(data.payload, { previous: snapshot });
    if (data.initial) native = data.initial;
    // The rebuild's retained edits precede the command in this same frame.
    if (data.rebuiltChanges) native.changes = data.rebuiltChanges;
    if (data.patch) {
      const { row, path, axis, coordinate, id, change } = data.patch;
      if (row) {
        let geometry = path;
        if (axis !== undefined) { geometry = native.paths.get(id).slice(); geometry[axis] = coordinate; }
        native.rows.set(id, row);
        native.paths.set(id, geometry);
      }
      else { native.rows.delete(id); native.paths.delete(id); }
      native.changes.set(id, change);
    }
    const { rows, paths, changes } = snapshot ?? native;
    const geometry = currentPaths(paths, tile, rows);
    if (data.hold) {
      held = { path: geometry.get(data.id), row: rows.get(data.id), revision: data.revision, request: data.request };
      self.postMessage({ held: true });
      return;
    }
    if (data.rebuild) {
      const started = performance.now();
      const replacement = snapshot && data.rebuild === 'packed'
        ? rebuildSpatialIndex(base, changes, data.revision)
        : baseFor(!!snapshot, rows, data.revision);
      self.postMessage({ base: replacement, rebuildMs: performance.now() - started });
      return;
    }
    first ??= { path: geometry.get('5'), row: rows.get('5') };
    if (data.checkId !== undefined && (geometry.get(data.checkId) !== undefined) !== rows.has(data.checkId)) {
      throw new Error('Edited path and row disagree on presence');
    }
    const getBounds = snapshot ? bboxXY : bounds;
    const visible = viewportFor(!!snapshot, base, changes, data.box);
    for (const id of visible) {
      const b = getBounds(geometry.get(id));
      if (String(b) !== String(rows.get(id).bounds)) throw new Error('Geometry/metadata revision mismatch');
    }
    if (String(getBounds(first.path)) !== String(first.row.bounds)) throw new Error('Retained geometry changed');
    self.postMessage({ visible, request: data.request, revision: data.revision, generation: base.revision });
  } catch (e) { self.postMessage({ error: String(e.stack ?? e) }); }
};
