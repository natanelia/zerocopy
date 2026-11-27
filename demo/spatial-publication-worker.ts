import { bboxXY } from '../dist/geometry.js';
import { createSpatialQueryCursor, querySpatialIndex } from '../dist/spatial.js';
import { connectSharedSession } from '../dist/worker.js';

self.onmessage = async ({ data: { port, jobs, base } }) => {
  try {
    const reader = await connectSharedSession({ endpoint: port });
    try {
      const reads = jobs.map(job => reader.snapshotAt(job.version));
      self.postMessage({ waiting: true });
      // Read the captured publications only after the last edit has arrived.
      const snapshots = await Promise.all(reads);
      const cursor = createSpatialQueryCursor(base);
      const results = snapshots.map((snapshot, i) => {
        if (snapshot === undefined) return null;
        cursor.advance(snapshot.changes, jobs[i].version);
        const visible = cursor.search(jobs[i].viewport);
        if (String(visible) !== String(querySpatialIndex(base, jobs[i].viewport, snapshot.changes))) {
          throw new Error('Incremental and direct viewport searches disagree');
        }
        return { revision: snapshot.rows.get('lane'), bounds: bboxXY(snapshot.geometry), visible };
      });
      self.postMessage({ results });
    } finally { reader.dispose(); }
  } catch (error) { self.postMessage({ error: String(error) }); }
};
