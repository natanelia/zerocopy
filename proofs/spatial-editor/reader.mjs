import { connectSharedSession } from '../../dist/worker.js';
import { initWorker } from '../../dist/shared.js';
import { bboxXY } from '../../dist/geometry.js';
import { bounds } from './workload.mjs';
import { baseFor, viewportFor } from './spatial.mjs';

let session, snapshot, base, native, first, held;
self.onmessage = async ({ data }) => {
  if (data.protocol === 'zerocopy/session') return;
  try {
    if (data.connect) {
      session = await connectSharedSession({ channel: 'editor' });
      self.postMessage({ connected: true });
      return;
    }
    if (data.sequence !== undefined) {
      if (session.version < data.sequence) {
        await new Promise(resolve => {
          const unsubscribe = session.subscribe((_, version) => {
            if (version >= data.sequence) { unsubscribe(); resolve(); }
          });
        });
      }
      if (session.version !== data.sequence) throw new Error('Validation missed its requested publication');
      snapshot = session.current;
    }
    if (data.release) {
      const { path, row, revision, request } = held;
      const b = snapshot ? bboxXY(path) : bounds(path);
      self.postMessage({ revision, request, bounds: b, rowRevision: row.revision });
      held = undefined;
      return;
    }
    if (data.base) base = data.base;
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
    // Index construction uses exactly the rows in this immutable input revision.
    if (data.hold) {
      held = { path: paths.get(data.id), row: rows.get(data.id), revision: data.revision, request: data.request };
      self.postMessage({ held: true });
      return;
    }
    if (data.rebuild) {
      self.postMessage({ base: baseFor(!!snapshot, rows, data.revision) });
      return;
    }
    first ??= { path: paths.get('5'), row: rows.get('5') };
    const getBounds = snapshot ? bboxXY : bounds;
    const visible = viewportFor(!!snapshot, base, changes, data.box);
    for (const id of visible) {
      const b = getBounds(paths.get(id));
      if (String(b) !== String(rows.get(id).bounds)) throw new Error('Geometry/metadata revision mismatch');
    }
    if (String(getBounds(first.path)) !== String(first.row.bounds)) throw new Error('Retained geometry changed');
    self.postMessage({ visible, request: data.request, revision: data.revision, generation: base.revision });
  } catch (e) { self.postMessage({ error: String(e.stack ?? e) }); }
};
