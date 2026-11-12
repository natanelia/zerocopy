import { connectSharedSession } from '../library/worker.js';

const IDS = ['headphones', 'keyboard', 'lamp'], HISTORY_LIMIT = 8;
try {
  const shared = await connectSharedSession({ copy: false, onError: error => self.postMessage({ type: 'error', message: error.message }) });
  const first = { snapshot: shared.current, version: shared.version };
  let pinned = first;
  const history = new Map([[first.version, first.snapshot]]);
  // Only these small display reports are cloned. Every collection lookup reads
  // the real shared snapshot locally in this dedicated worker.
  const products = snapshot => Object.fromEntries(IDS.map(id => [id, snapshot.catalog.get(id)]));
  function report() {
    const available = [...new Set([first.version, pinned.version, ...history.keys()])].sort((a, b) => a - b);
    self.postMessage({ type: 'snapshot', version: shared.version, products: products(shared.current),
      pinned: { version: pinned.version, products: products(pinned.snapshot) }, available });
  }
  shared.subscribe((snapshot, version) => {
    history.set(version, snapshot);
    while (history.size > HISTORY_LIMIT) history.delete(history.keys().next().value);
    report();
  });
  self.addEventListener('message', ({ data }) => {
    if (data?.type !== 'studio:pin' || !Number.isSafeInteger(data.version)) return;
    const snapshot = data.version === first.version ? first.snapshot : data.version === pinned.version ? pinned.snapshot : history.get(data.version);
    if (!snapshot) return;
    pinned = { snapshot, version: data.version }; report();
  });
  report();
} catch (error) { self.postMessage({ type: 'error', message: error.message }); }
