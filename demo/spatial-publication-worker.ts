import { bboxXY } from '../dist/geometry.js';
import { querySpatialIndex } from '../dist/spatial.js';
import { connectSharedSession } from '../dist/worker.js';

self.onmessage = async ({ data: { port, jobs, base } }) => {
  try {
    const reader = await connectSharedSession({ endpoint: port });
    try {
      const reads = jobs.map(job => reader.snapshotAt(job.version));
      self.postMessage({ waiting: true });
      // Read the captured publications only after the last edit has arrived.
      const snapshots = await Promise.all(reads);
      const results = snapshots.map((snapshot, i) => snapshot === undefined ? null : {
        revision: snapshot.rows.get('lane'), bounds: bboxXY(snapshot.geometry),
        visible: querySpatialIndex(base, jobs[i].viewport, snapshot.changes),
      });
      self.postMessage({ results });
    } finally { reader.dispose(); }
  } catch (error) { self.postMessage({ error: String(error) }); }
};
