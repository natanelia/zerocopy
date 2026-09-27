import { connectSharedSession } from '../library/worker.js';
try {
  const shared = await connectSharedSession({ onError: error => self.postMessage({ type: 'error', message: error.message }) });
  const initial = shared.current;
  function report(snapshot, version) {
    // Every lookup here reads local shared memory. Only this display report is sent.
    const current = snapshot.limits.get('lane-1');
    const retained = initial.limits.get('lane-1');
    self.postMessage({ type: 'snapshot', current, retained, version });
  }
  report(initial, shared.version);
  shared.subscribe(report);
} catch (error) { self.postMessage({ type: 'error', message: error.message }); }
