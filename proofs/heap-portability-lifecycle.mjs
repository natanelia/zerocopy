// Observing termination is independent of the browser shim's immediate return.
import assert from 'node:assert/strict';
export async function deadline(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), ms); })]); }
  finally { clearTimeout(timer); }
}
export function observeWorkers(page, receipts) {
  const closes = [];
  page.on('worker', worker => {
    const item = { url: worker.url(), closed: false }; receipts.push(item);
    // The promise and listener belong to this exact worker, installed on creation.
    closes.push(new Promise(resolve => worker.once('close', () => { item.closed = true; resolve(); })));
  });
  return {
    async waitForClose(expectedWorkers, timeoutMs, receipt) {
      assert.equal(closes.length, expectedWorkers, 'Unexpected browser worker count');
      assert.equal(receipts.length, expectedWorkers);
      Object.assign(receipt, { expectedWorkers, timeoutMs, completed: false });
      await deadline(Promise.all(closes), timeoutMs, 'Worker close');
      assert.equal(closes.length, expectedWorkers, 'Worker appeared during close barrier');
      assert.equal(receipts.length, expectedWorkers); assert(receipts.every(worker => worker.closed));
      receipt.completed = true;
    },
  };
}
export function validateBrowserLifecycle(raw, request, timeoutMs) {
  const expectedWorkers = request.kind === 'worker' ? 1 : 0;
  assert.equal(raw.status, 'completed');
  assert.equal(raw.browser.closeRequested, true); assert.equal(raw.browser.closeCompleted, true);
  assert.equal(raw.browser.disconnected, true); assert.equal(raw.serverClosed, true);
  assert.equal(raw.workers.length, expectedWorkers); assert(raw.workers.every(worker => worker.closed));
  assert.deepEqual(raw.workerCloseBarrier, { expectedWorkers, timeoutMs, completed: true });
}
